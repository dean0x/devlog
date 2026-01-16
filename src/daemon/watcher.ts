/**
 * Queue Watcher
 *
 * ARCHITECTURE: Polls queue directory for new events
 * Pattern: Async iterator, configurable batch size and poll interval
 */

import { watch } from 'chokidar';
import { join } from 'node:path';
import {
  listPendingEvents,
  readEvent,
  markProcessing,
  markCompleted,
  markFailed,
  recoverStuckEvents,
  type QueueConfig,
} from '../storage/queue.js';
import type { QueuedEvent, Result, DaemonError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

export interface WatcherConfig {
  readonly queueDir: string;
  readonly batchSize: number;
  readonly pollIntervalMs: number;
}

export interface EventBatch {
  readonly events: QueuedEvent[];
  readonly filenames: string[];
}

/**
 * Create a watcher that yields batches of events
 */
export async function* watchQueue(
  config: WatcherConfig
): AsyncGenerator<Result<EventBatch, DaemonError>, void, unknown> {
  const queueConfig: QueueConfig = { baseDir: config.queueDir };

  // Recover any stuck events from previous crashes
  const recoveryResult = await recoverStuckEvents(queueConfig);
  if (recoveryResult.ok && recoveryResult.value > 0) {
    console.log(`Recovered ${recoveryResult.value} stuck events from processing queue`);
  }

  while (true) {
    // List pending events
    const listResult = await listPendingEvents(queueConfig);
    if (!listResult.ok) {
      yield Err({
        type: 'queue_error',
        message: listResult.error.message,
      });
      await sleep(config.pollIntervalMs);
      continue;
    }

    const pendingFiles = listResult.value;
    if (pendingFiles.length === 0) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    // Take a batch
    const batchFiles = pendingFiles.slice(0, config.batchSize);
    const events: QueuedEvent[] = [];
    const filenames: string[] = [];

    for (const filename of batchFiles) {
      // Read the event
      const readResult = await readEvent(filename, queueConfig);
      if (!readResult.ok) {
        console.error(`Failed to read event ${filename}: ${readResult.error.message}`);
        continue;
      }

      // Mark as processing
      const markResult = await markProcessing(filename, queueConfig);
      if (!markResult.ok) {
        console.error(`Failed to mark event ${filename} as processing: ${markResult.error.message}`);
        continue;
      }

      events.push(readResult.value);
      filenames.push(filename);
    }

    if (events.length > 0) {
      yield Ok({ events, filenames });
    }

    // Small delay to avoid tight loop
    await sleep(100);
  }
}

/**
 * Mark a batch of events as completed
 */
export async function completeBatch(
  filenames: readonly string[],
  config: WatcherConfig
): Promise<Result<void, DaemonError>> {
  const queueConfig: QueueConfig = { baseDir: config.queueDir };

  for (const filename of filenames) {
    const result = await markCompleted(filename, queueConfig);
    if (!result.ok) {
      return Err({
        type: 'queue_error',
        message: `Failed to complete event ${filename}: ${result.error.message}`,
      });
    }
  }

  return Ok(undefined);
}

/**
 * Mark a batch of events as failed
 */
export async function failBatch(
  filenames: readonly string[],
  error: string,
  config: WatcherConfig
): Promise<Result<void, DaemonError>> {
  const queueConfig: QueueConfig = { baseDir: config.queueDir };

  for (const filename of filenames) {
    const result = await markFailed(filename, error, queueConfig);
    if (!result.ok) {
      console.error(`Failed to mark event ${filename} as failed: ${result.error.message}`);
    }
  }

  return Ok(undefined);
}

/**
 * Create a file system watcher for immediate notification
 * (Used in addition to polling for lower latency)
 */
export function createFileWatcher(
  config: WatcherConfig,
  onNewEvent: () => void
): { close: () => Promise<void> } {
  const pendingDir = join(config.queueDir, 'pending');

  const watcher = watch(pendingDir, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  });

  watcher.on('add', () => {
    onNewEvent();
  });

  return {
    close: () => watcher.close(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
