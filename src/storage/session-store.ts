/**
 * Session Storage
 *
 * ARCHITECTURE: Ephemeral session buffer persistence
 * Pattern: File-based storage in .memory/working/ directory
 *
 * Session files are temporary and cleaned up after consolidation.
 * They persist across process restarts to handle daemon crashes.
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type {
  SessionAccumulator,
  SessionSignal,
  SignalType,
  SessionStatus,
} from '../types/session.js';
import type { Result, StorageError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

// ============================================================================
// Constants
// ============================================================================

const WORKING_DIR = 'working';
const SESSION_FILE_PREFIX = 'session-';
const SESSION_FILE_EXTENSION = '.json';

// ============================================================================
// Path Helpers
// ============================================================================

function getWorkingDir(memoryDir: string): string {
  return join(memoryDir, WORKING_DIR);
}

function getSessionFilePath(memoryDir: string, sessionId: string): string {
  return join(getWorkingDir(memoryDir), `${SESSION_FILE_PREFIX}${sessionId}${SESSION_FILE_EXTENSION}`);
}

/**
 * Generate a unique session ID when Claude Code doesn't provide one
 * Format: sess-{timestamp}-{random4chars}
 */
function generateSessionId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 6);
  return `sess-${timestamp}-${random}`;
}

// ============================================================================
// Session Store Operations
// ============================================================================

export interface SessionStoreConfig {
  readonly memoryDir: string;
}

/**
 * Initialize the working directory for session storage
 */
export async function initSessionStore(
  config: SessionStoreConfig
): Promise<Result<void, StorageError>> {
  const workingDir = getWorkingDir(config.memoryDir);

  try {
    await fs.mkdir(workingDir, { recursive: true });
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to create working directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: workingDir,
    });
  }
}

/**
 * Create a new session accumulator
 */
export function createSession(
  sessionId: string,
  projectPath: string
): SessionAccumulator {
  const now = new Date().toISOString();
  return {
    session_id: sessionId,
    project_path: projectPath,
    started_at: now,
    last_activity: now,
    turn_count: 0,
    signals: [],
    files_touched_all: [],
    status: 'active',
  };
}

/**
 * Read a session from disk
 */
