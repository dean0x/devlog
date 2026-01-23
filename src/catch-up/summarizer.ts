/**
 * Catch-Up Summarizer
 *
 * ARCHITECTURE: Format session data for context restoration
 * Pattern: Pass raw turn context to LLM for analysis, provide fallback formatting
 *
 * Now that we store raw turn_context instead of regex-extracted signals,
 * the LLM handles all semantic interpretation. This module provides formatting
 * and fallback display for when LLM is unavailable.
 */

import type { SessionAccumulator, SessionSignal, SignalType } from '../types/session.js';
import type { RecentSessionSummary } from './recent-sessions.js';
import { generateLLMSummary, type SummaryConfig } from './llm-summarizer.js';
import type { Result } from '../types/index.js';
import { Ok } from '../types/index.js';
import { formatDistanceToNow, parseISO } from 'date-fns';

// ============================================================================
// Types
// ============================================================================

/**
 * Importance levels for signals (matches Gate 4 logic)
 */
export type ImportanceLevel = 'critical' | 'high' | 'medium' | 'skip';

/**
 * A filtered signal with its importance level
 */
export interface FilteredSignal {
  readonly type: SignalType;
  readonly content: string;
  readonly files?: readonly string[];
  readonly importance: ImportanceLevel;
}

/**
 * Structured catch-up data for JSON output
 */
export interface CatchUpData {
  readonly generated_at: string;
  readonly active_sessions: readonly ActiveSessionSummary[];
  readonly recent_sessions: readonly RecentSessionSummary[];
}

/**
 * Summary of an active session
 */
export interface ActiveSessionSummary {
  readonly session_id: string;
  readonly project_path: string;
  readonly started_at: string;
  readonly last_activity: string;
  readonly age_human: string;
  readonly goal?: string;
  readonly key_signals: readonly FilteredSignal[];
  readonly files_touched: readonly string[];
}

// ============================================================================
// Signal Importance Classification
// ============================================================================

/**
 * Determine the importance level of a signal
 *
 * With turn_context signals, importance is based on content length.
 * The LLM will do the real semantic analysis during consolidation.
 */
export function getImportanceLevel(signal: SessionSignal): ImportanceLevel {
  switch (signal.signal_type) {
    case 'turn_context':
      // Turn context with substantial content is important
      return signal.content.length > 100 ? 'high' : 'medium';

    case 'file_touched':
      // Skip file_touched - we track files separately
      return 'skip';

    default:
      return 'skip';
  }
}

/**
 * Filter signals to only include valuable ones
 */
export function filterValuableSignals(signals: readonly SessionSignal[]): readonly FilteredSignal[] {
  const filtered: FilteredSignal[] = [];

  for (const signal of signals) {
    const importance = getImportanceLevel(signal);

    if (importance !== 'skip') {
      filtered.push({
        type: signal.signal_type,
        content: signal.content,
        files: signal.files,
        importance,
      });
    }
  }

  // Sort by importance (critical first, then high, then medium)
  const importanceOrder: Record<ImportanceLevel, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    skip: 3,
  };

  return filtered.sort((a, b) => importanceOrder[a.importance] - importanceOrder[b.importance]);
}

// ============================================================================
// Session Summary Generation
// ============================================================================

/**
 * Extract the primary goal from session signals (if any)
 *
 * With turn_context signals, we look for "User:" prefix content
 * to extract what the user was asking about.
 */
function extractGoal(signals: readonly SessionSignal[]): string | undefined {
  // Find the first turn_context with user content
  const turnContext = signals.find(s => s.signal_type === 'turn_context');
  if (!turnContext) return undefined;

  // Extract the user portion if present
  const userMatch = turnContext.content.match(/^User:\s*(.+?)(?:\n|$)/);
  if (userMatch?.[1]) {
    const goal = userMatch[1].trim();
    return goal.length > 100 ? goal.slice(0, 100) + '...' : goal;
  }

  return undefined;
}

/**
 * Generate a summary from an active session
 */
export function generateActiveSessionSummary(session: SessionAccumulator): ActiveSessionSummary {
  const keySignals = filterValuableSignals(session.signals);
  const goal = extractGoal(session.signals);

  return {
    session_id: session.session_id,
    project_path: session.project_path,
    started_at: session.started_at,
    last_activity: session.last_activity,
    age_human: formatDistanceToNow(parseISO(session.started_at), { addSuffix: true }),
    goal,
    key_signals: keySignals,
    files_touched: session.files_touched_all,
  };
}

/**
 * Generate a RecentSessionSummary for persistence after consolidation
 */
