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

// ============================================================================
// Daemon Types
// ============================================================================

export interface DaemonStatus {
  readonly running: boolean;
  readonly pid?: number;
  readonly started_at?: string;
  readonly events_processed: number;
  readonly last_extraction?: string;
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
// Error Types
// ============================================================================

export type DaemonError =
  | { readonly type: 'extraction_error'; readonly message: string }
  | { readonly type: 'storage_error'; readonly message: string };

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
