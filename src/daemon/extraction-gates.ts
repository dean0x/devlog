/**
 * Extraction Gates
 *
 * ARCHITECTURE: Strong filtering before any LLM call
 * Pattern: Gate decision tree reduces unnecessary extraction calls
 *
 * Gate flow:
 * 1. MEANINGFUL - Has files/decisions/problems?
 * 2. DISTINCT - Not >80% similar to existing?
 * 3. RECURRING - Same topic 2+ times in 7 days?
 * 4. VALUABLE - Has decision/insight with rationale?
 */

import type { SessionAccumulator, SessionSignal } from '../types/session.js';
import type {
  KnowledgeSection,
  KnowledgeCategory,
  KnowledgeStoreConfig,
} from '../storage/knowledge-store.js';
import {
  readAllKnowledge,
  searchKnowledge,
} from '../storage/knowledge-store.js';
import type { Result, StorageError } from '../types/index.js';
import { Ok } from '../types/index.js';

// ============================================================================
// Gate Actions
// ============================================================================

/**
 * Actions that can result from gate evaluation
 */
export type GateAction =
  | 'skip'              // Don't process, not valuable
  | 'confirm_pattern'   // Just bump observation count (no LLM)
  | 'consolidate'       // Merge with existing knowledge (LLM needed)
  | 'create_new';       // Create new knowledge section (LLM needed)

/**
 * Result of gate evaluation
 */
export interface GateResult {
  readonly action: GateAction;
  readonly reasoning: string;
  readonly matchedSection?: {
    readonly category: KnowledgeCategory;
    readonly section: KnowledgeSection;
    readonly similarity: number;
  };
  readonly signals_passed: number;
  readonly signals_total: number;
}

// ============================================================================
// Gate Configuration
// ============================================================================

export interface GateConfig {
  /** Minimum number of signals needed to pass Gate 1 */
  readonly minSignals: number;
  /** Similarity threshold for Gate 2 (0-1) */
  readonly similarityThreshold: number;
  /** Days to look back for recurring patterns in Gate 3 */
  readonly recurrenceDays: number;
  /** Minimum signal types that indicate value (for Gate 4) */
  readonly valuableSignalTypes: readonly string[];
}

const DEFAULT_GATE_CONFIG: GateConfig = {
  minSignals: 1,
  similarityThreshold: 0.8,
  recurrenceDays: 7,
  valuableSignalTypes: ['decision_made', 'problem_discovered', 'pattern_observed'],
};

// ============================================================================
// Similarity Calculation
// ============================================================================

/**
 * Calculate word-level Jaccard similarity between two strings
 */