export function generateSessionSummary(session: SessionAccumulator): RecentSessionSummary {
  const keySignals = filterValuableSignals(session.signals);
  const goal = extractGoal(session.signals);

  return {
    session_id: session.session_id,
    project_path: session.project_path,
    started_at: session.started_at,
    consolidated_at: new Date().toISOString(),
    goal,
    key_signals: keySignals.map(s => ({
      type: s.type,
      content: s.content,
      files: s.files ? [...s.files] : undefined,
    })),
    files_touched: [...session.files_touched_all],
  };
}

// ============================================================================
// Output Formatting
// ============================================================================

/**
 * Format catch-up data as structured JSON
 */
export function formatCatchUpJson(
  activeSessions: readonly SessionAccumulator[],
  recentSummaries: readonly RecentSessionSummary[]
): CatchUpData {
  return {
    generated_at: new Date().toISOString(),
    active_sessions: activeSessions.map(generateActiveSessionSummary),
    recent_sessions: recentSummaries,
  };
}

/**
 * Format a single active session for human-readable output
 */
function formatActiveSession(session: SessionAccumulator): string {
  const summary = generateActiveSessionSummary(session);
  const lines: string[] = [];

  lines.push(`## Current Session (started ${summary.age_human})`);

  if (summary.goal) {
    lines.push(`Goal: ${summary.goal}`);
  }

  // Show turn context signals (the actual conversation)
  const turnContexts = summary.key_signals.filter(s => s.type === 'turn_context');
  for (const ctx of turnContexts.slice(0, 3)) {
    // Truncate for display
    const truncated = ctx.content.length > 200
      ? ctx.content.slice(0, 200) + '...'
      : ctx.content;
    lines.push(truncated);
  }

  if (summary.files_touched.length > 0) {
    const files = summary.files_touched.slice(0, 5);
    const filesStr = files.join(', ');
    const more = summary.files_touched.length > 5
      ? ` (+${summary.files_touched.length - 5} more)`
      : '';
    lines.push(`Files: ${filesStr}${more}`);
  }

  return lines.join('\n');
}

/**
 * Format a recent session summary for human-readable output
 *
 * Handles both old signal types (backwards compatibility) and new turn_context.
 */
function formatRecentSession(summary: RecentSessionSummary): string {
  const lines: string[] = [];

  const age = formatDistanceToNow(parseISO(summary.consolidated_at), { addSuffix: true });
  const title = summary.goal || 'Session';
  lines.push(`[${age}] ${title}`);

  // Show top 2 key signals
  for (const signal of summary.key_signals.slice(0, 2)) {
    const truncated = signal.content.slice(0, 80);
    const suffix = signal.content.length > 80 ? '...' : '';
    lines.push(`  - ${truncated}${suffix}`);
  }

  if (summary.files_touched.length > 0) {
    const files = summary.files_touched.slice(0, 3).join(', ');
    lines.push(`  - Files: ${files}`);
  }

  return lines.join('\n');
}

/**
 * Format catch-up data as human-readable markdown
 */
export function formatCatchUpSummary(
  activeSessions: readonly SessionAccumulator[],
  recentSummaries: readonly RecentSessionSummary[]
): string {
  const sections: string[] = [];

  // Active sessions
  if (activeSessions.length > 0) {
    for (const session of activeSessions) {
      sections.push(formatActiveSession(session));
    }
  }

  // Recent sessions
  if (recentSummaries.length > 0) {
    sections.push('## Recent Sessions');
    for (const summary of recentSummaries) {
      sections.push(formatRecentSession(summary));
    }
  }

  if (sections.length === 0) {
    return 'No sessions found. Start a Claude Code session with devlog hooks enabled.';
  }

  return sections.join('\n\n');
}

// ============================================================================
// LLM-Based Summarization
// ============================================================================

/**
 * Result of LLM catch-up generation
 */
export interface LLMCatchUpResult {
  /** The prose summary from LLM */
  readonly summary: string;
  /** Whether result came from cache */
  readonly fromCache: boolean;
  /** Error message if LLM failed (summary will be raw fallback) */
  readonly error?: string;
}

/**
 * Generate an LLM-based catch-up summary
 *
 * Falls back to raw signal display if Ollama is unavailable.
 */
export async function generateLLMCatchUpSummary(
  activeSessions: readonly SessionAccumulator[],
  recentSummaries: readonly RecentSessionSummary[],
  memoryDir: string,
  config: SummaryConfig
): Promise<Result<LLMCatchUpResult, Error>> {
  const llmResult = await generateLLMSummary(
    activeSessions,
    recentSummaries,
    memoryDir,
    config
  );

  if (llmResult.ok) {
    return Ok({
      summary: llmResult.value.summary,
      fromCache: llmResult.value.fromCache,
    });
  }

  // Fallback to raw signal display
  const rawSummary = formatCatchUpSummary(activeSessions, recentSummaries);
  return Ok({
    summary: rawSummary,
    fromCache: false,
    error: llmResult.error.message,
  });
}
