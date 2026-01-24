#!/usr/bin/env node
/**
 * Memory Daemon (memoryd)
 *
 * ARCHITECTURE: Global background process that consolidates session knowledge
 * Pattern: Periodic polling for stale sessions, consolidation via LLM
 *
 * The daemon watches for stale sessions across all known projects and
 * consolidates them into the knowledge store (.memory/knowledge/).
 *
 * Responsibilities:
 *   1. Periodically check for stale sessions in known projects
 *   2. Consolidate session signals into structured knowledge
 *   3. Track per-project statistics
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================================
// Debug Logger
// ============================================================================

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

interface Logger {
  debug: (msg: string, data?: Record<string, unknown>) => void;
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  isDebug: () => boolean;
}

function createLogger(): Logger {
  const isDebugMode = process.env['DEVLOG_DEBUG'] === '1';

  function formatTime(): string {
    const now = new Date();
    return now.toTimeString().slice(0, 8);
  }

  function formatData(data?: Record<string, unknown>): string {
    if (!data) return '';
    const pairs = Object.entries(data).map(([k, v]) => {
      if (typeof v === 'string' && v.length > 80) {
        return `${k}="${v.slice(0, 77)}..."`;
      }
      return `${k}=${JSON.stringify(v)}`;
    });
    return pairs.length > 0 ? ` (${pairs.join(', ')})` : '';
  }

  function log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    // DEBUG only shows in debug mode
    if (level === 'DEBUG' && !isDebugMode) return;

    const timestamp = formatTime();
    const dataStr = formatData(data);
    console.log(`[${timestamp}] [${level}] ${msg}${dataStr}`);
  }

  return {
    debug: (msg, data) => log('DEBUG', msg, data),
    info: (msg, data) => log('INFO', msg, data),
    warn: (msg, data) => log('WARN', msg, data),
    error: (msg, data) => log('ERROR', msg, data),
    isDebug: () => isDebugMode,
  };
}

const logger = createLogger();

import {
  extractSessionKnowledge,
  type ExtractorConfig,
  type SessionConsolidationDecision,
} from './extractor.js';
import { generateSessionSummary } from '../catch-up/summarizer.js';
import {
  saveSessionSummary,
  pruneToLimit,
  readRecentSummaries,
  DEFAULT_CATCH_UP_CONFIG,
  type SessionStoreConfig as CatchUpSessionStoreConfig,
} from '../catch-up/recent-sessions.js';
import { generateLLMSummary, computeCacheHash } from '../catch-up/llm-summarizer.js';
import {
  readPrecomputedSummary,
  writePrecomputedSummary,
  readCatchUpState,
  clearCatchUpDirty,
  shouldRecomputeSummary,
} from '../catch-up/precomputed-store.js';
import {
  findStaleSessions,
  finalizeSession,
  archiveSession,
  findSessionsToConsolidate,
  listSessions,
  readSession,
  type SessionStoreConfig,
} from '../storage/session-store.js';
import {
  initKnowledgeStore,
  addSection,
  updateSection,
  confirmSection,
  createSection,
  updateIndex,
  readKnowledgeFile,
  findStaleKnowledge,
  applyConfidenceDecay,
  type KnowledgeStoreConfig,
  type KnowledgeCategory,
} from '../storage/knowledge-store.js';
import {
  getGlobalDir,
  getGlobalStatusPath,
  getProjectMemoryDir,
  initGlobalDirs,
  readGlobalConfig,
  readSessionConfig,
  consumePendingProjects,
} from '../paths.js';
import type { DaemonStatus, ProjectStats } from '../types/index.js';
import type { SessionConfig, SessionAccumulator } from '../types/session.js';
import { DEFAULT_SESSION_CONFIG } from '../types/session.js';

// ============================================================================
// PID File Management
// ============================================================================

function getPidFilePath(): string {
  return path.join(os.homedir(), '.devlog', 'daemon.pid');
}

// ============================================================================
// Configuration
// ============================================================================

interface SimpleDaemonConfig {
  readonly ollama_url: string;
  readonly ollama_model: string;
  readonly poll_interval_ms: number;
}

async function loadConfig(): Promise<SimpleDaemonConfig> {
  const globalConfig = await readGlobalConfig();
  const config = globalConfig.ok ? globalConfig.value : {
    ollama_base_url: 'http://localhost:11434',
    ollama_model: 'llama3.2',
  };

  return {
    ollama_url: process.env['OLLAMA_BASE_URL'] ?? config.ollama_base_url,
    ollama_model: process.env['OLLAMA_MODEL'] ?? config.ollama_model,
    poll_interval_ms: parseInt(process.env['POLL_INTERVAL'] ?? '5000', 10),
  };
}

// ============================================================================
// Daemon State
// ============================================================================

interface DaemonState {
  running: boolean;
  startedAt: Date;
  sessionsProcessed: number;
  lastConsolidation: Date | null;
  lastStalenessCheck: Date | null;
  projects: Map<string, ProjectStats>;
}

// Rate limit staleness checks to once per hour (staleness changes daily, not per-second)
const STALENESS_CHECK_INTERVAL_MS = 60 * 60 * 1000;

let state: DaemonState = {
  running: false,
  startedAt: new Date(),
  sessionsProcessed: 0,
  lastConsolidation: null,
  lastStalenessCheck: null,
  projects: new Map(),
};

async function writeStatus(): Promise<void> {
  const statusPath = getGlobalStatusPath();

  // Convert projects Map to plain object
  const projectsObj: { [path: string]: ProjectStats } = {};
  for (const [projectPath, stats] of state.projects) {
    projectsObj[projectPath] = stats;
  }

  const status: DaemonStatus = {
    running: state.running,
    pid: process.pid,
    started_at: state.startedAt.toISOString(),
    events_processed: state.sessionsProcessed,
    last_extraction: state.lastConsolidation?.toISOString(),
    projects: projectsObj,
  };

  try {
    await fs.writeFile(statusPath, JSON.stringify(status, null, 2));
  } catch {
    // Ignore status write errors
  }
}

function updateProjectStats(projectPath: string, sessionsProcessed: number): void {
  const existing = state.projects.get(projectPath);
  const updated: ProjectStats = {
    events_processed: (existing?.events_processed ?? 0) + sessionsProcessed,
    memories_extracted: (existing?.memories_extracted ?? 0) + sessionsProcessed,
    last_activity: new Date().toISOString(),
  };
  state.projects.set(projectPath, updated);
}

// ============================================================================
// Session Processing
// ============================================================================

/**
 * Check for stale sessions and trigger consolidation
 */
