/**
 * Recent Sessions Storage
 *
 * ARCHITECTURE: Persist summaries of recently consolidated sessions
 * Pattern: JSON file storage in .memory/working/recent-summaries.json
 *
 * Sessions are kept for context restoration after /clear or new sessions.
 * Limited to last N sessions (configurable, default 10) to prevent unbounded growth.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import type { SignalType } from '../types/session.js';
import type { Result, StorageError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Summary of a consolidated session for catch-up
 */
export interface RecentSessionSummary {
  readonly session_id: string;
  readonly project_path: string;
  readonly started_at: string;
  readonly consolidated_at: string;
  readonly goal?: string;
  readonly key_signals: readonly {
    readonly type: SignalType;
    readonly content: string;
    readonly files?: readonly string[];
  }[];
  readonly files_touched: readonly string[];
}

/**
 * Configuration for catch-up feature
 */
export interface CatchUpConfig {
  /** Maximum number of recent sessions to keep (default: 10) */
  readonly max_sessions: number;
}

/**
 * Default catch-up configuration
 */
export const DEFAULT_CATCH_UP_CONFIG: CatchUpConfig = {
  max_sessions: 10,
};

// ============================================================================
// Constants
// ============================================================================

const WORKING_DIR = 'working';
const SUMMARIES_FILE = 'recent-summaries.json';

// ============================================================================
// Path Helpers
// ============================================================================

function getSummariesPath(memoryDir: string): string {
  return join(memoryDir, WORKING_DIR, SUMMARIES_FILE);
}

// ============================================================================
// Storage Operations
// ============================================================================

export interface SessionStoreConfig {
  readonly memoryDir: string;
}

/**
 * Read all recent session summaries
 */
export async function readRecentSummaries(
  config: SessionStoreConfig,
  limit?: number
): Promise<Result<readonly RecentSessionSummary[], StorageError>> {
  const path = getSummariesPath(config.memoryDir);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const data = JSON.parse(content) as { summaries: RecentSessionSummary[] };
    const summaries = data.summaries || [];

    // Apply limit if specified
    if (limit !== undefined && limit > 0) {
      return Ok(summaries.slice(0, limit));
    }

    return Ok(summaries);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok([]);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read recent summaries: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Save a session summary (prepends to the list)
 */
export async function saveSessionSummary(
  config: SessionStoreConfig,
  summary: RecentSessionSummary
): Promise<Result<void, StorageError>> {
  const path = getSummariesPath(config.memoryDir);

  // Read existing summaries
  const readResult = await readRecentSummaries(config);
  if (!readResult.ok) {
    return readResult;
  }

  // Prepend new summary (most recent first)
  const summaries = [summary, ...readResult.value];

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify({ summaries }, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to save session summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Prune summaries to enforce the maximum limit
 */
export async function pruneToLimit(
  config: SessionStoreConfig,
  maxSessions: number
): Promise<Result<void, StorageError>> {
  const path = getSummariesPath(config.memoryDir);

  // Read existing summaries
  const readResult = await readRecentSummaries(config);
  if (!readResult.ok) {
    return readResult;
  }

  const summaries = readResult.value;

  // Check if pruning is needed
  if (summaries.length <= maxSessions) {
    return Ok(undefined);
  }

  // Keep only the most recent N summaries
  const pruned = summaries.slice(0, maxSessions);

  try {
    await fs.writeFile(path, JSON.stringify({ summaries: pruned }, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to prune session summaries: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Get summaries for a specific project path
 */
export async function getProjectSummaries(
  config: SessionStoreConfig,
  projectPath: string,
  limit?: number
): Promise<Result<readonly RecentSessionSummary[], StorageError>> {
  const readResult = await readRecentSummaries(config);
  if (!readResult.ok) {
    return readResult;
  }

  const filtered = readResult.value.filter(s => s.project_path === projectPath);

  if (limit !== undefined && limit > 0) {
    return Ok(filtered.slice(0, limit));
  }

  return Ok(filtered);
}

/**
 * Clear all recent summaries (for testing or reset)
 */
export async function clearRecentSummaries(
  config: SessionStoreConfig
): Promise<Result<void, StorageError>> {
  const path = getSummariesPath(config.memoryDir);

  try {
    await fs.unlink(path);
    return Ok(undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(undefined); // Already cleared
    }
    return Err({
      type: 'write_error',
      message: `Failed to clear recent summaries: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}
