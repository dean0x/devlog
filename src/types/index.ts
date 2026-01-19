/**
 * Core type definitions for the Devlog system
 *
 * ARCHITECTURE: All types use Result pattern for error handling
 * Pattern: Operations return Result<T, E> instead of throwing
 */

// ============================================================================
// Result Type - Explicit error handling
// ============================================================================

export type Result<T, E> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export const Ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const Err = <E>(error: E): Err<E> => ({ ok: false, error });

// ============================================================================
// Event Queue Types
// ============================================================================

export type EventType = 'turn_complete';

/**
 * TurnEvent - Captured at the end of each Claude response
 *
 * ARCHITECTURE: Events are turn-based, not tool-based
 * Pattern: One event per Claude response with memo extraction
 */
export interface QueuedEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly event_type: EventType;
  readonly session_id: string;
  readonly project_path: string;
  readonly user_prompt: string;
  readonly assistant_response: string;
  readonly files_touched: readonly string[];
}

export interface ProcessingResult {
  readonly event_id: string;
  readonly success: boolean;
  readonly memories_extracted: number;
  readonly error?: string;
}

// ============================================================================
// Memory Types
// ============================================================================

/**
 * Memory Types (Refined for concise memos)
 *
 * goal     - Current objective: "Implementing OAuth2 for mobile"
 * decision - Choice made: "Using JWT because sessions don't scale"
 * problem  - Issue to remember: "Race condition in checkout flow"
 * context  - WIP state: "Halfway through refactoring auth module"
 * insight  - Learning: "This codebase uses repository pattern"
 */
export type MemoryType = 'goal' | 'decision' | 'problem' | 'context' | 'insight';

export interface MemoryEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string;
  readonly confidence: number;
  readonly files?: readonly string[];
  readonly tags?: readonly string[];
  readonly related_events?: readonly string[];
  readonly source?: MemoSource;
}

export interface ShortTermMemoryFile {
  readonly date: string;
  readonly entries: number;
  readonly last_updated: string;
  readonly memories: readonly MemoryEntry[];
}

export interface LongTermMemory {
  readonly id: string;
  readonly category: 'conventions' | 'architecture' | 'rules_of_thumb';
  readonly title: string;
  readonly content: string;
  readonly first_observed: string;
  readonly last_validated: string;
  readonly occurrences: number;
  readonly source_entries: readonly string[];
}

export interface PromotionCandidate {
  readonly pattern_hash: string;
  readonly first_seen: string;
  readonly occurrences: number;
  readonly total_confidence: number;
  readonly source_entries: readonly string[];
  readonly suggested_category: LongTermMemory['category'];
  readonly suggested_content: string;
}

// ============================================================================
// Daemon Types
// ============================================================================

export interface DaemonConfig {
  readonly ollama_url: string;
  readonly ollama_model: string;
  readonly memory_dir: string;
  readonly queue_dir: string;
  readonly batch_size: number;
  readonly poll_interval_ms: number;
  readonly decay_schedule: DecaySchedule;
}

export interface DecaySchedule {
  readonly daily_hour: number;
  readonly weekly_day: number;
  readonly monthly_day: number;
}

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly started_at?: string;
  readonly events_processed: number;
  readonly last_extraction?: string;
  readonly last_decay?: string;
  readonly projects?: { readonly [path: string]: ProjectStats };
}

export interface ProjectStats {
  readonly events_processed: number;
  readonly memories_extracted: number;
  readonly last_activity?: string;
}

export interface GlobalConfig {
  readonly ollama_base_url: string;
  readonly ollama_model: string;
}

// ============================================================================
// Extraction Types
// ============================================================================

/**
 * Source of extracted memo
 * - 'claude': Extracted using Ollama (higher confidence)
 * - 'fallback': Extracted using heuristics when Ollama unavailable (lower confidence)
 */
export type MemoSource = 'claude' | 'fallback';

/**
 * Memo extraction result - null means skip (trivial interaction)
 */
export interface ExtractedMemo {
  readonly type: MemoryType;
  readonly title: string;
  readonly content: string;
  readonly files: readonly string[];
  readonly tags?: readonly string[];
  readonly source?: MemoSource;
}

export interface ExtractionResult {
  readonly memo: ExtractedMemo | null;
}

/**
 * Context-aware extraction decision
 *
 * ARCHITECTURE: Supports create, update, or skip actions
 * Pattern: Explicit decision type with required reasoning
 */
export interface ExtractionDecision {
  readonly action: 'create' | 'update' | 'skip';
  readonly memo?: ExtractedMemo;
  readonly updateTarget?: string;
  readonly updateFields?: Partial<Pick<MemoryEntry, 'title' | 'content' | 'files' | 'tags'>>;
  readonly reasoning: string;
}

/**
 * Memo context for extraction decisions
 *
 * ARCHITECTURE: Gradual attention mechanism
 * Pattern: Long-term has highest weight, today has lowest
 */
export interface MemoContext {
  readonly longTerm: readonly LongTermMemory[];
  readonly thisWeek: readonly MemoryEntry[];
  readonly today: readonly MemoryEntry[];
}

/**
 * Attention configuration for context loading
 */
export interface AttentionConfig {
  readonly longTermLimit: number;
  readonly thisWeekLimit: number;
  readonly todayLimit: number;
}

// ============================================================================
// Error Types
// ============================================================================

export type DaemonError =
  | { readonly type: 'queue_error'; readonly message: string }
  | { readonly type: 'extraction_error'; readonly message: string }
  | { readonly type: 'storage_error'; readonly message: string }
  | { readonly type: 'decay_error'; readonly message: string };

export type StorageError =
  | { readonly type: 'read_error'; readonly message: string; readonly path: string }
  | { readonly type: 'write_error'; readonly message: string; readonly path: string }
  | { readonly type: 'parse_error'; readonly message: string; readonly path: string };

// ============================================================================
// Re-exports for convenience
// ============================================================================

// Re-export session types
export type {
  SignalType,
  SessionSignal,
  SessionStatus,
  SessionAccumulator,
  SessionEventType,
  SessionTurnEvent,
  SessionEndEvent,
  ConsolidationAction,
  ConsolidationResult,
  ConsolidationActionTaken,
  SessionConfig,
} from './session.js';

export { DEFAULT_SESSION_CONFIG } from './session.js';