async function checkForStaleSessions(
  extractorConfig: ExtractorConfig
): Promise<void> {
  // Read session config
  const sessionConfigResult = await readSessionConfig();
  const sessionConfig: SessionConfig = sessionConfigResult.ok
    ? sessionConfigResult.value
    : DEFAULT_SESSION_CONFIG;

  // Get all known projects
  for (const projectPath of state.projects.keys()) {
    const memoryDir = getProjectMemoryDir(projectPath);
    const sessionStoreConfig: SessionStoreConfig = { memoryDir };

    // Find stale sessions
    const staleResult = await findStaleSessions(sessionStoreConfig, sessionConfig.timeout_ms);
    if (!staleResult.ok) {
      logger.warn(`Failed to check stale sessions for ${projectPath}`, {
        error: staleResult.error.message,
      });
      continue;
    }

    // Finalize each stale session
    for (const session of staleResult.value) {
      logger.info(`Found stale session for ${projectPath}`, {
        signals: session.signals.length,
        last_activity: session.last_activity,
      });

      const finalizeResult = await finalizeSession(sessionStoreConfig, session.session_id);
      if (!finalizeResult.ok) {
        logger.warn(`Failed to finalize session`, {
          project: projectPath,
          error: finalizeResult.error.message,
        });
      }
    }
  }

  // Process all sessions that need consolidation
  await processSessionConsolidations(extractorConfig);
}

/**
 * Process sessions that are ready for consolidation
 */
