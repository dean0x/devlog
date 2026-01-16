/**
 * Memory Decay
 *
 * ARCHITECTURE: Time-based memory compaction
 * Pattern: Pure functions for decay logic, side effects isolated in runners
 *
 * Decay schedule:
 *   - Daily: Move yesterday's entries from today.md → this-week.md (filter low confidence)
 *   - Weekly: Compact last week → this-month.md (keep decisions/patterns only)
 *   - Monthly: Archive previous month (generate summary)
 */

import { format, subDays, startOfWeek, startOfMonth, isMonday, getDate } from 'date-fns';
import type { MemoryEntry, Result, DaemonError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';
import {
  readShortTermMemory,
  appendToShortTermMemory,
  archiveMonth,
  type MemoryStoreConfig,
} from '../storage/memory-store.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface DecayConfig {
  readonly memoryDir: string;
  readonly minConfidenceForWeek: number;
  readonly minConfidenceForMonth: number;
}

const DEFAULT_DECAY_CONFIG: Omit<DecayConfig, 'memoryDir'> = {
  minConfidenceForWeek: 0.7,
  minConfidenceForMonth: 0.8,
};

/**
 * Filter memories by confidence threshold
 */
function filterByConfidence(
  memories: readonly MemoryEntry[],
  minConfidence: number
): MemoryEntry[] {
  return memories.filter((m) => m.confidence >= minConfidence);
}

/**
 * Filter memories to keep only high-value types for long-term storage
 */
function filterForLongTerm(memories: readonly MemoryEntry[]): MemoryEntry[] {
  const valuableTypes = new Set(['decision', 'pattern', 'convention']);
  return memories.filter((m) => valuableTypes.has(m.type));
}

/**
 * Merge similar memories (same title and type)
 */
function mergeSimilarMemories(memories: readonly MemoryEntry[]): MemoryEntry[] {
  const merged = new Map<string, MemoryEntry>();

  for (const memory of memories) {
    const key = `${memory.type}:${memory.title.toLowerCase()}`;
    const existing = merged.get(key);

    if (existing) {
      // Keep the one with higher confidence, merge files/tags
      const higherConfidence = memory.confidence > existing.confidence ? memory : existing;
      const allFiles = new Set([...(existing.files ?? []), ...(memory.files ?? [])]);
      const allTags = new Set([...(existing.tags ?? []), ...(memory.tags ?? [])]);

      merged.set(key, {
        ...higherConfidence,
        files: allFiles.size > 0 ? [...allFiles] : undefined,
        tags: allTags.size > 0 ? [...allTags] : undefined,
      });
    } else {
      merged.set(key, memory);
    }
  }

  return [...merged.values()];
}

/**
 * Run daily decay: Move yesterday's entries to this-week
 */
