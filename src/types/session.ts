/**
 * Session Types for Session-Based Knowledge Consolidation
 *
 * ARCHITECTURE: Session-level accumulation instead of per-turn extraction
 * Pattern: Accumulate signals during session, consolidate at session end
 *
 * Signal types represent different kinds of valuable information:
 * - file_touched: Files modified during the session
 * - decision_made: Explicit choices with rationale
 * - pattern_observed: Recurring patterns or conventions discovered
 * - problem_discovered: Issues, bugs, or technical debt found
 * - goal_stated: Objectives or tasks being worked on
 */

// ============================================================================
// Session Signal Types
// ============================================================================

/**
 * Types of signals that can be accumulated during a session
 */
export type SignalType =
  | 'file_touched'
  | 'decision_made'
  | 'pattern_observed'
  | 'problem_discovered'
  | 'goal_stated';

/**
 * A single signal captured during a session turn
 *
 * Signals are lightweight observations that accumulate during a session.
 * They are NOT memos - memos are created during consolidation.
 */
export interface SessionSignal {
  readonly id: string;
  readonly timestamp: string;
  readonly turn_number: number;
  readonly signal_type: SignalType;
  readonly content: string;
  readonly files?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

// ============================================================================
// Session Accumulator
// ============================================================================

/**
 * Session status lifecycle
 */
export type SessionStatus = 'active' | 'consolidating' | 'closed';

/**
 * The session accumulator tracks all signals during a Claude Code session
 *
 * ARCHITECTURE: Ephemeral buffer that persists to .memory/working/
 * Pattern: Append-only during session, consolidate at end
 */
export interface SessionAccumulator {
  readonly session_id: string;
  readonly project_path: string;
  readonly started_at: string;
  readonly last_activity: string;
  readonly turn_count: number;
  readonly signals: readonly SessionSignal[];
  readonly files_touched_all: readonly string[];
  readonly status: SessionStatus;
}

// ============================================================================
// Session Events
// ============================================================================

/**
 * Event type for session lifecycle
 */
export type SessionEventType =
  | 'session_turn'
  | 'session_end'
  | 'session_timeout';

/**
 * Event emitted during a session turn (replaces turn_complete for new system)
 */
export interface SessionTurnEvent {
  readonly event_type: 'session_turn';
  readonly session_id: string;
  readonly project_path: string;
  readonly turn_number: number;
  readonly timestamp: string;
  readonly user_prompt: string;
  readonly assistant_response: string;
  readonly files_touched: readonly string[];
}

/**
 * Event emitted when a session ends (timeout or explicit)
 */
export interface SessionEndEvent {
  readonly event_type: 'session_end';
  readonly session_id: string;
  readonly project_path: string;
  readonly reason: 'timeout' | 'explicit' | 'error';
  readonly timestamp: string;
}

// ============================================================================
// Consolidation Types
// ============================================================================

/**
 * Actions that can result from session consolidation
 */
export type ConsolidationAction =
  | 'create_section'
  | 'extend_section'
  | 'add_example'
  | 'confirm_pattern'
  | 'flag_contradiction'
  | 'skip';

/**
 * Result of consolidating a session into knowledge
 */
export interface ConsolidationResult {
  readonly session_id: string;
  readonly timestamp: string;
  readonly actions_taken: readonly ConsolidationActionTaken[];
  readonly signals_processed: number;
  readonly knowledge_updates: number;
}

/**
 * A single consolidation action that was taken
 */
export interface ConsolidationActionTaken {
  readonly action: ConsolidationAction;
  readonly category?: string;
  readonly section_id?: string;
  readonly reasoning: string;
}

// ============================================================================
// Session Configuration
// ============================================================================

/**
 * Configuration for session-based consolidation
 */
export interface SessionConfig {
  /** Time in ms before a session is considered timed out (default: 5 minutes) */
  readonly timeout_ms: number;
  /** Minimum signals before consolidation is triggered */
  readonly min_signals_for_consolidation: number;
}

/**
 * Default session configuration
 */
export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  timeout_ms: 5 * 60 * 1000, // 5 minutes
  min_signals_for_consolidation: 1,
};