async function processSessionConsolidations(
  extractorConfig: ExtractorConfig
): Promise<void> {
  for (const projectPath of state.projects.keys()) {
    const memoryDir = getProjectMemoryDir(projectPath);
    const sessionStoreConfig: SessionStoreConfig = { memoryDir };
    const knowledgeStoreConfig: KnowledgeStoreConfig = { memoryDir };

    // Initialize knowledge store if needed
    await initKnowledgeStore(knowledgeStoreConfig);

    // Find sessions to consolidate
    const sessionsResult = await findSessionsToConsolidate(sessionStoreConfig);
    if (!sessionsResult.ok) {
      continue;
    }

    for (const session of sessionsResult.value) {
      logger.info(`Consolidating session`, {
        project: projectPath,
        signals: session.signals.length,
      });

      // Process the session
      const result = await processSessionConsolidation(
        session,
        knowledgeStoreConfig,
        extractorConfig
      );

      if (result.success) {
        // Save session summary for catch-up feature
        const catchUpConfig: CatchUpSessionStoreConfig = { memoryDir };
        const summary = generateSessionSummary(session);
        const saveResult = await saveSessionSummary(catchUpConfig, summary);
        if (!saveResult.ok) {
          logger.warn(`Failed to save session summary: ${saveResult.error.message}`);
        } else {
          // Prune old summaries to enforce retention limit
          await pruneToLimit(catchUpConfig, DEFAULT_CATCH_UP_CONFIG.max_sessions);
        }

        // Archive the session
        await archiveSession(sessionStoreConfig, session.session_id);

        // Update knowledge index if knowledge was modified
        if (result.knowledgeUpdated) {
          await updateIndex(knowledgeStoreConfig);
        }

        logger.info(`Session consolidated`, {
          project: projectPath,
          action: result.action,
          knowledge_updated: result.knowledgeUpdated,
        });

        updateProjectStats(projectPath, 1);
        state.sessionsProcessed++;
        state.lastConsolidation = new Date();
      } else {
        logger.warn(`Session consolidation failed`, {
          project: projectPath,
          error: result.error,
        });
      }
    }
  }
}

/**
 * Process a single session's consolidation
 */
async function processSessionConsolidation(
  session: SessionAccumulator,
  knowledgeStoreConfig: KnowledgeStoreConfig,
  extractorConfig: ExtractorConfig
): Promise<{
  success: boolean;
  action?: string;
  knowledgeUpdated?: boolean;
  error?: string;
}> {
  // Always call LLM - it handles skip/confirm/create decisions
  // The LLM prompt already covers all semantic decisions that the old gates
  // tried to handle with brittle heuristics (word similarity, length thresholds)
  const extractResult = await extractSessionKnowledge(
    session,
    knowledgeStoreConfig,
    extractorConfig
  );

  if (!extractResult.ok) {
    return { success: false, error: extractResult.error.message };
  }

  return await applyConsolidationDecision(extractResult.value, knowledgeStoreConfig);
}

/**
 * Apply a consolidation decision to the knowledge store
 */
