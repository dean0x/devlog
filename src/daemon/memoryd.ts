#!/usr/bin/env node
/**
 * Memory Daemon (memoryd)
 *
 * ARCHITECTURE: Global background process that extracts and manages memories
 * Pattern: Event loop with graceful shutdown, multi-project routing
 *
 * Global daemon watches ~/.devlog/queue and routes memories to the
 * appropriate project's .memory/ directory based on event.project_path.
 *
 * Responsibilities:
 *   1. Watch global queue for new events
 *   2. Group events by project_path
 *   3. Extract memories per project
 *   4. Auto-init project .memory/ directories
 *   5. Store memories in correct project
 *   6. Run scheduled decay jobs per project
 *   7. Track per-project statistics
 */

import { promises as fs } from 'node:fs';
import { watchQueue, completeBatch, failBatch, type WatcherConfig } from './watcher.js';
import { extractMemoWithContext, memoToMemoryEntry, type ExtractorConfig } from './extractor.js';
import { runDecay } from './decay.js';
import { evaluateForPromotion, cleanupStaleCandidates, type PromotionConfig } from './promotion.js';
import { initQueue } from '../storage/queue.js';
import {
  appendToShortTermMemory,
  updateMemoryEntry,
  type MemoryStoreConfig,
} from '../storage/memory-store.js';
import {
  getGlobalDir,
  getGlobalQueueDir,
  getGlobalStatusPath,
  getProjectMemoryDir,
  initGlobalDirs,
  initProjectMemory,
  isProjectMemoryInitialized,
  readGlobalConfig,
} from '../paths.js';
import type { DaemonConfig, DaemonStatus, QueuedEvent, ProjectStats } from '../types/index.js';

// ============================================================================
// Configuration
// ============================================================================

async function loadConfig(): Promise<DaemonConfig> {
  const globalConfig = await readGlobalConfig();
  const config = globalConfig.ok ? globalConfig.value : {
    ollama_base_url: 'http://localhost:11434',
    ollama_model: 'llama3.2',
    proxy_port: 8082,
  };

  return {
    proxy_url: process.env['PROXY_URL'] ?? `http://localhost:${config.proxy_port}`,
    ollama_model: process.env['OLLAMA_MODEL'] ?? config.ollama_model,
    memory_dir: getGlobalDir(), // Used for global status
    queue_dir: getGlobalQueueDir(),
    batch_size: parseInt(process.env['BATCH_SIZE'] ?? '5', 10),
    poll_interval_ms: parseInt(process.env['POLL_INTERVAL'] ?? '5000', 10),
    decay_schedule: {
      daily_hour: 2, // 2 AM
      weekly_day: 1, // Monday
      monthly_day: 1, // 1st of month
    },
  };
}

// ============================================================================
// Daemon State
// ============================================================================

interface DaemonState {
  running: boolean;
  startedAt: Date;
  eventsProcessed: number;
  lastExtraction: Date | null;
  lastDecay: Date | null;
  projects: Map<string, ProjectStats>;
}

let state: DaemonState = {
  running: false,
  startedAt: new Date(),
  eventsProcessed: 0,
  lastExtraction: null,
  lastDecay: null,
  projects: new Map(),
};

async function writeStatus(): Promise<void> {
  const statusPath = getGlobalStatusPath();

  // Convert projects Map to plain object
  const projectsObj: { [path: string]: ProjectStats } = {};
  for (const [path, stats] of state.projects) {
    projectsObj[path] = stats;
  }

  const status: DaemonStatus = {
    running: state.running,
    pid: process.pid,
    started_at: state.startedAt.toISOString(),
    events_processed: state.eventsProcessed,
    last_extraction: state.lastExtraction?.toISOString(),
    last_decay: state.lastDecay?.toISOString(),
    projects: projectsObj,
  };

  try {
    await fs.writeFile(statusPath, JSON.stringify(status, null, 2));
  } catch {
    // Ignore status write errors
  }
}

