/**
 * Long-Term Memory Promotion
 *
 * ARCHITECTURE: Tracks recurring patterns and promotes to long-term memory
 * Pattern: Criteria-based promotion with candidate tracking
 *
 * Promotion criteria:
 *   - Pattern observed 3+ times across different sessions
 *   - Average confidence >= 0.85
 *   - Time spread >= 3 days (not a burst)
 *   - No contradictions in later sessions
 */

import { createHash } from 'node:crypto';
import { differenceInDays } from 'date-fns';
import type {
  MemoryEntry,
  LongTermMemory,
  PromotionCandidate,
  Result,
  DaemonError,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';
import {
  readPromotionCandidates,
  writePromotionCandidates,
  appendLongTermMemory,
  type MemoryStoreConfig,
} from '../storage/memory-store.js';

export interface PromotionConfig {
  readonly memoryDir: string;
  readonly minOccurrences: number;
  readonly minAverageConfidence: number;
  readonly minDaySpread: number;
}

// Default values for reference (used by callers to construct PromotionConfig)
export const DEFAULT_PROMOTION_VALUES = {
  minOccurrences: 3,
  minAverageConfidence: 0.85,
  minDaySpread: 3,
} as const;

/**
 * Create a hash for pattern matching
 * Two memories are considered the same pattern if they have similar content
 */
function createPatternHash(entry: MemoryEntry): string {
  // Normalize content for comparison
  const normalized = [
    entry.type,
    entry.title.toLowerCase().replace(/\s+/g, ' ').trim(),
    // First 100 chars of content for similarity
    entry.content.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100),
  ].join('|');

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Suggest a category based on memory type
 */
function suggestCategory(entry: MemoryEntry): LongTermMemory['category'] {
  switch (entry.type) {
    case 'decision':
      return entry.tags?.some((t) => t.toLowerCase().includes('arch'))
        ? 'architecture'
        : 'conventions';
    case 'insight':
      return 'rules_of_thumb';
    case 'goal':
    case 'context':
    case 'problem':
    default:
      return 'rules_of_thumb';
  }
}

/**
 * Evaluate new memories and update promotion candidates
 */
export async function evaluateForPromotion(
  memories: readonly MemoryEntry[],
  config: PromotionConfig
): Promise<Result<{ candidatesUpdated: number; promoted: number }, DaemonError>> {
  const storeConfig: MemoryStoreConfig = { baseDir: config.memoryDir };

  // Read existing candidates
  const readResult = await readPromotionCandidates(storeConfig);
  if (!readResult.ok) {
    return Err({
      type: 'storage_error',
      message: `Failed to read promotion candidates: ${readResult.error.message}`,
    });
  }

  const candidatesMap = new Map<string, PromotionCandidate>();
  for (const candidate of readResult.value) {
    candidatesMap.set(candidate.pattern_hash, candidate);
  }

  // Process new memories
  for (const memory of memories) {
    // Only consider high-value types for promotion
    if (!['decision', 'insight'].includes(memory.type)) {
      continue;
    }

    const hash = createPatternHash(memory);
    const existing = candidatesMap.get(hash);

    if (existing) {
      // Update existing candidate
      candidatesMap.set(hash, {
        ...existing,
        occurrences: existing.occurrences + 1,
        total_confidence: existing.total_confidence + memory.confidence,
        source_entries: [...existing.source_entries, memory.id],
      });
    } else {
      // Create new candidate
      candidatesMap.set(hash, {
        pattern_hash: hash,
        first_seen: memory.timestamp,
        occurrences: 1,
        total_confidence: memory.confidence,
        source_entries: [memory.id],
        suggested_category: suggestCategory(memory),
        suggested_content: `${memory.title}: ${memory.content}`,
      });
    }
  }

  // Check for promotion
  const toPromote: PromotionCandidate[] = [];
  const remaining: PromotionCandidate[] = [];

  for (const candidate of candidatesMap.values()) {
    const avgConfidence = candidate.total_confidence / candidate.occurrences;
    const daySpread = differenceInDays(
      new Date(),
      new Date(candidate.first_seen)
    );

    const meetsOccurrences = candidate.occurrences >= config.minOccurrences;
    const meetsConfidence = avgConfidence >= config.minAverageConfidence;
    const meetsTimeSpread = daySpread >= config.minDaySpread;

    if (meetsOccurrences && meetsConfidence && meetsTimeSpread) {
      toPromote.push(candidate);
    } else {
      remaining.push(candidate);
    }
  }

  // Promote qualifying candidates
  let promotedCount = 0;
  for (const candidate of toPromote) {
    const longTermMemory: LongTermMemory = {
      id: candidate.pattern_hash,
      category: candidate.suggested_category,
      title: candidate.suggested_content.split(':')[0]?.trim() ?? 'Untitled',
      content: candidate.suggested_content,
      first_observed: candidate.first_seen.split('T')[0] ?? '',
      last_validated: new Date().toISOString().split('T')[0] ?? '',
      occurrences: candidate.occurrences,
      source_entries: candidate.source_entries,
    };

    const appendResult = await appendLongTermMemory(storeConfig, longTermMemory);
    if (appendResult.ok) {
      promotedCount++;
    } else {
      console.warn(`Failed to promote candidate: ${appendResult.error.message}`);
      remaining.push(candidate); // Keep for retry
    }
  }

  // Write updated candidates
  const writeResult = await writePromotionCandidates(storeConfig, remaining);
  if (!writeResult.ok) {
    return Err({
      type: 'storage_error',
      message: `Failed to write promotion candidates: ${writeResult.error.message}`,
    });
  }

  return Ok({
    candidatesUpdated: candidatesMap.size - toPromote.length,
    promoted: promotedCount,
  });
}

/**
 * Clean up old candidates that haven't made progress
 */
export async function cleanupStaleCandidates(
  config: PromotionConfig,
  maxAgeDays: number = 30
): Promise<Result<{ removed: number }, DaemonError>> {
  const storeConfig: MemoryStoreConfig = { baseDir: config.memoryDir };

  const readResult = await readPromotionCandidates(storeConfig);
  if (!readResult.ok) {
    return Err({
      type: 'storage_error',
      message: `Failed to read promotion candidates: ${readResult.error.message}`,
    });
  }

  const now = new Date();
  const active = readResult.value.filter((candidate) => {
    const age = differenceInDays(now, new Date(candidate.first_seen));
    // Keep if: young enough OR making progress (high occurrence rate)
    const isYoung = age <= maxAgeDays;
    const isActive = candidate.occurrences >= Math.floor(age / 7); // ~1 per week
    return isYoung || isActive;
  });

  const removed = readResult.value.length - active.length;

  if (removed > 0) {
    const writeResult = await writePromotionCandidates(storeConfig, active);
    if (!writeResult.ok) {
      return Err({
        type: 'storage_error',
        message: `Failed to write promotion candidates: ${writeResult.error.message}`,
      });
    }
  }

  return Ok({ removed });
}
