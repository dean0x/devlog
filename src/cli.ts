#!/usr/bin/env node
/**
 * Devlog CLI
 *
 * Session-based knowledge consolidation for Claude Code projects.
 *
 * Usage:
 *   devlog setup         - Full setup (init + hooks + start daemon)
 *   devlog init          - Initialize global ~/.devlog directory only
 *   devlog daemon        - Start the global memory daemon
 *   devlog status        - Show daemon status (global + current project)
 *   devlog hooks         - Print hook configuration for Claude Code
 *   devlog knowledge     - View consolidated knowledge
 */

import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  readKnowledgeFile,
  searchKnowledge,
  getAllCategories,
  getCategoryTitle,
  updateIndex,
  type KnowledgeCategory,
  type KnowledgeStoreConfig,
} from './storage/knowledge-store.js';
import {
  listSessions,
  readSession,
  finalizeSession,
  type SessionStoreConfig,
} from './storage/session-store.js';
import {
  formatCatchUpSummary,
  formatCatchUpJson,
  generateLLMCatchUpSummary,
} from './catch-up/summarizer.js';
import {
  readRecentSummaries,
} from './catch-up/recent-sessions.js';
import { readPrecomputedSummary } from './catch-up/precomputed-store.js';
import type { SessionAccumulator } from './types/session.js';
import {
  getGlobalDir,
  getGlobalStatusPath,
  getGlobalConfigPath,
  getProjectMemoryDir,
  initGlobalDirs,
  isGlobalInitialized,
  readGlobalConfig,
  writeGlobalConfig,
} from './paths.js';
import { handlePostToolUse, handleStop } from './hooks/handlers.js';
import type { DaemonStatus } from './types/index.js';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

async function init(): Promise<void> {
  const globalDir = getGlobalDir();
  const isInitialized = await isGlobalInitialized();

  if (isInitialized) {
    console.log(`Devlog already initialized at ${globalDir}`);
    console.log('\nRun "devlog status" to check daemon status.');
    return;
  }

  console.log(`Initializing Devlog globally at ${globalDir}...`);

  // Initialize global directories
  const result = await initGlobalDirs();
  if (!result.ok) {
    console.error(`Failed to initialize: ${result.error.message}`);
    process.exit(1);
  }

  // Create default config
  const configResult = await readGlobalConfig();
  if (configResult.ok) {
    await writeGlobalConfig(configResult.value);
  }

  console.log('Created global directory structure');
  console.log('Created default configuration');
  console.log('\nNext steps:');
  console.log('  1. Run: devlog hooks');
  console.log('  2. Copy the hooks to ~/.claude/settings.json');
  console.log('  3. Start daemon: devlog daemon');
  console.log('\nThat\'s it! The daemon will auto-create .memory/ in each project as needed.');
}

// Hook command constants - stable CLI interface for Claude Code hooks
const HOOK_COMMAND_POST_TOOL_USE = 'devlog hook:post-tool-use';
const HOOK_COMMAND_STOP = 'devlog hook:stop';

function printHooks(): void {
  const config = {
    hooks: {
      PostToolUse: [{
        matcher: 'Edit|Write',
        hooks: [{
          type: 'command',
          command: HOOK_COMMAND_POST_TOOL_USE,
          timeout: 1000,
        }],
      }],
      Stop: [{
        matcher: {},
        hooks: [{
          type: 'command',
          command: HOOK_COMMAND_STOP,
          timeout: 30000,
        }],
      }],
    },
  };

  console.log('Add this to your ~/.claude/settings.json:\n');
  console.log(JSON.stringify(config, null, 2));
  console.log('\nNote: Merge with existing settings if you have other hooks configured.');
}