async function applyConsolidationDecision(
  decision: SessionConsolidationDecision,
  knowledgeStoreConfig: KnowledgeStoreConfig
): Promise<{
  success: boolean;
  action: string;
  knowledgeUpdated: boolean;
  error?: string;
}> {
  switch (decision.action) {
    case 'skip':
      return { success: true, action: 'skip', knowledgeUpdated: false };

    case 'create_section':
      if (!decision.category || !decision.new_section) {
        return { success: false, action: 'create_section', knowledgeUpdated: false, error: 'Missing category or new_section' };
      }
      const newSection = createSection(
        decision.new_section.title,
        decision.new_section.content,
        {
          tags: decision.new_section.tags,
          examples: decision.new_section.examples,
        }
      );
      const addResult = await addSection(knowledgeStoreConfig, decision.category, newSection);
      if (!addResult.ok) {
        return { success: false, action: 'create_section', knowledgeUpdated: false, error: addResult.error.message };
      }
      return { success: true, action: 'create_section', knowledgeUpdated: true };

    case 'extend_section': {
      if (!decision.category || !decision.section_id || !decision.extension) {
        return { success: false, action: 'extend_section', knowledgeUpdated: false, error: 'Missing required fields' };
      }
      // Read existing section to append content
      const extendFileResult = await readKnowledgeFile(
        knowledgeStoreConfig,
        decision.category as KnowledgeCategory
      );
      if (!extendFileResult.ok) {
        return { success: false, action: 'extend_section', knowledgeUpdated: false, error: extendFileResult.error.message };
      }
      const existingSection = extendFileResult.value.sections.find(s => s.id === decision.section_id);
      const existingContent = existingSection?.content ?? '';
      const appendedContent = existingContent
        ? `${existingContent}\n\n${decision.extension.additional_content}`
        : decision.extension.additional_content;

      const extendResult = await updateSection(
        knowledgeStoreConfig,
        decision.category as KnowledgeCategory,
        decision.section_id,
        { content: appendedContent }
      );
      if (!extendResult.ok) {
        return { success: false, action: 'extend_section', knowledgeUpdated: false, error: extendResult.error.message };
      }
      return { success: true, action: 'extend_section', knowledgeUpdated: true };
    }

    case 'add_example': {
      if (!decision.category || !decision.section_id || !decision.extension?.new_examples) {
        return { success: false, action: 'add_example', knowledgeUpdated: false, error: 'Missing required fields' };
      }
      // Read existing section to append examples
      const exampleFileResult = await readKnowledgeFile(
        knowledgeStoreConfig,
        decision.category as KnowledgeCategory
      );
      if (!exampleFileResult.ok) {
        return { success: false, action: 'add_example', knowledgeUpdated: false, error: exampleFileResult.error.message };
      }
      const existingSectionForExample = exampleFileResult.value.sections.find(s => s.id === decision.section_id);
      const existingExamples = existingSectionForExample?.examples ?? [];
      const combinedExamples = [...existingExamples, ...decision.extension.new_examples];

      const exampleResult = await updateSection(
        knowledgeStoreConfig,
        decision.category as KnowledgeCategory,
        decision.section_id,
        { examples: combinedExamples }
      );
      if (!exampleResult.ok) {
        return { success: false, action: 'add_example', knowledgeUpdated: false, error: exampleResult.error.message };
      }
      return { success: true, action: 'add_example', knowledgeUpdated: true };
    }

    case 'confirm_pattern':
      if (decision.category && decision.section_id) {
        await confirmSection(knowledgeStoreConfig, decision.category, decision.section_id);
      }
      return { success: true, action: 'confirm_pattern', knowledgeUpdated: true };

    case 'flag_contradiction':
      // Log the contradiction but don't automatically resolve
      logger.warn('Knowledge contradiction flagged', {
        category: decision.category,
        section_id: decision.section_id,
        reasoning: decision.reasoning,
      });
      return { success: true, action: 'flag_contradiction', knowledgeUpdated: false };

    default:
      return { success: true, action: 'unknown', knowledgeUpdated: false };
  }
}

// ============================================================================
// Knowledge Staleness Checking
// ============================================================================

/**
 * Check for stale knowledge and apply confidence decay
 *
 * ARCHITECTURE: Periodic decay check following existing daemon job patterns
 * Pattern: Iterates all projects, finds stale knowledge, applies decay
 *
 * Decay rules:
 *   - canonical -> NEVER decays (hardcoded invariant)
 *   - established + 30 days -> tentative
 *   - developing + 30 days -> tentative
 *   - tentative + 90 days -> flagged for review
 *
 * Rate limiting: Only runs once per hour since staleness changes daily
 */
