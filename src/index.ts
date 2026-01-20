/**
 * Devlog - Claude Code Memory System
 *
 * Session-based knowledge consolidation for Claude Code projects.
 *
 * Main exports for programmatic usage.
 */

// Types
export type {
  Result,
  MemoryEntry,
  MemoryType,
  LongTermMemory,
  DaemonStatus,
  ProjectStats,
  GlobalConfig,
  DaemonError,
  StorageError,
} from './types/index.js';

// Result type constructors and types
export { Ok, Err, type Ok as OkType, type Err as ErrType } from './types/index.js';

// Session types
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
} from './types/session.js';

export { DEFAULT_SESSION_CONFIG } from './types/session.js';

// Storage - Knowledge Store (new system)
export {
  initKnowledgeStore,
  readKnowledgeFile,
  addSection,
  updateSection,
  confirmSection,
  createSection,
  searchKnowledge,
  updateIndex,
  getAllCategories,
  getCategoryTitle,
  type KnowledgeStoreConfig,
  type KnowledgeCategory,
  type KnowledgeSection,
  type KnowledgeFile,
} from './storage/knowledge-store.js';

// Storage - Session Store
export {
  initSessionStore,
  appendSignalAndPersist,
  extractSignalsFromTurn,
  findStaleSessions,
  findSessionsToConsolidate,
  finalizeSession,
  archiveSession,
  listSessions,
  type SessionStoreConfig,
} from './storage/session-store.js';

// Storage - Long-term Memory (used by knowledge consolidation)
export {
  readLongTermMemory,
  readAllLongTermMemories,
} from './storage/memory-store.js';

// Global paths and configuration
export {
  getGlobalDir,
  getGlobalConfigPath,
  getGlobalStatusPath,
  getProjectMemoryDir,
  initGlobalDirs,
  isGlobalInitialized,
  readGlobalConfig,
  writeGlobalConfig,
  initProjectMemory,
  isProjectMemoryInitialized,
  isValidProjectPath,
  cleanupLegacyMemory,
  readSessionConfig,
  writeSessionConfig,
} from './paths.js';

// Catch-up feature - context restoration after /clear or new sessions
export {
  filterValuableSignals,
  getImportanceLevel,
  generateActiveSessionSummary,
  generateSessionSummary,
  formatCatchUpJson,
  formatCatchUpSummary,
  generateLLMCatchUpSummary,
  type ImportanceLevel,
  type FilteredSignal,
  type CatchUpData,
  type ActiveSessionSummary,
  type LLMCatchUpResult,
} from './catch-up/summarizer.js';

export {
  generateLLMSummary,
  buildSummaryPrompt,
  computeCacheHash,
  type SummaryConfig,
  type LLMSummaryResult,
} from './catch-up/llm-summarizer.js';

export {
  readRecentSummaries,
  saveSessionSummary,
  pruneToLimit,
  getProjectSummaries,
  clearRecentSummaries,
  DEFAULT_CATCH_UP_CONFIG,
  type RecentSessionSummary,
  type CatchUpConfig,
} from './catch-up/recent-sessions.js';

// Precomputed catch-up summaries (instant query support)
export {
  readPrecomputedSummary,
  writePrecomputedSummary,
  readCatchUpState,
  markCatchUpDirty,
  clearCatchUpDirty,
  shouldRecomputeSummary,
  DEBOUNCE_MS,
  MAX_STALE_MS,
  type PrecomputedSummary,
  type CatchUpState,
} from './catch-up/precomputed-store.js';
