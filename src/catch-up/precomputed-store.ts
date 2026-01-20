/**
 * Precomputed Catch-Up Summary Store
 *
 * ARCHITECTURE: Background-computed summaries for instant catch-up queries
 * Pattern: Dirty flag + debounced recomputation in daemon
 *
 * The daemon monitors the dirty flag and recomputes summaries in the background,
 * so `devlog catch-up` returns instantly from pre-computed results.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Result, StorageError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Pre-computed summary stored on disk
 */
export interface PrecomputedSummary {
  readonly source_hash: string;      // Hash of source data for cache invalidation
  readonly summary: string;          // The LLM-generated summary
  readonly generated_at: string;     // When computed (ISO timestamp)
  readonly status: 'fresh' | 'stale' | 'computing';
  readonly last_error?: string;      // Error from last attempt
}

/**
 * Dirty flag state for tracking when recomputation is needed
 */
export interface CatchUpState {
  readonly dirty: boolean;           // Source data changed since last summary
  readonly dirty_since?: string;     // When dirty flag was set (ISO timestamp)
}

// ============================================================================
// Constants
// ============================================================================

const SUMMARY_FILE = 'catch-up-summary.json';
const STATE_FILE = 'catch-up-state.json';

/** Wait after last change before summarizing (ms) */
export const DEBOUNCE_MS = 30_000;

/** Force summarization even if changes keep coming (ms) */
export const MAX_STALE_MS = 5 * 60_000;

// ============================================================================
// Path Helpers
// ============================================================================

function getSummaryPath(memoryDir: string): string {
  return join(memoryDir, 'working', SUMMARY_FILE);
}

function getStatePath(memoryDir: string): string {
  return join(memoryDir, 'working', STATE_FILE);
}

// ============================================================================
// Summary Operations
// ============================================================================

/**
 * Read pre-computed summary from disk
 */
export async function readPrecomputedSummary(
  memoryDir: string
): Promise<Result<PrecomputedSummary | null, StorageError>> {
  const path = getSummaryPath(memoryDir);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const summary = JSON.parse(content) as PrecomputedSummary;
    return Ok(summary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(null);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read precomputed summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Write pre-computed summary to disk
 */
export async function writePrecomputedSummary(
  memoryDir: string,
  summary: PrecomputedSummary
): Promise<Result<void, StorageError>> {
  const path = getSummaryPath(memoryDir);

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(summary, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write precomputed summary: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

// ============================================================================
// Dirty Flag Operations
// ============================================================================

/**
 * Read catch-up state (dirty flag)
 */
export async function readCatchUpState(
  memoryDir: string
): Promise<Result<CatchUpState | null, StorageError>> {
  const path = getStatePath(memoryDir);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const state = JSON.parse(content) as CatchUpState;
    return Ok(state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(null);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read catch-up state: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Mark catch-up as dirty (needing refresh)
 *
 * Called by hooks when new signals are added.
 */
export async function markCatchUpDirty(
  memoryDir: string
): Promise<Result<void, StorageError>> {
  const path = getStatePath(memoryDir);

  // Read existing state to preserve dirty_since if already dirty
  const existingResult = await readCatchUpState(memoryDir);
  const existing = existingResult.ok ? existingResult.value : null;

  const state: CatchUpState = {
    dirty: true,
    // Only set dirty_since if transitioning from clean to dirty
    dirty_since: existing?.dirty ? existing.dirty_since : new Date().toISOString(),
  };

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to mark catch-up dirty: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Clear catch-up dirty flag (after successful recomputation)
 */
export async function clearCatchUpDirty(
  memoryDir: string
): Promise<Result<void, StorageError>> {
  const path = getStatePath(memoryDir);

  const state: CatchUpState = {
    dirty: false,
    dirty_since: undefined,
  };

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(state, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to clear catch-up dirty: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

// ============================================================================
// Recomputation Logic
// ============================================================================

/**
 * Determine if summary should be recomputed
 *
 * Returns true when:
 * 1. State is dirty AND debounce period has elapsed, OR
 * 2. State has been dirty for longer than max stale time
 */
export function shouldRecomputeSummary(
  state: CatchUpState | null,
  _summary: PrecomputedSummary | null
): boolean {
  // Not dirty = no recomputation needed
  if (!state?.dirty) {
    return false;
  }

  // Must have dirty_since to compute timing
  if (!state.dirty_since) {
    return true; // Dirty but no timestamp, assume we should recompute
  }

  const dirtyTime = new Date(state.dirty_since).getTime();
  const now = Date.now();
  const elapsed = now - dirtyTime;

  // Force recomputation if stale too long (even if still getting changes)
  if (elapsed >= MAX_STALE_MS) {
    return true;
  }

  // Normal case: wait for debounce period after last change
  return elapsed >= DEBOUNCE_MS;
}