function calculateSimilarity(text1: string, text2: string): number {
  const words1 = new Set(
    text1.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );

  const words2 = new Set(
    text2.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 2)
  );

  if (words1.size === 0 || words2.size === 0) {
    return 0;
  }

  const intersection = new Set([...words1].filter(w => words2.has(w)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

/**
 * Aggregate signals into a searchable text block
 */
function aggregateSignalsToText(signals: readonly SessionSignal[]): string {
  const parts: string[] = [];

  for (const signal of signals) {
    parts.push(signal.content);
    if (signal.files) {
      parts.push(signal.files.join(' '));
    }
  }

  return parts.join(' ');
}

/**
 * Extract key topics from signals
 */
function extractTopics(signals: readonly SessionSignal[]): string[] {
  const topics: string[] = [];

  for (const signal of signals) {
    // Extract meaningful words from content
    const words = signal.content
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);

    topics.push(...words);
  }

  // Return unique topics
  return [...new Set(topics)];
}

// ============================================================================
// Gate Functions
// ============================================================================

/**
 * Gate 1: Is this session meaningful?
 *
 * A session is meaningful if it has:
 * - At least one file touched, OR
 * - At least one decision/problem/goal signal
 */
function gateMeaningful(
  session: SessionAccumulator,
  config: GateConfig
): { passed: boolean; reason: string } {
  // Check for files
  if (session.files_touched_all.length > 0) {
    return {
      passed: true,
      reason: `Has ${session.files_touched_all.length} files touched`,
    };
  }

  // Check for meaningful signal types
  const meaningfulTypes = ['decision_made', 'problem_discovered', 'goal_stated'];
  const meaningfulSignals = session.signals.filter(
    s => meaningfulTypes.includes(s.signal_type)
  );

  if (meaningfulSignals.length > 0) {
    return {
      passed: true,
      reason: `Has ${meaningfulSignals.length} meaningful signals`,
    };
  }

  // Check minimum signal count
  if (session.signals.length >= config.minSignals) {
    return {
      passed: true,
      reason: `Has ${session.signals.length} signals (>= ${config.minSignals})`,
    };
  }

  return {
    passed: false,
    reason: `No files touched and only ${session.signals.length} signals`,
  };
}

/**
 * Gate 2: Is this distinct from existing knowledge?
 *
 * Compare session content against existing knowledge.
 * If >80% similar, it's not distinct (just confirming existing pattern).
 */
async function gateDistinct(
  session: SessionAccumulator,
  storeConfig: KnowledgeStoreConfig,
  config: GateConfig
): Promise<{
  passed: boolean;
  reason: string;
  matchedSection?: {
    category: KnowledgeCategory;
    section: KnowledgeSection;
    similarity: number;
  };
}> {
  const sessionText = aggregateSignalsToText(session.signals);

  // Get topics to search for
  const topics = extractTopics(session.signals);
  if (topics.length === 0) {
    return { passed: true, reason: 'No searchable topics in session' };
  }

  // Search existing knowledge for similar content
  const searchQuery = topics.slice(0, 5).join(' ');
  const searchResult = await searchKnowledge(storeConfig, searchQuery);

  if (!searchResult.ok) {
    return { passed: true, reason: 'Could not search existing knowledge' };
  }

  // Check similarity against top matches
  let highestSimilarity = 0;
  let bestMatch: { category: KnowledgeCategory; section: KnowledgeSection } | null = null;

  for (const match of searchResult.value.slice(0, 5)) {
    const existingText = `${match.section.title} ${match.section.content}`;
    const similarity = calculateSimilarity(sessionText, existingText);

    if (similarity > highestSimilarity) {
      highestSimilarity = similarity;
      bestMatch = match;
    }
  }

  if (highestSimilarity >= config.similarityThreshold) {
    return {
      passed: false,
      reason: `${(highestSimilarity * 100).toFixed(0)}% similar to existing "${bestMatch?.section.title}"`,
      matchedSection: bestMatch ? {
        ...bestMatch,
        similarity: highestSimilarity,
      } : undefined,
    };
  }

  return {
    passed: true,
    reason: `Highest similarity ${(highestSimilarity * 100).toFixed(0)}% (< ${config.similarityThreshold * 100}% threshold)`,
  };
}

/**
 * Gate 3: Is this a recurring pattern?
 *
 * If similar topics have been seen 2+ times in the last N days,
 * this should be consolidated with existing knowledge rather than creating new.
 */
async function gateRecurring(
  session: SessionAccumulator,
  storeConfig: KnowledgeStoreConfig,
  config: GateConfig
): Promise<{
  isRecurring: boolean;
  reason: string;
  matchedSection?: {
    category: KnowledgeCategory;
    section: KnowledgeSection;
  };
}> {
  const allKnowledge = await readAllKnowledge(storeConfig);
  if (!allKnowledge.ok) {
    return { isRecurring: false, reason: 'Could not read existing knowledge' };
  }

  const sessionTopics = extractTopics(session.signals);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - config.recurrenceDays);

  // Look for sections updated recently with similar topics
  for (const [category, file] of allKnowledge.value) {
    for (const section of file.sections) {
      const sectionDate = new Date(section.last_updated);
      if (sectionDate < cutoffDate) {
        continue;
      }

      // Check topic overlap
      const sectionWords = section.title.toLowerCase().split(/\s+/);
      const overlap = sessionTopics.filter(t => sectionWords.includes(t));

      if (overlap.length >= 2 && section.observations >= 2) {
        return {
          isRecurring: true,
          reason: `Topic overlap with "${section.title}" (${section.observations} observations)`,
          matchedSection: { category, section },
        };
      }
    }
  }

  return { isRecurring: false, reason: 'No recurring patterns found' };
}

/**
 * Gate 4: Is this valuable enough to create new knowledge?
 *
 * Only create new knowledge if:
 * - Has decision signals with content, OR
 * - Has problem signals with files, OR
 * - Has substantial insight/pattern observed
 */