function updateProjectStats(projectPath: string, eventsProcessed: number, memoriesExtracted: number): void {
  const existing = state.projects.get(projectPath);
  const updated: ProjectStats = {
    events_processed: (existing?.events_processed ?? 0) + eventsProcessed,
    memories_extracted: (existing?.memories_extracted ?? 0) + memoriesExtracted,
    last_activity: new Date().toISOString(),
  };
  state.projects.set(projectPath, updated);
}

// ============================================================================
// Scheduled Jobs
// ============================================================================

function shouldRunDecay(config: DaemonConfig): boolean {
  const now = new Date();
  const hour = now.getHours();

  // Run decay at configured hour, once per day
  if (hour !== config.decay_schedule.daily_hour) {
    return false;
  }

  // Check if we already ran today
  if (state.lastDecay) {
    const lastDecayDate = state.lastDecay.toDateString();
    const todayDate = now.toDateString();
    if (lastDecayDate === todayDate) {
      return false;
    }
  }

  return true;
}

async function runScheduledDecayForAllProjects(_config: DaemonConfig): Promise<void> {
  console.log('Running scheduled decay for all projects...');

  // Run decay for each known project
  for (const projectPath of state.projects.keys()) {
    const memoryDir = getProjectMemoryDir(projectPath);

    const result = await runDecay(memoryDir);
    if (result.ok) {
      console.log(
        `  ${projectPath}: daily(moved=${result.value.daily.moved}, filtered=${result.value.daily.filtered}), ` +
        `weekly(moved=${result.value.weekly.moved}, filtered=${result.value.weekly.filtered}), ` +
        `monthly(archived=${result.value.monthly.archived})`
      );
    } else {
      console.error(`  ${projectPath}: Decay failed - ${result.error.message}`);
    }

    // Also cleanup stale candidates
    const promotionConfig: PromotionConfig = {
      memoryDir,
      minOccurrences: 3,
      minAverageConfidence: 0.85,
      minDaySpread: 3,
    };

    const cleanupResult = await cleanupStaleCandidates(promotionConfig);
    if (cleanupResult.ok && cleanupResult.value.removed > 0) {
      console.log(`  ${projectPath}: Cleaned up ${cleanupResult.value.removed} stale promotion candidates`);
    }
  }

  state.lastDecay = new Date();
}

// ============================================================================
// Multi-Project Event Processing
// ============================================================================

/**
 * Group events by their project_path
 */
function groupEventsByProject(events: readonly QueuedEvent[]): Map<string, QueuedEvent[]> {
  const grouped = new Map<string, QueuedEvent[]>();

  for (const event of events) {
    const projectPath = event.project_path;
    const existing = grouped.get(projectPath);
    if (existing) {
      existing.push(event);
    } else {
      grouped.set(projectPath, [event]);
    }
  }

  return grouped;
}

/**
 * Process events for a single project using context-aware extraction
 *
 * ARCHITECTURE: Uses new extractMemoWithContext for smarter decisions
 * Pattern: create/update/skip based on existing context
 */