export async function runDailyDecay(
  config: DecayConfig
): Promise<Result<{ moved: number; filtered: number }, DaemonError>> {
  const storeConfig: MemoryStoreConfig = { baseDir: config.memoryDir };
  const yesterday = format(subDays(new Date(), 1), 'yyyy-MM-dd');

  // Read today's memories
  const readResult = await readShortTermMemory(storeConfig, 'today');
  if (!readResult.ok) {
    return Err({
      type: 'decay_error',
      message: `Failed to read today.md: ${readResult.error.message}`,
    });
  }

  // Filter to yesterday's entries
  const yesterdaysMemories = readResult.value.memories.filter((m) =>
    m.timestamp.startsWith(yesterday)
  );

  if (yesterdaysMemories.length === 0) {
    return Ok({ moved: 0, filtered: 0 });
  }

  // Filter by confidence
  const highConfidence = filterByConfidence(
    yesterdaysMemories,
    config.minConfidenceForWeek
  );
  const merged = mergeSimilarMemories(highConfidence);

  // Append to this-week
  if (merged.length > 0) {
    const appendResult = await appendToShortTermMemory(storeConfig, 'this-week', merged);
    if (!appendResult.ok) {
      return Err({
        type: 'decay_error',
        message: `Failed to append to this-week.md: ${appendResult.error.message}`,
      });
    }
  }

  // Remove yesterday's entries from today.md
  const todaysMemories = readResult.value.memories.filter(
    (m) => !m.timestamp.startsWith(yesterday)
  );

  // Rewrite today.md
  const todayPath = join(config.memoryDir, 'short', 'today.md');
  if (todaysMemories.length === 0) {
    // Clear the file
    try {
      await fs.writeFile(todayPath, `---
date: ${format(new Date(), 'yyyy-MM-dd')}
entries: 0
last_updated: ${new Date().toISOString()}
---
# Today's Memory - ${format(new Date(), 'yyyy-MM-dd')}
`);
    } catch (error) {
      return Err({
        type: 'decay_error',
        message: `Failed to clear today.md: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  return Ok({
    moved: merged.length,
    filtered: yesterdaysMemories.length - highConfidence.length,
  });
}

/**
 * Run weekly decay: Compact last week to this-month
 */
export async function runWeeklyDecay(
  config: DecayConfig
): Promise<Result<{ moved: number; filtered: number }, DaemonError>> {
  // Only run on Mondays
  if (!isMonday(new Date())) {
    return Ok({ moved: 0, filtered: 0 });
  }

  const storeConfig: MemoryStoreConfig = { baseDir: config.memoryDir };

  // Read this-week
  const readResult = await readShortTermMemory(storeConfig, 'this-week');
  if (!readResult.ok) {
    return Err({
      type: 'decay_error',
      message: `Failed to read this-week.md: ${readResult.error.message}`,
    });
  }

  if (readResult.value.memories.length === 0) {
    return Ok({ moved: 0, filtered: 0 });
  }

  // Filter for long-term value and high confidence
  const filtered = filterForLongTerm(readResult.value.memories);
  const highConfidence = filterByConfidence(filtered, config.minConfidenceForMonth);
  const merged = mergeSimilarMemories(highConfidence);

  // Append to this-month
  if (merged.length > 0) {
    const appendResult = await appendToShortTermMemory(storeConfig, 'this-month', merged);
    if (!appendResult.ok) {
      return Err({
        type: 'decay_error',
        message: `Failed to append to this-month.md: ${appendResult.error.message}`,
      });
    }
  }

  // Clear this-week
  const weekPath = join(config.memoryDir, 'short', 'this-week.md');
  try {
    await fs.writeFile(weekPath, `---
date: ${format(new Date(), 'yyyy-MM-dd')}
entries: 0
last_updated: ${new Date().toISOString()}
---
# This Week - Week of ${format(startOfWeek(new Date()), 'yyyy-MM-dd')}
`);
  } catch (error) {
    return Err({
      type: 'decay_error',
      message: `Failed to clear this-week.md: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }

  return Ok({
    moved: merged.length,
    filtered: readResult.value.memories.length - merged.length,
  });
}

/**
 * Run monthly decay: Archive previous month
 */
export async function runMonthlyDecay(
  config: DecayConfig
): Promise<Result<{ archived: boolean }, DaemonError>> {
  // Only run on the 1st of the month
  if (getDate(new Date()) !== 1) {
    return Ok({ archived: false });
  }

  const storeConfig: MemoryStoreConfig = { baseDir: config.memoryDir };
  const lastMonth = startOfMonth(subDays(new Date(), 1));
  const year = lastMonth.getFullYear();
  const month = lastMonth.getMonth() + 1;

  const archiveResult = await archiveMonth(storeConfig, year, month);
  if (!archiveResult.ok) {
    return Err({
      type: 'decay_error',
      message: `Failed to archive month: ${archiveResult.error.message}`,
    });
  }

  // Clear this-month
  const monthPath = join(config.memoryDir, 'short', 'this-month.md');
  try {
    await fs.writeFile(monthPath, `---
date: ${format(new Date(), 'yyyy-MM-dd')}
entries: 0
last_updated: ${new Date().toISOString()}
---
# This Month - ${format(startOfMonth(new Date()), 'MMMM yyyy')}
`);
  } catch (error) {
    return Err({
      type: 'decay_error',
      message: `Failed to clear this-month.md: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }

  return Ok({ archived: true });
}

/**
 * Run all decay operations
 */
export async function runDecay(
  memoryDir: string
): Promise<Result<{ daily: { moved: number; filtered: number }; weekly: { moved: number; filtered: number }; monthly: { archived: boolean } }, DaemonError>> {
  const config: DecayConfig = {
    ...DEFAULT_DECAY_CONFIG,
    memoryDir,
  };

  const dailyResult = await runDailyDecay(config);
  if (!dailyResult.ok) {
    return Err(dailyResult.error);
  }

  const weeklyResult = await runWeeklyDecay(config);
  if (!weeklyResult.ok) {
    return Err(weeklyResult.error);
  }

  const monthlyResult = await runMonthlyDecay(config);
  if (!monthlyResult.ok) {
    return Err(monthlyResult.error);
  }

  return Ok({
    daily: dailyResult.value,
    weekly: weeklyResult.value,
    monthly: monthlyResult.value,
  });
}
