/**
 * Devlog - Claude Code Memory System
 *
 * Main exports for programmatic usage
 */

// Types
export type {
  Result,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicResponse,
  OllamaMessage,
  OllamaRequest,
  OllamaResponse,
  QueuedEvent,
  EventType,
  MemoryEntry,
  MemoryType,
  ShortTermMemoryFile,
  LongTermMemory,
  PromotionCandidate,
  DaemonConfig,
  DaemonStatus,
  ProjectStats,
  GlobalConfig,
  ProxyError,
  DaemonError,
  StorageError,
} from './types/index.js';

// Result type constructors and types
export { Ok, Err, type Ok as OkType, type Err as ErrType } from './types/index.js';

// Proxy
export { createProxyApp, startProxy, type ProxyConfig } from './proxy/server.js';
export { sendOllamaRequest, streamOllamaRequest, checkOllamaHealth } from './proxy/ollama-client.js';
export { translateRequest, translateResponse } from './proxy/translator.js';

// Storage
export {
  initQueue,
  enqueueEvent,
  listPendingEvents,
  readEvent,
  markProcessing,
  markCompleted,
  markFailed,
  getQueueStats,
} from './storage/queue.js';

export {
  initMemoryStore,
  readShortTermMemory,
  appendToShortTermMemory,
  readLongTermMemory,
  appendLongTermMemory,
  readPromotionCandidates,
  writePromotionCandidates,
  archiveMonth,
} from './storage/memory-store.js';

// Daemon components
export { watchQueue, completeBatch, failBatch } from './daemon/watcher.js';
export { extractMemories } from './daemon/extractor.js';
export { runDecay, runDailyDecay, runWeeklyDecay, runMonthlyDecay } from './daemon/decay.js';
export { evaluateForPromotion, cleanupStaleCandidates } from './daemon/promotion.js';

// Global paths and configuration
export {
  getGlobalDir,
  getGlobalQueueDir,
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
} from './paths.js';
