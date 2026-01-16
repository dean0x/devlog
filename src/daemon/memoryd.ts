#!/usr/bin/env node
/**
 * Memory Daemon (memoryd)
 *
 * ARCHITECTURE: Background process that extracts and manages memories
 * Pattern: Event loop with graceful shutdown, scheduled jobs
 *
 * Responsibilities:
 *   1. Watch queue for new events
 *   2. Batch events and extract memories
 *   3. Store memories in appropriate files
 *   4. Run scheduled decay jobs
 *   5. Evaluate patterns for promotion
 */

import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { watchQueue, completeBatch, failBatch, type WatcherConfig } from './watcher.js';
import { extractMemories, type ExtractorConfig } from './extractor.js';
import { runDecay } from './decay.js';
import { evaluateForPromotion, cleanupStaleCandidates, type PromotionConfig } from './promotion.js';
import { initQueue } from '../storage/queue.js';
import { initMemoryStore, appendToShortTermMemory, type MemoryStoreConfig } from '../storage/memory-store.js';
import type { DaemonConfig, DaemonStatus } from '../types/index.js';

// ============================================================================
// Configuration
// ============================================================================

function loadConfig(): DaemonConfig {
  return {
    proxy_url: process.env['PROXY_URL'] ?? 'http://localhost:8082',
    ollama_model: process.env['OLLAMA_MODEL'] ?? 'llama3.2',
    memory_dir: process.env['MEMORY_DIR'] ?? join(process.cwd(), '.memory'),
    queue_dir: process.env['QUEUE_DIR'] ?? join(process.cwd(), '.memory', 'queue'),
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
}

let state: DaemonState = {
  running: false,
  startedAt: new Date(),
  eventsProcessed: 0,
  lastExtraction: null,
  lastDecay: null,
};

const STATUS_FILE = '.memory/daemon.status';

async function writeStatus(config: DaemonConfig): Promise<void> {
  const status: DaemonStatus = {
    running: state.running,
    pid: process.pid,
    started_at: state.startedAt.toISOString(),
    events_processed: state.eventsProcessed,
    last_extraction: state.lastExtraction?.toISOString(),
    last_decay: state.lastDecay?.toISOString(),
  };

  const statusPath = join(config.memory_dir, '..', STATUS_FILE);
  try {
    await fs.writeFile(statusPath, JSON.stringify(status, null, 2));
  } catch {
    // Ignore status write errors
  }
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

async function runScheduledDecay(config: DaemonConfig): Promise<void> {
  console.log('Running scheduled decay...');

  const result = await runDecay(config.memory_dir);
  if (result.ok) {
    console.log(
      `Decay complete: daily(moved=${result.value.daily.moved}, filtered=${result.value.daily.filtered}), ` +
      `weekly(moved=${result.value.weekly.moved}, filtered=${result.value.weekly.filtered}), ` +
      `monthly(archived=${result.value.monthly.archived})`
    );
    state.lastDecay = new Date();
  } else {
    console.error('Decay failed:', result.error.message);
  }

  // Also cleanup stale candidates
  const promotionConfig: PromotionConfig = {
    memoryDir: config.memory_dir,
    minOccurrences: 3,
    minAverageConfidence: 0.85,
    minDaySpread: 3,
  };

  const cleanupResult = await cleanupStaleCandidates(promotionConfig);
  if (cleanupResult.ok && cleanupResult.value.removed > 0) {
    console.log(`Cleaned up ${cleanupResult.value.removed} stale promotion candidates`);
  }
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

  const storeConfig: MemoryStoreConfig = {
    baseDir: config.memory_dir,
  };

  const promotionConfig: PromotionConfig = {
    memoryDir: config.memory_dir,
    minOccurrences: 3,
    minAverageConfidence: 0.85,
    minDaySpread: 3,
  };

  console.log('Starting event processor...');

  for await (const batchResult of watchQueue(watcherConfig)) {
    if (!state.running) {
      break;
    }

    // Check for scheduled decay
    if (shouldRunDecay(config)) {
      await runScheduledDecay(config);
    }

    if (!batchResult.ok) {
      console.error('Queue error:', batchResult.error.message);
      continue;
    }

    const { events, filenames } = batchResult.value;
    console.log(`Processing batch of ${events.length} events...`);

    // Extract memories
    const extractResult = await extractMemories(events, extractorConfig);
    if (!extractResult.ok) {
      console.error('Extraction failed:', extractResult.error.message);
      await failBatch(filenames, extractResult.error.message, watcherConfig);
      continue;
    }

    const { memories } = extractResult.value;
    console.log(`Extracted ${memories.length} memories`);

    if (memories.length > 0) {
      // Store in short-term memory
      const storeResult = await appendToShortTermMemory(storeConfig, 'today', memories);
      if (!storeResult.ok) {
        console.error('Storage failed:', storeResult.error.message);
        await failBatch(filenames, storeResult.error.message, watcherConfig);
        continue;
      }

      // Evaluate for promotion
      const promoResult = await evaluateForPromotion(memories, promotionConfig);
      if (promoResult.ok && promoResult.value.promoted > 0) {
        console.log(`Promoted ${promoResult.value.promoted} memories to long-term storage`);
      }

      state.lastExtraction = new Date();
    }

    // Mark batch as complete
    await completeBatch(filenames, watcherConfig);
    state.eventsProcessed += events.length;

    // Update status
    await writeStatus(config);
  }
}

// ============================================================================
// Lifecycle Management
// ============================================================================

async function startup(config: DaemonConfig): Promise<void> {
  console.log('Initializing memory daemon...');
  console.log(`  Memory dir: ${config.memory_dir}`);
  console.log(`  Queue dir: ${config.queue_dir}`);
  console.log(`  Proxy URL: ${config.proxy_url}`);
  console.log(`  Batch size: ${config.batch_size}`);

  // Initialize storage
  const queueResult = await initQueue({ baseDir: config.queue_dir });
  if (!queueResult.ok) {
    throw new Error(`Failed to initialize queue: ${queueResult.error.message}`);
  }

  const storeResult = await initMemoryStore({ baseDir: config.memory_dir });
  if (!storeResult.ok) {
    throw new Error(`Failed to initialize memory store: ${storeResult.error.message}`);
  }

  state = {
    running: true,
    startedAt: new Date(),
    eventsProcessed: 0,
    lastExtraction: null,
    lastDecay: null,
  };

  await writeStatus(config);
}

async function shutdown(config: DaemonConfig): Promise<void> {
  console.log('\nShutting down memory daemon...');
  state.running = false;
  await writeStatus(config);
  console.log('Daemon stopped.');
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  const config = loadConfig();

  // Handle signals
  process.on('SIGINT', () => {
    shutdown(config).then(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    shutdown(config).then(() => process.exit(0));
  });

  try {
    await startup(config);
    console.log('\nMemory daemon running. Press Ctrl+C to stop.\n');
    await processEvents(config);
  } catch (error) {
    console.error('Daemon error:', error);
    process.exit(1);
  }
}

// CLI commands
const command = process.argv[2];

switch (command) {
  case 'start':
  case undefined:
    main().catch((error) => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
    break;

  case 'status':
    const config = loadConfig();
    const statusPath = join(config.memory_dir, '..', STATUS_FILE);
    fs.readFile(statusPath, 'utf-8')
      .then((content) => {
        const status = JSON.parse(content) as DaemonStatus;
        console.log('Memory Daemon Status:');
        console.log(`  Running: ${status.running}`);
        console.log(`  PID: ${status.pid ?? 'N/A'}`);
        console.log(`  Started: ${status.started_at ?? 'N/A'}`);
        console.log(`  Events processed: ${status.events_processed}`);
        console.log(`  Last extraction: ${status.last_extraction ?? 'Never'}`);
        console.log(`  Last decay: ${status.last_decay ?? 'Never'}`);
      })
      .catch(() => {
        console.log('Daemon is not running or status file not found.');
      });
    break;

  case 'decay':
    // Manual decay trigger
    const manualConfig = loadConfig();
    runDecay(manualConfig.memory_dir)
      .then((result) => {
        if (result.ok) {
          console.log('Decay completed:', result.value);
        } else {
          console.error('Decay failed:', result.error.message);
        }
      });
    break;

  default:
    console.log('Usage: memoryd [start|status|decay]');
    console.log('  start  - Start the daemon (default)');
    console.log('  status - Show daemon status');
    console.log('  decay  - Manually run decay');
    process.exit(1);
}