async function checkForStaleKnowledge(): Promise<void> {
  // Rate limit: only check once per hour (staleness changes daily, not every 5s)
  if (state.lastStalenessCheck) {
    const elapsed = Date.now() - state.lastStalenessCheck.getTime();
    if (elapsed < STALENESS_CHECK_INTERVAL_MS) {
      return;
    }
  }
  state.lastStalenessCheck = new Date();

  for (const projectPath of state.projects.keys()) {
    const memoryDir = getProjectMemoryDir(projectPath);
    const knowledgeStoreConfig: KnowledgeStoreConfig = { memoryDir };

    // Find stale knowledge sections
    const staleResult = await findStaleKnowledge(knowledgeStoreConfig);
    if (!staleResult.ok) {
      logger.warn('Failed to check stale knowledge', {
        project: projectPath,
        error: staleResult.error.message,
      });
      continue;
    }

    if (staleResult.value.length === 0) {
      continue; // No stale knowledge in this project
    }

    logger.debug('Found stale knowledge', {
      project: projectPath,
      count: staleResult.value.length,
    });

    // Apply decay to each stale section
    for (const staleSection of staleResult.value) {
      const decayResult = await applyConfidenceDecay(knowledgeStoreConfig, staleSection);

      if (!decayResult.ok) {
        logger.warn('Failed to apply confidence decay', {
          project: projectPath,
          section: staleSection.section.id,
          error: decayResult.error.message,
        });
        continue;
      }

      const result = decayResult.value;

      // Log decay events
      if (result.action === 'decayed') {
        logger.info('Decayed knowledge confidence', {
          project: projectPath,
          section_id: result.sectionId,
          category: result.category,
          from: result.previousConfidence,
          to: result.newConfidence,
          days_stale: result.daysSinceConfirmed,
        });
      } else if (result.action === 'flagged_for_review') {
        logger.info('Flagged knowledge for review', {
          project: projectPath,
          section_id: result.sectionId,
          category: result.category,
          confidence: staleSection.section.confidence,
          days_stale: result.daysSinceConfirmed,
        });
      }
    }

    // Update index if we made any changes
    const hadChanges = staleResult.value.some(
      s => s.eligibleForDecay && s.section.confidence !== 'tentative'
    );
    if (hadChanges) {
      await updateIndex(knowledgeStoreConfig);
    }
  }
}

// ============================================================================
// Catch-Up Summary Pre-Computation
// ============================================================================

/**
 * Get active sessions for a project
 */
async function getActiveSessionsForProject(
  memoryDir: string
): Promise<readonly import('../types/session.js').SessionAccumulator[]> {
  const sessionStoreConfig: SessionStoreConfig = { memoryDir };

  const listResult = await listSessions(sessionStoreConfig);
  if (!listResult.ok) {
    return [];
  }

  const activeSessions: import('../types/session.js').SessionAccumulator[] = [];
  for (const sessionId of listResult.value) {
    const readResult = await readSession(sessionStoreConfig, sessionId);
    if (readResult.ok && readResult.value !== null && readResult.value.status === 'active') {
      activeSessions.push(readResult.value);
    }
  }

  return activeSessions;
}

/**
 * Update pre-computed catch-up summaries for all known projects
 *
 * ARCHITECTURE: Background computation with debouncing
 * - Only recomputes when dirty flag is set and debounce period has elapsed
 * - Stores result for instant retrieval by CLI
 */