async function processProjectEvents(
  projectPath: string,
  events: readonly QueuedEvent[],
  extractorConfig: ExtractorConfig
): Promise<{ success: boolean; memoriesExtracted: number; memoriesUpdated: number; error?: string }> {
  const memoryDir = getProjectMemoryDir(projectPath);

  // Auto-init project memory if needed
  const initialized = await isProjectMemoryInitialized(projectPath);
  if (!initialized) {
    console.log(`  Auto-initializing memory for project: ${projectPath}`);
    const initResult = await initProjectMemory(projectPath);
    if (!initResult.ok) {
      return { success: false, memoriesExtracted: 0, memoriesUpdated: 0, error: initResult.error.message };
    }
  }

  const storeConfig: MemoryStoreConfig = { baseDir: memoryDir };
  const promotionConfig: PromotionConfig = {
    memoryDir,
    minOccurrences: 3,
    minAverageConfidence: 0.85,
    minDaySpread: 3,
  };

  let memoriesExtracted = 0;
  let memoriesUpdated = 0;

  // Process each event with context-aware extraction
  for (const event of events) {
    const decision = await extractMemoWithContext(event, memoryDir, extractorConfig);

    if (!decision.ok) {
      console.warn(`  ${projectPath}: Extraction failed for event ${event.id}: ${decision.error.message}`);
      continue;
    }

    const { action, memo, updateTarget, updateFields, reasoning } = decision.value;

    switch (action) {
      case 'create':
        if (memo) {
          const memoryEntry = memoToMemoryEntry(memo);
          const storeResult = await appendToShortTermMemory(storeConfig, 'today', [memoryEntry]);
          if (storeResult.ok) {
            memoriesExtracted++;
            console.log(`  ${projectPath}: Created memo: ${memo.title}`);

            // Evaluate for promotion
            const promoResult = await evaluateForPromotion([memoryEntry], promotionConfig);
            if (promoResult.ok && promoResult.value.promoted > 0) {
              console.log(`  ${projectPath}: Promoted to long-term storage`);
            }
          } else {
            console.warn(`  ${projectPath}: Failed to store memo: ${storeResult.error.message}`);
          }
        }
        break;

      case 'update':
        if (updateTarget && updateFields) {
          const updateResult = await updateMemoryEntry(
            storeConfig,
            'today',
            updateTarget,
            updateFields
          );
          if (updateResult.ok) {
            memoriesUpdated++;
            console.log(`  ${projectPath}: Updated memo ${updateTarget}`);
          } else {
            // If today fails, try this-week
            const weekResult = await updateMemoryEntry(
              storeConfig,
              'this-week',
              updateTarget,
              updateFields
            );
            if (weekResult.ok) {
              memoriesUpdated++;
              console.log(`  ${projectPath}: Updated memo ${updateTarget} (this-week)`);
            } else {
              console.warn(`  ${projectPath}: Failed to update memo ${updateTarget}: ${updateResult.error.message}`);
            }
          }
        }
        break;

      case 'skip':
        console.log(`  ${projectPath}: Skipped - ${reasoning}`);
        break;
    }
  }

  return { success: true, memoriesExtracted, memoriesUpdated };
}

// ============================================================================
// Main Event Loop
// ============================================================================

async function processEvents(config: DaemonConfig): Promise<void> {
  const watcherConfig: WatcherConfig = {
    queueDir: config.queue_dir,
    batchSize: config.batch_size,
    pollIntervalMs: config.poll_interval_ms,
  };

  const extractorConfig: ExtractorConfig = {
    proxyUrl: config.proxy_url,
    timeout: 60000,
  };

  console.log('Starting event processor...');

  for await (const batchResult of watchQueue(watcherConfig)) {
    if (!state.running) {
      break;
    }

    // Check for scheduled decay
    if (shouldRunDecay(config)) {
      await runScheduledDecayForAllProjects(config);
    }

    if (!batchResult.ok) {
      console.error('Queue error:', batchResult.error.message);
      continue;
    }

    const { events, filenames } = batchResult.value;
    console.log(`Processing batch of ${events.length} events...`);

    // Group events by project
    const eventsByProject = groupEventsByProject(events);
    let allSucceeded = true;
    let totalCreated = 0;
    let totalUpdated = 0;

    for (const [projectPath, projectEvents] of eventsByProject) {
      console.log(`  Processing ${projectEvents.length} events for: ${projectPath}`);

      const result = await processProjectEvents(projectPath, projectEvents, extractorConfig);

      if (result.success) {
        updateProjectStats(projectPath, projectEvents.length, result.memoriesExtracted);
        totalCreated += result.memoriesExtracted;
        totalUpdated += result.memoriesUpdated;
        if (result.memoriesExtracted > 0 || result.memoriesUpdated > 0) {
          console.log(
            `  ${projectPath}: Created ${result.memoriesExtracted}, Updated ${result.memoriesUpdated}`
          );
        }
      } else {
        console.error(`  ${projectPath}: Failed - ${result.error}`);
        allSucceeded = false;
      }
    }

    if (allSucceeded) {
      // Mark batch as complete
      await completeBatch(filenames, watcherConfig);
      state.eventsProcessed += events.length;

      if (totalCreated > 0 || totalUpdated > 0) {
        state.lastExtraction = new Date();
      }
    } else {
      // Mark batch as failed
      await failBatch(filenames, 'Processing failed for one or more projects', watcherConfig);
    }

    // Update status
    await writeStatus();
  }
}