export async function readSession(
  config: SessionStoreConfig,
  sessionId: string
): Promise<Result<SessionAccumulator | null, StorageError>> {
  const path = getSessionFilePath(config.memoryDir, sessionId);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const session = JSON.parse(content) as SessionAccumulator;
    return Ok(session);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(null);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Write a session to disk (atomic via temp file rename)
 */
export async function writeSession(
  config: SessionStoreConfig,
  session: SessionAccumulator
): Promise<Result<void, StorageError>> {
  const path = getSessionFilePath(config.memoryDir, session.session_id);
  const tempPath = `${path}.tmp`;

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tempPath, JSON.stringify(session, null, 2), 'utf-8');
    await fs.rename(tempPath, path);
    return Ok(undefined);
  } catch (error) {
    // Cleanup temp file if it exists
    await fs.unlink(tempPath).catch(() => {});
    return Err({
      type: 'write_error',
      message: `Failed to write session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Delete a session from disk
 */
export async function deleteSession(
  config: SessionStoreConfig,
  sessionId: string
): Promise<Result<void, StorageError>> {
  const path = getSessionFilePath(config.memoryDir, sessionId);

  try {
    await fs.unlink(path);
    return Ok(undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(undefined); // Already deleted
    }
    return Err({
      type: 'write_error',
      message: `Failed to delete session: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Find any active session for this project
 * Used when sessionId is "unknown" to continue an existing session
 * Returns the session or null if none found
 */
async function findActiveSession(
  config: SessionStoreConfig
): Promise<SessionAccumulator | null> {
  const workingDir = getWorkingDir(config.memoryDir);

  try {
    const files = await fs.readdir(workingDir);
    const sessionFiles = files.filter(f =>
      f.startsWith(SESSION_FILE_PREFIX) && f.endsWith(SESSION_FILE_EXTENSION)
    );

    for (const file of sessionFiles) {
      const sessionId = file.slice(SESSION_FILE_PREFIX.length, -SESSION_FILE_EXTENSION.length);
      const result = await readSession(config, sessionId);
      if (result.ok && result.value !== null && result.value.status === 'active') {
        return result.value;
      }
    }
  } catch {
    // Directory doesn't exist or read error - no active sessions
  }

  return null;
}

/**
 * Get or create a session for the given session ID
 *
 * ARCHITECTURE: Handles "unknown" session IDs gracefully
 * When CLAUDE_SESSION_ID is not provided by Claude Code (always "unknown"),
 * we either continue an existing active session or generate a unique ID.
 * This prevents session-unknown.json collisions across different sessions.
 */
export async function getOrCreateSession(
  config: SessionStoreConfig,
  sessionId: string,
  projectPath: string
): Promise<Result<SessionAccumulator, StorageError>> {
  // If sessionId is a real ID (not "unknown"), try to find existing session
  if (sessionId !== 'unknown') {
    const readResult = await readSession(config, sessionId);
    if (!readResult.ok) {
      return readResult;
    }

    if (readResult.value !== null) {
      return Ok(readResult.value);
    }
  }

  // For "unknown" sessionId, find any active session for this project
  // This handles Claude Code not providing CLAUDE_SESSION_ID to hooks
  const activeSession = await findActiveSession(config);
  if (activeSession !== null) {
    return Ok(activeSession);
  }

  // No active session found - create new one with unique ID
  const newSessionId = sessionId !== 'unknown' ? sessionId : generateSessionId();
  const session = createSession(newSessionId, projectPath);
  const writeResult = await writeSession(config, session);
  if (!writeResult.ok) {
    return writeResult;
  }

  return Ok(session);
}

// ============================================================================
// Signal Operations
// ============================================================================

/**
 * Create a new session signal
 */
export function createSignal(
  turnNumber: number,
  signalType: SignalType,
  content: string,
  files?: readonly string[]
): SessionSignal {
  return {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    turn_number: turnNumber,
    signal_type: signalType,
    content,
    files,
  };
}

/**
 * Append a signal to a session (immutable update)
 */
export function appendSignal(
  session: SessionAccumulator,
  signal: SessionSignal
): SessionAccumulator {
  const newFiles = signal.files
    ? [...new Set([...session.files_touched_all, ...signal.files])]
    : session.files_touched_all;

  return {
    ...session,
    last_activity: new Date().toISOString(),
    turn_count: Math.max(session.turn_count, signal.turn_number),
    signals: [...session.signals, signal],
    files_touched_all: newFiles,
  };
}

/**
 * Append a signal to a session and persist
 */
export async function appendSignalAndPersist(
  config: SessionStoreConfig,
  sessionId: string,
  projectPath: string,
  signal: SessionSignal
): Promise<Result<SessionAccumulator, StorageError>> {
  // Get or create session
  const sessionResult = await getOrCreateSession(config, sessionId, projectPath);
  if (!sessionResult.ok) {
    return sessionResult;
  }

  // Append signal
  const updatedSession = appendSignal(sessionResult.value, signal);

  // Persist
  const writeResult = await writeSession(config, updatedSession);
  if (!writeResult.ok) {
    return writeResult;
  }

  return Ok(updatedSession);
}

/**
 * Update session status
 */
export function updateSessionStatus(
  session: SessionAccumulator,
  status: SessionStatus
): SessionAccumulator {
  return {
    ...session,
    status,
    last_activity: new Date().toISOString(),
  };
}

/**
 * Finalize a session (mark as consolidating and return for processing)
 */
export async function finalizeSession(
  config: SessionStoreConfig,
  sessionId: string
): Promise<Result<SessionAccumulator | null, StorageError>> {
  const readResult = await readSession(config, sessionId);
  if (!readResult.ok) {
    return readResult;
  }

  if (readResult.value === null) {
    return Ok(null);
  }

  const session = readResult.value;
  if (session.status !== 'active') {
    // Already finalized or closed
    return Ok(session);
  }

  // Update status to consolidating
  const updatedSession = updateSessionStatus(session, 'consolidating');
  const writeResult = await writeSession(config, updatedSession);
  if (!writeResult.ok) {
    return writeResult;
  }

  return Ok(updatedSession);
}

// ============================================================================
// Session Discovery
// ============================================================================

/**
 * List all session files in the working directory
 */
export async function listSessions(
  config: SessionStoreConfig
): Promise<Result<string[], StorageError>> {
  const workingDir = getWorkingDir(config.memoryDir);

  try {
    const files = await fs.readdir(workingDir);
    const sessionIds = files
      .filter(f => f.startsWith(SESSION_FILE_PREFIX) && f.endsWith(SESSION_FILE_EXTENSION))
      .map(f => f.slice(SESSION_FILE_PREFIX.length, -SESSION_FILE_EXTENSION.length));
    return Ok(sessionIds);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok([]);
    }
    return Err({
      type: 'read_error',
      message: `Failed to list sessions: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: workingDir,
    });
  }
}

/**
 * Find sessions that are stale (no activity for timeout_ms)
 */
export async function findStaleSessions(
  config: SessionStoreConfig,
  timeoutMs: number
): Promise<Result<SessionAccumulator[], StorageError>> {
  const listResult = await listSessions(config);
  if (!listResult.ok) {
    return listResult;
  }

  const now = Date.now();
  const staleSessions: SessionAccumulator[] = [];

  for (const sessionId of listResult.value) {
    const readResult = await readSession(config, sessionId);
    if (!readResult.ok) {
      continue; // Skip problematic sessions
    }

    const session = readResult.value;
    if (session === null) {
      continue;
    }

    // Only consider active sessions for staleness
    if (session.status !== 'active') {
      continue;
    }

    const lastActivity = new Date(session.last_activity).getTime();
    if (now - lastActivity > timeoutMs) {
      staleSessions.push(session);
    }
  }

  return Ok(staleSessions);
}

/**
 * Find sessions that need consolidation (consolidating status)
 */
export async function findSessionsToConsolidate(
  config: SessionStoreConfig
): Promise<Result<SessionAccumulator[], StorageError>> {
  const listResult = await listSessions(config);
  if (!listResult.ok) {
    return listResult;
  }

  const sessions: SessionAccumulator[] = [];

  for (const sessionId of listResult.value) {
    const readResult = await readSession(config, sessionId);
    if (!readResult.ok) {
      continue;
    }

    const session = readResult.value;
    if (session !== null && session.status === 'consolidating') {
      sessions.push(session);
    }
  }

  return Ok(sessions);
}

/**
 * Archive a session after consolidation (mark as closed and optionally keep)
 */
export async function archiveSession(
  config: SessionStoreConfig,
  sessionId: string,
  keepArchive: boolean = false
): Promise<Result<void, StorageError>> {
  if (!keepArchive) {
    return deleteSession(config, sessionId);
  }

  const readResult = await readSession(config, sessionId);
  if (!readResult.ok) {
    return readResult;
  }

  if (readResult.value === null) {
    return Ok(undefined);
  }

  const session = updateSessionStatus(readResult.value, 'closed');
  return writeSession(config, session);
}

// ============================================================================
// Signal Extraction Helpers
// ============================================================================

/**
 * Extract signals from a turn's content
 *
 * ARCHITECTURE: Store raw turn context for LLM analysis during consolidation
 * Pattern: No regex interpretation - LLM handles all semantic extraction
 *
 * We store:
 * - file_touched: Which files were modified (factual)
 * - turn_context: Full user prompt + assistant response for LLM to analyze
 */
export function extractSignalsFromTurn(
  turnNumber: number,
  userPrompt: string,
  assistantResponse: string,
  filesTouched: readonly string[]
): SessionSignal[] {
  const signals: SessionSignal[] = [];

  // Record files touched (factual signal)
  if (filesTouched.length > 0) {
    signals.push(createSignal(
      turnNumber,
      'file_touched',
      `Touched ${filesTouched.length} file(s)`,
      filesTouched
    ));
  }

  // Store full turn context for LLM analysis (no truncation)
  if (userPrompt.trim().length > 10 || assistantResponse.trim().length > 10) {
    signals.push(createSignal(
      turnNumber,
      'turn_context',
      `User: ${userPrompt}\n\nAssistant: ${assistantResponse}`,
      filesTouched
    ));
  }

  return signals;
}
