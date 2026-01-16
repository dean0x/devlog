/**
 * Event Queue Storage
 *
 * ARCHITECTURE: File-based queue for hook events
 * Pattern: Atomic writes via rename, Result types for all operations
 *
 * Queue structure:
 *   .memory/queue/pending/   - New events waiting to be processed
 *   .memory/queue/processing/ - Events currently being processed
 *   .memory/queue/failed/    - Events that failed processing
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { QueuedEvent, Result, StorageError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

export interface QueueConfig {
  readonly baseDir: string;
}

const PENDING_DIR = 'pending';
const PROCESSING_DIR = 'processing';
const FAILED_DIR = 'failed';

/**
 * Ensure queue directories exist
 */
export async function initQueue(config: QueueConfig): Promise<Result<void, StorageError>> {
  const dirs = [
    join(config.baseDir, PENDING_DIR),
    join(config.baseDir, PROCESSING_DIR),
    join(config.baseDir, FAILED_DIR),
  ];

  try {
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to create queue directories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: config.baseDir,
    });
  }
}

/**
 * Write an event to the pending queue
 */
export async function enqueueEvent(
  event: Omit<QueuedEvent, 'id' | 'timestamp'>,
  config: QueueConfig
): Promise<Result<string, StorageError>> {
  const eventId = uuidv4();
  const timestamp = new Date().toISOString();

  const fullEvent: QueuedEvent = {
    ...event,
    id: eventId,
    timestamp,
  };

  const filename = `${timestamp.replace(/[:.]/g, '-')}_${eventId}.json`;
  const pendingPath = join(config.baseDir, PENDING_DIR, filename);
  const tempPath = `${pendingPath}.tmp`;

  try {
    // Ensure directory exists
    await fs.mkdir(dirname(pendingPath), { recursive: true });

    // Write to temp file first
    await fs.writeFile(tempPath, JSON.stringify(fullEvent, null, 2), 'utf-8');

    // Atomic rename
    await fs.rename(tempPath, pendingPath);

    return Ok(eventId);
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    return Err({
      type: 'write_error',
      message: `Failed to enqueue event: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: pendingPath,
    });
  }
}

/**
 * List all pending events
 */
export async function listPendingEvents(
  config: QueueConfig
): Promise<Result<string[], StorageError>> {
  const pendingDir = join(config.baseDir, PENDING_DIR);

  try {
    const files = await fs.readdir(pendingDir);
    return Ok(
      files
        .filter((f) => f.endsWith('.json'))
        .sort() // Sorted by timestamp due to filename format
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok([]);
    }
    return Err({
      type: 'read_error',
      message: `Failed to list pending events: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: pendingDir,
    });
  }
}

/**
 * Read an event from the queue
 */
export async function readEvent(
  filename: string,
  config: QueueConfig
): Promise<Result<QueuedEvent, StorageError>> {
  const pendingPath = join(config.baseDir, PENDING_DIR, filename);

  try {
    const content = await fs.readFile(pendingPath, 'utf-8');
    const event = JSON.parse(content) as QueuedEvent;
    return Ok(event);
  } catch (error) {
    return Err({
      type: 'read_error',
      message: `Failed to read event: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: pendingPath,
    });
  }
}

/**
 * Move event from pending to processing
 */
export async function markProcessing(
  filename: string,
  config: QueueConfig
): Promise<Result<void, StorageError>> {
  const pendingPath = join(config.baseDir, PENDING_DIR, filename);
  const processingPath = join(config.baseDir, PROCESSING_DIR, filename);

  try {
    await fs.mkdir(dirname(processingPath), { recursive: true });
    await fs.rename(pendingPath, processingPath);
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to mark event as processing: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: processingPath,
    });
  }
}

/**
 * Remove event after successful processing
 */
export async function markCompleted(
  filename: string,
  config: QueueConfig
): Promise<Result<void, StorageError>> {
  const processingPath = join(config.baseDir, PROCESSING_DIR, filename);

  try {
    await fs.unlink(processingPath);
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to remove completed event: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: processingPath,
    });
  }
}

/**
 * Move event to failed queue with error info
 */
export async function markFailed(
  filename: string,
  error: string,
  config: QueueConfig
): Promise<Result<void, StorageError>> {
  const processingPath = join(config.baseDir, PROCESSING_DIR, filename);
  const failedPath = join(config.baseDir, FAILED_DIR, filename);

  try {
    // Read current event
    const content = await fs.readFile(processingPath, 'utf-8');
    const event = JSON.parse(content) as QueuedEvent & { _error?: string; _failed_at?: string };

    // Add error info
    event._error = error;
    event._failed_at = new Date().toISOString();

    // Write to failed directory
    await fs.mkdir(dirname(failedPath), { recursive: true });
    await fs.writeFile(failedPath, JSON.stringify(event, null, 2), 'utf-8');

    // Remove from processing
    await fs.unlink(processingPath);

    return Ok(undefined);
  } catch (err) {
    return Err({
      type: 'write_error',
      message: `Failed to mark event as failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      path: failedPath,
    });
  }
}

/**
 * Get counts for queue statistics
 */
export async function getQueueStats(
  config: QueueConfig
): Promise<Result<{ pending: number; processing: number; failed: number }, StorageError>> {
  try {
    const countFiles = async (dir: string): Promise<number> => {
      try {
        const files = await fs.readdir(join(config.baseDir, dir));
        return files.filter((f) => f.endsWith('.json')).length;
      } catch {
        return 0;
      }
    };

    const [pending, processing, failed] = await Promise.all([
      countFiles(PENDING_DIR),
      countFiles(PROCESSING_DIR),
      countFiles(FAILED_DIR),
    ]);

    return Ok({ pending, processing, failed });
  } catch (error) {
    return Err({
      type: 'read_error',
      message: `Failed to get queue stats: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: config.baseDir,
    });
  }
}

/**
 * Recover stuck events from processing back to pending
 * (Called on daemon startup to handle crashes)
 */
export async function recoverStuckEvents(
  config: QueueConfig
): Promise<Result<number, StorageError>> {
  const processingDir = join(config.baseDir, PROCESSING_DIR);
  const pendingDir = join(config.baseDir, PENDING_DIR);

  try {
    const files = await fs.readdir(processingDir);
    let recovered = 0;

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        await fs.rename(
          join(processingDir, file),
          join(pendingDir, file)
        );
        recovered++;
      } catch {
        // Ignore individual file errors
      }
    }

    return Ok(recovered);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(0);
    }
    return Err({
      type: 'read_error',
      message: `Failed to recover stuck events: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: processingDir,
    });
  }
}