// ============================================================================
// Lifecycle Management
// ============================================================================

async function startup(config: DaemonConfig): Promise<void> {
  console.log('Initializing global memory daemon...');
  console.log(`  Global dir: ${getGlobalDir()}`);
  console.log(`  Queue dir: ${config.queue_dir}`);
  console.log(`  Proxy URL: ${config.proxy_url}`);
  console.log(`  Batch size: ${config.batch_size}`);

  // Initialize global directories
  const globalInitResult = await initGlobalDirs();
  if (!globalInitResult.ok) {
    throw new Error(`Failed to initialize global directories: ${globalInitResult.error.message}`);
  }

  // Initialize queue
  const queueResult = await initQueue({ baseDir: config.queue_dir });
  if (!queueResult.ok) {
    throw new Error(`Failed to initialize queue: ${queueResult.error.message}`);
  }

  state = {
    running: true,
    startedAt: new Date(),
    eventsProcessed: 0,
    lastExtraction: null,
    lastDecay: null,
    projects: new Map(),
  };

  await writeStatus();
}

async function shutdown(): Promise<void> {
  console.log('\nShutting down memory daemon...');
  state.running = false;
  await writeStatus();
  console.log('Daemon stopped.');
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
    console.log('\nGlobal memory daemon running. Press Ctrl+C to stop.\n');
    await processEvents(config);
  } catch (error) {
    console.error('Daemon error:', error);
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

    console.log('Global Memory Daemon Status:');
    console.log(`  Running: ${status.running}`);
    console.log(`  PID: ${status.pid ?? 'N/A'}`);
    console.log(`  Started: ${status.started_at ?? 'N/A'}`);
    console.log(`  Events processed: ${status.events_processed}`);
    console.log(`  Last extraction: ${status.last_extraction ?? 'Never'}`);
    console.log(`  Last decay: ${status.last_decay ?? 'Never'}`);

    if (status.projects && Object.keys(status.projects).length > 0) {
      console.log('\n  Projects:');
      for (const [path, stats] of Object.entries(status.projects)) {
        console.log(`    ${path}:`);
        console.log(`      Events: ${stats.events_processed}, Memories: ${stats.memories_extracted}`);
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

async function runManualDecay(): Promise<void> {
  const statusPath = getGlobalStatusPath();

  // Read current status to get project list
  let projects: string[] = [];
  try {
    const content = await fs.readFile(statusPath, 'utf-8');
    const status = JSON.parse(content) as DaemonStatus;
    if (status.projects) {
      projects = Object.keys(status.projects);
    }
  } catch {
    console.log('No status file found. Please specify a project directory.');
    return;
  }

  if (projects.length === 0) {
    console.log('No projects found in daemon status.');
    return;
  }

  console.log('Running decay for known projects...');
  for (const projectPath of projects) {
    const memoryDir = getProjectMemoryDir(projectPath);
    console.log(`\n  ${projectPath}:`);

    const result = await runDecay(memoryDir);
    if (result.ok) {
      console.log(`    Daily: moved=${result.value.daily.moved}, filtered=${result.value.daily.filtered}`);
      console.log(`    Weekly: moved=${result.value.weekly.moved}, filtered=${result.value.weekly.filtered}`);
      console.log(`    Monthly: archived=${result.value.monthly.archived}`);
    } else {
      console.error(`    Failed: ${result.error.message}`);
    }
  }
}

// Determine command - handle both direct invocation and via cli.js
const args = process.argv.slice(2);
const command = args.find(arg => ['start', 'status', 'decay'].includes(arg)) ?? (args.length === 0 ? undefined : 'start');

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

  case 'decay':
    runManualDecay();
    break;
}