async function updateCatchUpSummariesIfNeeded(
  extractorConfig: ExtractorConfig
): Promise<void> {
  for (const projectPath of state.projects.keys()) {
    const memoryDir = getProjectMemoryDir(projectPath);

    // Check if recomputation is needed
    const catchUpStateResult = await readCatchUpState(memoryDir);
    const currentSummaryResult = await readPrecomputedSummary(memoryDir);

    const catchUpState = catchUpStateResult.ok ? catchUpStateResult.value : null;
    const currentSummary = currentSummaryResult.ok ? currentSummaryResult.value : null;

    if (!shouldRecomputeSummary(catchUpState, currentSummary)) {
      continue;
    }

    logger.debug('Recomputing catch-up summary', { project: projectPath });

    // Get active sessions and recent summaries
    const [activeSessions, recentSummariesResult] = await Promise.all([
      getActiveSessionsForProject(memoryDir),
      readRecentSummaries({ memoryDir }),
    ]);

    const recentSummaries = recentSummariesResult.ok ? recentSummariesResult.value : [];

    // Filter to current project only
    const projectSummaries = recentSummaries.filter(s => s.project_path === projectPath);

    // Generate summary using LLM
    const result = await generateLLMSummary(
      activeSessions,
      projectSummaries,
      memoryDir,
      {
        ollamaUrl: extractorConfig.ollamaUrl,
        model: extractorConfig.model,
        timeout: 30000, // 30s timeout for catch-up summarization
      }
    );

    if (result.ok) {
      // Compute hash for cache validation
      const sourceHash = computeCacheHash(activeSessions, projectSummaries);

      await writePrecomputedSummary(memoryDir, {
        source_hash: sourceHash,
        summary: result.value.summary,
        generated_at: new Date().toISOString(),
        status: 'fresh',
      });
      await clearCatchUpDirty(memoryDir);

      logger.info('Updated catch-up summary', {
        project: projectPath,
        fromCache: result.value.fromCache,
      });
    } else {
      // Record error, mark as stale if we have a previous summary
      if (currentSummary) {
        await writePrecomputedSummary(memoryDir, {
          ...currentSummary,
          status: 'stale',
          last_error: result.error.message,
        });
      }

      logger.warn('Failed to update catch-up summary', {
        project: projectPath,
        error: result.error.message,
      });
    }
  }
}

// ============================================================================
// Project Discovery
// ============================================================================

/**
 * Discover new projects registered by hooks
 */
async function discoverNewProjects(): Promise<void> {
  const pendingResult = await consumePendingProjects();
  if (!pendingResult.ok) {
    logger.warn('Failed to read pending projects', { error: pendingResult.error.message });
    return;
  }

  for (const projectPath of pendingResult.value) {
    if (state.projects.has(projectPath)) {
      continue; // Already known
    }

    // Verify the project has a .memory/working directory
    const memoryDir = getProjectMemoryDir(projectPath);
    try {
      await fs.access(path.join(memoryDir, 'working'));
      state.projects.set(projectPath, {
        events_processed: 0,
        memories_extracted: 0,
        last_activity: new Date().toISOString(),
      });
      logger.info(`Discovered new project: ${projectPath}`);
    } catch {
      logger.debug(`Ignoring project without .memory/working: ${projectPath}`);
    }
  }
}