// ============================================================================
// Setup Helper Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const content = await fs.readFile(getGlobalStatusPath(), 'utf-8');
    const status = JSON.parse(content) as DaemonStatus;
    if (status.pid) {
      try {
        process.kill(status.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function promptUser(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

async function backupFile(filePath: string): Promise<string | null> {
  try {
    await fs.access(filePath);
    const timestamp = Date.now();
    const backupPath = `${filePath}.${timestamp}.bak`;
    await fs.copyFile(filePath, backupPath);
    return backupPath;
  } catch {
    return null; // File doesn't exist, no backup needed
  }
}

// ============================================================================
// Setup Command
// ============================================================================

interface SetupOptions {
  skipConfirmation?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<void> {
  const { skipConfirmation = false } = options;
  console.log('Setting up Devlog...\n');

  // 1. Initialize global dirs
  const initialized = await isGlobalInitialized();
  if (!initialized) {
    const result = await initGlobalDirs();
    if (!result.ok) {
      console.error(`Failed to initialize: ${result.error.message}`);
      process.exit(1);
    }
    console.log('✓ Created ~/.devlog/');
  } else {
    console.log('✓ ~/.devlog/ already exists');
  }

  // 2. Write default config if missing
  const configPath = getGlobalConfigPath();
  try {
    await fs.access(configPath);
    console.log('✓ Config file exists');
  } catch {
    const configResult = await readGlobalConfig();
    if (configResult.ok) {
      await writeGlobalConfig(configResult.value);
      console.log('✓ Created default config');
    }
  }

  // 3. Configure Claude Code hooks
  const claudeSettingsPath = join(homedir(), '.claude', 'settings.json');

  const postToolUseHook = {
    matcher: 'Edit|Write',
    hooks: [{
      type: 'command',
      command: HOOK_COMMAND_POST_TOOL_USE,
      timeout: 1000,
    }],
  };

  const stopHook = {
    matcher: {},
    hooks: [{
      type: 'command',
      command: HOOK_COMMAND_STOP,
      timeout: 30000,
    }],
  };

  try {
    let settings: Record<string, unknown> = {};
    let settingsExist = false;
    try {
      const content = await fs.readFile(claudeSettingsPath, 'utf-8');
      settings = JSON.parse(content) as Record<string, unknown>;
      settingsExist = true;
    } catch {
      // File doesn't exist, start fresh
    }

    // Get existing hooks or empty object
    const existingHooks = (settings['hooks'] ?? {}) as Record<string, unknown[]>;

    // Helper to check if our hook already exists in an array
    const hasDevlogHook = (hookArray: unknown[], command: string): boolean => {
      return hookArray.some((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const hooks = (entry as Record<string, unknown>)['hooks'];
        if (!Array.isArray(hooks)) return false;
        return hooks.some((h) => {
          if (typeof h !== 'object' || h === null) return false;
          const hookCommand = (h as Record<string, unknown>)['command'];
          if (typeof hookCommand !== 'string') return false;
          return hookCommand === command ||
            hookCommand.includes('devlog') && hookCommand.includes('hook:');
        });
      });
    };

    // Check if hooks are already installed
    const existingPostToolUse = Array.isArray(existingHooks['PostToolUse'])
      ? existingHooks['PostToolUse']
      : [];
    const existingStop = Array.isArray(existingHooks['Stop'])
      ? existingHooks['Stop']
      : [];

    const needsPostToolUse = !hasDevlogHook(existingPostToolUse, HOOK_COMMAND_POST_TOOL_USE);
    const needsStop = !hasDevlogHook(existingStop, HOOK_COMMAND_STOP);

    if (!needsPostToolUse && !needsStop) {
      console.log('✓ Claude Code hooks already configured');
    } else {
      // Show what exists
      if (settingsExist) {
        console.log(`\nFound existing ${claudeSettingsPath}`);
      }

      // Show what will be added
      console.log('\nWill add the following hooks:');
      if (needsPostToolUse) {
        console.log(`  PostToolUse (Edit|Write): ${HOOK_COMMAND_POST_TOOL_USE}`);
      }
      if (needsStop) {
        console.log(`  Stop: ${HOOK_COMMAND_STOP}`);
      }

      // Ask for confirmation (unless --yes flag is set)
      let confirmed = skipConfirmation;
      if (!skipConfirmation) {
        confirmed = await promptUser('\nProceed with hook configuration? [Y/n] ');
      }

      if (!confirmed) {
        console.log('\nSkipped hook configuration.');
        console.log('Run "devlog hooks" to see the configuration and add manually.');
      } else {
        // Create backup before modification
        const backupPath = await backupFile(claudeSettingsPath);
        if (backupPath) {
          console.log(`\nBackup created: ${backupPath}`);
        }

        // Merge hooks
        if (needsPostToolUse) {
          existingHooks['PostToolUse'] = [...existingPostToolUse, postToolUseHook];
        }
        if (needsStop) {
          existingHooks['Stop'] = [...existingStop, stopHook];
        }

        settings['hooks'] = existingHooks;

        await fs.mkdir(dirname(claudeSettingsPath), { recursive: true });
        await fs.writeFile(claudeSettingsPath, JSON.stringify(settings, null, 2));
        console.log('✓ Configured Claude Code hooks');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`⚠ Failed to configure hooks: ${message}`);
    console.log('  Run "devlog hooks" and add manually to ~/.claude/settings.json');
  }

  // 4. Start daemon (if not running)
  const daemonRunning = await isDaemonRunning();
  if (!daemonRunning) {
    spawn('node', [join(PROJECT_ROOT, 'dist', 'cli.js'), 'daemon'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    console.log('✓ Started daemon');
  } else {
    console.log('✓ Daemon already running');
  }

  // 5. Wait and verify
  await sleep(2000);
  console.log('\n✓ Setup complete!\n');
  console.log('Devlog is now running. Use Claude Code in any project:');
  console.log('  cd /any/project');
  console.log('  claude');
  console.log('\nView knowledge with:');
  console.log('  devlog knowledge');
}

async function runDaemon(): Promise<void> {
  // Import dynamically to avoid loading everything at startup
  const daemonPath = join(PROJECT_ROOT, 'dist', 'daemon', 'memoryd.js');

  // Dynamic import and run
  await import(daemonPath);
}

async function stopDaemon(): Promise<void> {
  const pidFile = join(homedir(), '.devlog', 'daemon.pid');

  try {
    const pidContent = await fs.readFile(pidFile, 'utf-8');
    const pid = parseInt(pidContent.trim(), 10);

    if (isNaN(pid)) {
      console.log('Invalid PID in daemon.pid file.');
      return;
    }

    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID ${pid})`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log('No daemon PID file found. Daemon may not be running.');
    } else if (err.code === 'ESRCH') {
      console.log('Daemon process not found. Cleaning up stale PID file.');
      await fs.unlink(pidFile).catch(() => {});
    } else {
      console.error('Failed to stop daemon:', error);
    }
  }
}

async function showStatus(): Promise<void> {
  const globalDir = getGlobalDir();
  const statusPath = getGlobalStatusPath();
  const currentProjectPath = process.cwd();
  const currentProjectMemoryDir = getProjectMemoryDir(currentProjectPath);

  console.log('=== Global Devlog Status ===\n');
  console.log(`Global directory: ${globalDir}`);

  // Check if initialized
  const initialized = await isGlobalInitialized();
  if (!initialized) {
    console.log('\nDevlog is not initialized. Run "devlog init" first.');
    return;
  }

  // Read daemon status
  try {
    const content = await fs.readFile(statusPath, 'utf-8');
    const status = JSON.parse(content) as DaemonStatus;

    console.log(`\nDaemon Status:`);
    console.log(`  Running: ${status.running}`);
    console.log(`  PID: ${status.pid ?? 'N/A'}`);
    console.log(`  Started: ${status.started_at ?? 'N/A'}`);
    console.log(`  Sessions processed: ${status.events_processed}`);
    console.log(`  Last consolidation: ${status.last_extraction ?? 'Never'}`);

    // Projects summary
    if (status.projects && Object.keys(status.projects).length > 0) {
      console.log(`\nKnown Projects (${Object.keys(status.projects).length}):`);
      for (const [path, stats] of Object.entries(status.projects)) {
        const isCurrent = path === currentProjectPath ? ' (current)' : '';
        console.log(`  ${path}${isCurrent}`);
        console.log(`    Sessions: ${stats.events_processed}, Knowledge updates: ${stats.memories_extracted}`);
      }
    }
  } catch {
    console.log('\nDaemon is not running.');
  }

  // Current project info
  console.log(`\n=== Current Project ===\n`);
  console.log(`Path: ${currentProjectPath}`);
  console.log(`Memory directory: ${currentProjectMemoryDir}`);

  try {
    await fs.access(join(currentProjectMemoryDir, 'knowledge'));
    console.log('Status: Initialized');

    // Count knowledge sections
    const knowledgeStoreConfig: KnowledgeStoreConfig = { memoryDir: currentProjectMemoryDir };
    let totalSections = 0;
    for (const category of getAllCategories()) {
      const result = await readKnowledgeFile(knowledgeStoreConfig, category);
      if (result.ok) {
        totalSections += result.value.sections.length;
      }
    }
    console.log(`Knowledge sections: ${totalSections}`);
  } catch {
    console.log('Status: Not initialized (will auto-create on first session)');
  }
}

async function showConfig(): Promise<void> {
  const configPath = getGlobalConfigPath();

  console.log(`Config file: ${configPath}\n`);

  const result = await readGlobalConfig();
  if (!result.ok) {
    console.error(`Failed to read config: ${result.error.message}`);
    process.exit(1);
  }

  console.log('Current configuration:');
  console.log(JSON.stringify(result.value, null, 2));
}

// ============================================================================
// Knowledge Commands
// ============================================================================

async function consolidate(): Promise<void> {
  const memoryDir = getProjectMemoryDir(process.cwd());
  const sessionStoreConfig: SessionStoreConfig = { memoryDir };

  console.log('Triggering session consolidation...\n');

  // List all active sessions
  const listResult = await listSessions(sessionStoreConfig);
  if (!listResult.ok) {
    console.error(`Failed to list sessions: ${listResult.error.message}`);
    return;
  }

  if (listResult.value.length === 0) {
    console.log('No active sessions found for this project.');
    console.log('\nSessions are automatically created when you use Claude Code with devlog hooks.');
    return;
  }

  console.log(`Found ${listResult.value.length} session(s):\n`);

  let finalized = 0;
  for (const sessionId of listResult.value) {
    console.log(`  - ${sessionId}`);

    // Finalize the session (mark for consolidation)
    const finalizeResult = await finalizeSession(sessionStoreConfig, sessionId);
    if (finalizeResult.ok) {
      finalized++;
    }
  }

  console.log(`\nFinalized ${finalized} session(s) for consolidation.`);
  console.log('The daemon will process them on its next cycle.');
  console.log('\nTo see results, run:');
  console.log('  devlog knowledge');
}

async function showKnowledge(category?: string): Promise<void> {
  const memoryDir = getProjectMemoryDir(process.cwd());
  const knowledgeStoreConfig: KnowledgeStoreConfig = { memoryDir };

  if (category) {
    // Show specific category
    const validCategories = getAllCategories();
    if (!validCategories.includes(category as KnowledgeCategory)) {
      console.error(`Invalid category: ${category}`);
      console.log(`Valid categories: ${validCategories.join(', ')}`);
      return;
    }

    const result = await readKnowledgeFile(knowledgeStoreConfig, category as KnowledgeCategory);
    if (!result.ok) {
      console.error(`Failed to read knowledge: ${result.error.message}`);
      return;
    }

    const file = result.value;
    console.log(`\n=== ${getCategoryTitle(category as KnowledgeCategory).toUpperCase()} ===\n`);

    if (file.sections.length === 0) {
      console.log('No knowledge sections yet in this category.');
      console.log('\nKnowledge is automatically created from your Claude Code sessions.');
      return;
    }

    for (const section of file.sections) {
      console.log(`[${section.id}] ${section.title}`);
      console.log(`  ${section.content.slice(0, 200)}${section.content.length > 200 ? '...' : ''}`);
      console.log(`  Confidence: ${section.confidence} | Observations: ${section.observations}`);
      if (section.related_files && section.related_files.length > 0) {
        console.log(`  Files: ${section.related_files.slice(0, 3).join(', ')}`);
      }
      console.log();
    }
  } else {
    // Show summary of all categories
    console.log('\n=== PROJECT KNOWLEDGE ===\n');

    const categories = getAllCategories();
    let totalSections = 0;

    for (const cat of categories) {
      const result = await readKnowledgeFile(knowledgeStoreConfig, cat);
      if (!result.ok) continue;

      const file = result.value;
      const title = getCategoryTitle(cat);

      console.log(`${title}: ${file.sections.length} section(s)`);
      totalSections += file.sections.length;

      // Show top 3 by observations
      const topSections = [...file.sections]
        .sort((a, b) => b.observations - a.observations)
        .slice(0, 3);

      for (const section of topSections) {
        console.log(`  - [${section.id}] ${section.title} (${section.confidence})`);
      }

      if (file.sections.length > 3) {
        console.log(`  ... and ${file.sections.length - 3} more`);
      }
      console.log();
    }

    if (totalSections === 0) {
      console.log('No knowledge yet. Knowledge is created from your Claude Code sessions.\n');
      console.log('Use Claude Code with devlog hooks enabled, then run:');
      console.log('  devlog consolidate\n');
    } else {
      console.log(`Total: ${totalSections} knowledge sections\n`);
      console.log('To view a specific category:');
      console.log('  devlog knowledge <category>');
      console.log(`\nCategories: ${categories.join(', ')}`);
    }

    // Update index
    await updateIndex(knowledgeStoreConfig);
  }
}

async function searchKnowledgeCommand(query: string): Promise<void> {
  if (!query) {
    console.error('Usage: devlog search <query>');
    return;
  }

  const memoryDir = getProjectMemoryDir(process.cwd());
  const knowledgeStoreConfig: KnowledgeStoreConfig = { memoryDir };

  console.log(`\nSearching for "${query}"...\n`);

  const result = await searchKnowledge(knowledgeStoreConfig, query);
  if (!result.ok) {
    console.error(`Search failed: ${result.error.message}`);
    return;
  }

  if (result.value.length === 0) {
    console.log('No matches found.');
    return;
  }

  console.log(`Found ${result.value.length} match(es):\n`);

  for (const match of result.value) {
    console.log(`[${match.category}/${match.section.id}] ${match.section.title}`);
    console.log(`  ${match.section.content.slice(0, 150)}...`);
    console.log(`  Confidence: ${match.section.confidence} | Observations: ${match.section.observations}`);
    console.log();
  }
}

// ============================================================================
// Catch-Up Command
// ============================================================================

interface CatchUpOptions {
  json: boolean;
  raw: boolean;
}

async function catchUp(options: CatchUpOptions): Promise<void> {
  const memoryDir = getProjectMemoryDir(process.cwd());
  const sessionStoreConfig: SessionStoreConfig = { memoryDir };

  // Get active sessions
  const listResult = await listSessions(sessionStoreConfig);
  if (!listResult.ok) {
    console.error(`Failed to list sessions: ${listResult.error.message}`);
    return;
  }

  const activeSessions: SessionAccumulator[] = [];
  for (const sessionId of listResult.value) {
    const readResult = await readSession(sessionStoreConfig, sessionId);
    if (readResult.ok && readResult.value !== null) {
      // Only include active sessions (not consolidating/closed)
      if (readResult.value.status === 'active') {
        activeSessions.push(readResult.value);
      }
    }
  }

  // Get recent session summaries
  const summariesResult = await readRecentSummaries({ memoryDir });
  const recentSummaries = summariesResult.ok ? summariesResult.value : [];

  // Filter to current project only
  const currentProjectPath = process.cwd();
  const projectSummaries = recentSummaries.filter(
    s => s.project_path === currentProjectPath
  );

  if (options.json) {
    const data = formatCatchUpJson(activeSessions, projectSummaries);
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (options.raw) {
    // Raw mode: show filtered signals without LLM
    const summary = formatCatchUpSummary(activeSessions, projectSummaries);
    console.log(summary);
    return;
  }

  // Default: try pre-computed summary first (instant!)
  const precomputed = await readPrecomputedSummary(memoryDir);

  if (precomputed.ok && precomputed.value) {
    console.log(precomputed.value.summary);

    // Show warnings if applicable
    if (precomputed.value.status === 'stale') {
      console.error('\n(Summary may be outdated - daemon will refresh soon)');
    }
    if (precomputed.value.last_error) {
      console.error(`\n(Last update failed: ${precomputed.value.last_error})`);
    }
    return;
  }

  // Fallback: No pre-computed summary (first run or daemon not running)
  // Generate on-demand (existing behavior)
  const configResult = await readGlobalConfig();
  const config = configResult.ok ? configResult.value : {
    ollama_base_url: 'http://localhost:11434',
    ollama_model: 'llama3.2',
  };

  const llmResult = await generateLLMCatchUpSummary(
    activeSessions,
    projectSummaries,
    memoryDir,
    {
      ollamaUrl: process.env['OLLAMA_BASE_URL'] ?? config.ollama_base_url,
      model: process.env['OLLAMA_MODEL'] ?? config.ollama_model,
    }
  );

  if (llmResult.ok) {
    console.log(llmResult.value.summary);
    if (llmResult.value.error) {
      console.error(`\n(Ollama unavailable: ${llmResult.value.error}, showing raw signals)`);
    }
  } else {
    // Should not happen since we always return Ok, but handle gracefully
    console.error(`Unexpected error: ${llmResult.error.message}`);
    const fallback = formatCatchUpSummary(activeSessions, projectSummaries);
    console.log(fallback);
  }
}

function printUsage(): void {
  console.log(`
Devlog - Session-based knowledge consolidation for Claude Code

Global daemon architecture - setup once, works everywhere.

Usage:
  devlog <command> [options]

Commands:
  setup [--yes]        Full setup (init + hooks + start daemon)
  init                 Initialize global ~/.devlog directory only
  daemon [start] [-d]  Start the global memory daemon (--debug for verbose)
  daemon stop          Stop the running daemon
  status               Show daemon status (global + current project)
  hooks                Print hook configuration for ~/.claude/settings.json
  config               Show current configuration

Knowledge Commands:
  consolidate          Force consolidation of active sessions
  knowledge [category] View knowledge files (conventions, architecture, decisions, gotchas)
  search <query>       Search across all knowledge
  catch-up [options]   Show what you were working on (for context restoration)
                       --raw   Show filtered signals without LLM summary
                       --json  Output as JSON

Hook Commands (internal, called by Claude Code):
  hook:post-tool-use  Handle PostToolUse events (file tracking)
  hook:stop           Handle Stop events (session signal accumulation)

Options:
  --yes, -y         Skip confirmation prompts (for setup command)

Environment Variables:
  OLLAMA_BASE_URL   Ollama server URL (default: from config or http://localhost:11434)
  OLLAMA_MODEL      Ollama model (default: from config or llama3.2)
  DEVLOG_HOME       Override global directory (default: ~/.devlog)
  DEVLOG_DEBUG      Enable debug logging (set to 1 or use --debug flag)

Quick Start:
  devlog setup             # One command does everything!

  # Use Claude Code in any project - knowledge auto-consolidates
  cd /any/project
  claude                   # Just works!

  # View this project's knowledge
  devlog knowledge
`);
}

// Main
const command = process.argv[2];

switch (command) {
  case 'setup':
    const setupArgs = process.argv.slice(3);
    const skipConfirmation = setupArgs.includes('--yes') || setupArgs.includes('-y');
    setup({ skipConfirmation });
    break;

  case 'init':
    init();
    break;

  case 'daemon': {
    const daemonArgs = process.argv.slice(3);
    const subcommand = daemonArgs.find(arg => ['start', 'stop'].includes(arg));
    const debugFlag = daemonArgs.includes('--debug') || daemonArgs.includes('-d');

    if (subcommand === 'stop') {
      stopDaemon();
    } else if (subcommand === 'start' || !subcommand || daemonArgs.length === 0 || (daemonArgs.length === 1 && debugFlag)) {
      // Set debug mode environment variable before running daemon
      if (debugFlag) {
        process.env['DEVLOG_DEBUG'] = '1';
      }
      runDaemon();
    } else {
      console.error(`Unknown daemon subcommand: ${subcommand}`);
      console.log('Usage: devlog daemon [start|stop] [--debug]');
      process.exit(1);
    }
    break;
  }

  case 'status':
    showStatus();
    break;

  case 'hooks':
    printHooks();
    break;

  case 'config':
    showConfig();
    break;

  // Knowledge commands
  case 'consolidate':
    consolidate();
    break;

  case 'knowledge':
    showKnowledge(process.argv[3]);
    break;

  case 'search':
    searchKnowledgeCommand(process.argv.slice(3).join(' '));
    break;

  case 'catch-up': {
    const catchUpArgs = process.argv.slice(3);
    const jsonFlag = catchUpArgs.includes('--json');
    const rawFlag = catchUpArgs.includes('--raw');
    catchUp({ json: jsonFlag, raw: rawFlag });
    break;
  }

  // Hook commands (called by Claude Code, not user-facing)
  case 'hook:post-tool-use':
    handlePostToolUse().then(() => {
      // Always exit cleanly - don't break Claude Code on errors
      process.exit(0);
    }).catch(() => {
      process.exit(0);
    });
    break;

  case 'hook:stop':
    handleStop().then(() => {
      // Always exit cleanly - don't break Claude Code on errors
      process.exit(0);
    }).catch(() => {
      process.exit(0);
    });
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printUsage();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