function gateValuable(
  session: SessionAccumulator,
  _config: GateConfig
): { passed: boolean; reason: string; valuableSignals: readonly SessionSignal[] } {
  const valuableSignals = session.signals.filter(signal => {
    // Decision with substantial content
    if (signal.signal_type === 'decision_made' && signal.content.length > 30) {
      return true;
    }

    // Problem with files
    if (signal.signal_type === 'problem_discovered' && signal.files && signal.files.length > 0) {
      return true;
    }

    // Pattern with content
    if (signal.signal_type === 'pattern_observed' && signal.content.length > 50) {
      return true;
    }

    // Goal with specifics
    if (signal.signal_type === 'goal_stated' && signal.content.length > 20) {
      return true;
    }

    return false;
  });

  if (valuableSignals.length > 0) {
    return {
      passed: true,
      reason: `Found ${valuableSignals.length} valuable signals`,
      valuableSignals,
    };
  }

  // Check if we have multiple file touches (might indicate substantial work)
  if (session.files_touched_all.length >= 3) {
    return {
      passed: true,
      reason: `Touched ${session.files_touched_all.length} files (substantial work)`,
      valuableSignals: session.signals,
    };
  }

  return {
    passed: false,
    reason: `No valuable signals (decisions, problems, or patterns) found`,
    valuableSignals: [],
  };
}

// ============================================================================
// Main Gate Evaluation
// ============================================================================

/**
 * Run all gates on a session to determine the appropriate action
 *
 * Gate Decision Tree:
 * 1. MEANINGFUL? → No → SKIP
 * 2. DISTINCT? → No (>80% similar) → CONFIRM_PATTERN (no LLM)
 * 3. RECURRING? → Yes (seen 2+ times) → CONSOLIDATE (merge with existing)
 * 4. VALUABLE? → No → SKIP
 * 5. → CREATE_NEW (run LLM consolidation)
 */
export async function evaluateGates(
  session: SessionAccumulator,
  storeConfig: KnowledgeStoreConfig,
  config: GateConfig = DEFAULT_GATE_CONFIG
): Promise<Result<GateResult, StorageError>> {
  // Gate 1: Meaningful
  const meaningful = gateMeaningful(session, config);
  if (!meaningful.passed) {
    return Ok({
      action: 'skip',
      reasoning: `Gate 1 (Meaningful) failed: ${meaningful.reason}`,
      signals_passed: 0,
      signals_total: session.signals.length,
    });
  }

  // Gate 2: Distinct
  const distinct = await gateDistinct(session, storeConfig, config);
  if (!distinct.passed && distinct.matchedSection) {
    return Ok({
      action: 'confirm_pattern',
      reasoning: `Gate 2 (Distinct) failed: ${distinct.reason}`,
      matchedSection: distinct.matchedSection,
      signals_passed: session.signals.length,
      signals_total: session.signals.length,
    });
  }

  // Gate 3: Recurring
  const recurring = await gateRecurring(session, storeConfig, config);
  if (recurring.isRecurring && recurring.matchedSection) {
    return Ok({
      action: 'consolidate',
      reasoning: `Gate 3 (Recurring): ${recurring.reason}`,
      matchedSection: {
        ...recurring.matchedSection,
        similarity: 0.5, // Approximate since it's topic-based
      },
      signals_passed: session.signals.length,
      signals_total: session.signals.length,
    });
  }

  // Gate 4: Valuable
  const valuable = gateValuable(session, config);
  if (!valuable.passed) {
    return Ok({
      action: 'skip',
      reasoning: `Gate 4 (Valuable) failed: ${valuable.reason}`,
      signals_passed: 0,
      signals_total: session.signals.length,
    });
  }

  // All gates passed - create new knowledge
  return Ok({
    action: 'create_new',
    reasoning: `All gates passed: ${valuable.valuableSignals.length} valuable signals`,
    signals_passed: valuable.valuableSignals.length,
    signals_total: session.signals.length,
  });
}

/**
 * Quick check if a session should be processed at all
 * (without running all gates)
 */
export function shouldProcessSession(
  session: SessionAccumulator,
  config: GateConfig = DEFAULT_GATE_CONFIG
): boolean {
  // Must have some signals
  if (session.signals.length < config.minSignals) {
    return false;
  }

  // Must have meaningful content
  const meaningful = gateMeaningful(session, config);
  return meaningful.passed;
}

/**
 * Get a summary of gate decisions for debugging
 */
export function getGateSummary(result: GateResult): string {
  const lines: string[] = [];

  lines.push(`Action: ${result.action.toUpperCase()}`);
  lines.push(`Reasoning: ${result.reasoning}`);
  lines.push(`Signals: ${result.signals_passed}/${result.signals_total} passed`);

  if (result.matchedSection) {
    lines.push(`Matched: [${result.matchedSection.category}] ${result.matchedSection.section.title}`);
    lines.push(`Similarity: ${(result.matchedSection.similarity * 100).toFixed(0)}%`);
  }

  return lines.join('\n');
}