// ============================================================================
// Main Event Loop
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function processLoop(config: SimpleDaemonConfig): Promise<void> {
  const extractorConfig: ExtractorConfig = {
    ollamaUrl: config.ollama_url,
    model: config.ollama_model,
    timeout: 60000,
  };

  logger.info('Starting session consolidation loop...');

  while (state.running) {
    try {
      // Discover any new projects registered by hooks
      await discoverNewProjects();

      // Check for stale sessions across all known projects
      await checkForStaleSessions(extractorConfig);

      // Check for stale knowledge and apply confidence decay
      await checkForStaleKnowledge();

      // Update pre-computed catch-up summaries (background task)
      await updateCatchUpSummariesIfNeeded(extractorConfig);
    } catch (error) {
      logger.error('Error in consolidation loop', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Update status
    await writeStatus();

    // Wait before next poll
    await sleep(config.poll_interval_ms);
  }
}

// ============================================================================
// Lifecycle Management
// ============================================================================

async function startup(config: SimpleDaemonConfig): Promise<void> {
  logger.info('Initializing session consolidation daemon...');
  logger.info(`Global dir: ${getGlobalDir()}`);
  logger.info(`Ollama URL: ${config.ollama_url}`);
  logger.info(`Ollama model: ${config.ollama_model}`);
  logger.debug('Config details', { poll_interval: config.poll_interval_ms });
  if (logger.isDebug()) {
    logger.info('Debug mode enabled - verbose logging active');
  }

  // Initialize global directories
  const globalInitResult = await initGlobalDirs();
  if (!globalInitResult.ok) {
    throw new Error(`Failed to initialize global directories: ${globalInitResult.error.message}`);
  }

  // Write PID file for daemon management
  const pidFile = getPidFilePath();
  await fs.writeFile(pidFile, process.pid.toString());
  logger.debug(`PID file written: ${pidFile}`);

  // Load existing projects from status file (if any)
  const loadedProjects = await loadProjectsFromStatus();

  state = {
    running: true,
    startedAt: new Date(),
    sessionsProcessed: 0,
    lastConsolidation: null,
    lastStalenessCheck: null,
    projects: loadedProjects,
  };

  if (loadedProjects.size > 0) {
    logger.info(`Restored ${loadedProjects.size} project(s) from previous session`);
  }

  await writeStatus();
}

/**
 * Load projects from existing status file (if daemon was restarted)
 */
async function loadProjectsFromStatus(): Promise<Map<string, ProjectStats>> {
  const projects = new Map<string, ProjectStats>();
  const statusPath = getGlobalStatusPath();

  try {
    const content = await fs.readFile(statusPath, 'utf-8');
    const status = JSON.parse(content) as DaemonStatus;

    if (status.projects) {
      for (const [projectPath, stats] of Object.entries(status.projects)) {
        // Verify the project still has a .memory directory
        const memoryDir = getProjectMemoryDir(projectPath);
        try {
          await fs.access(path.join(memoryDir, 'working'));
          projects.set(projectPath, stats);
          logger.debug(`Restored project: ${projectPath}`);
        } catch {
          logger.debug(`Skipping stale project (no .memory): ${projectPath}`);
        }
      }
    }
  } catch {
    // No status file or invalid - start fresh
  }

  return projects;
}

async function shutdown(): Promise<void> {
  logger.info('Shutting down daemon...');
  state.running = false;
  await writeStatus();

  // Remove PID file
  const pidFile = getPidFilePath();
  await fs.unlink(pidFile).catch(() => {
    // Ignore errors if file doesn't exist
  });

  logger.info('Daemon stopped.');
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const config = await loadConfig();

  // Handle signals
  process.on('SIGINT', () => {
    shutdown().then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown().then(() => process.exit(0));
  });

  try {
    await startup(config);
    logger.info('Session consolidation daemon running. Press Ctrl+C to stop.');
    await processLoop(config);
  } catch (error) {
    // Print full stack trace for debugging
    if (error instanceof Error && error.stack) {
      console.error('\n=== DAEMON ERROR ===');
      console.error(error.stack);
      console.error('====================\n');
    }
    logger.error('Daemon error', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// ============================================================================
// CLI Commands
// ============================================================================

async function showStatus(): Promise<void> {
  const statusPath = getGlobalStatusPath();

  try {
    const content = await fs.readFile(statusPath, 'utf-8');
    const status = JSON.parse(content) as DaemonStatus;

    console.log('Session Consolidation Daemon Status:');
    console.log(`  Running: ${status.running}`);
    console.log(`  PID: ${status.pid ?? 'N/A'}`);
    console.log(`  Started: ${status.started_at ?? 'N/A'}`);
    console.log(`  Sessions processed: ${status.events_processed}`);
    console.log(`  Last consolidation: ${status.last_extraction ?? 'Never'}`);

    if (status.projects && Object.keys(status.projects).length > 0) {
      console.log('\n  Projects:');
      for (const [projectPath, stats] of Object.entries(status.projects)) {
        console.log(`    ${projectPath}:`);
        console.log(`      Sessions: ${stats.events_processed}, Knowledge updates: ${stats.memories_extracted}`);
        if (stats.last_activity) {
          console.log(`      Last activity: ${stats.last_activity}`);
        }
      }
    }
  } catch {
    console.log('Daemon is not running or status file not found.');
    console.log(`Expected status file at: ${statusPath}`);
  }
}

// Determine command - handle both direct invocation and via cli.js
const args = process.argv.slice(2);
const command = args.find(arg => ['start', 'status'].includes(arg)) ?? (args.length === 0 ? undefined : 'start');

switch (command) {
  case 'start':
  case undefined:
    main().catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
    break;

  case 'status':
    showStatus();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.log('Usage: memoryd [start|status]');
    process.exit(1);
}
