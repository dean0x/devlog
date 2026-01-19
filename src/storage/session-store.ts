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
 * Get or create a session for the given session ID
 */
export async function getOrCreateSession(
  config: SessionStoreConfig,
  sessionId: string,
  projectPath: string
): Promise<Result<SessionAccumulator, StorageError>> {
  const readResult = await readSession(config, sessionId);
  if (!readResult.ok) {
    return readResult;
  }

  if (readResult.value !== null) {
    return Ok(readResult.value);
  }

  // Create new session
  const session = createSession(sessionId, projectPath);
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
 * ARCHITECTURE: Simple heuristic extraction of signals
 * Pattern: Look for decision markers, problems, goals in the response
 */
export function extractSignalsFromTurn(
  turnNumber: number,
  userPrompt: string,
  assistantResponse: string,
  filesTouched: readonly string[]
): SessionSignal[] {
  const signals: SessionSignal[] = [];

  // Always record files touched as a signal
  if (filesTouched.length > 0) {
    signals.push(createSignal(
      turnNumber,
      'file_touched',
      `Touched ${filesTouched.length} file(s)`,
      filesTouched
    ));
  }

  // Look for decision patterns in the response
  const decisionPatterns = [
    /(?:decided|choosing|using|went with|opted for|selected)\s+(.{10,100})/gi,
    /(?:because|since|due to|reason:?)\s+(.{10,100})/gi,
  ];

  for (const pattern of decisionPatterns) {
    const matches = assistantResponse.matchAll(pattern);
    for (const match of matches) {
      const content = match[1]?.trim();
      if (content && content.length > 20) {
        signals.push(createSignal(
          turnNumber,
          'decision_made',
          content.slice(0, 200),
          filesTouched
        ));
        break; // Only one decision per pattern
      }
    }
  }

  // Look for problem patterns
  const problemPatterns = [
    /(?:issue|problem|bug|error|warning|failed|broken)[:.]?\s+(.{10,100})/gi,
    /(?:doesn't work|not working|failing|crashed|broke)\s*(.{0,100})/gi,
  ];

  for (const pattern of problemPatterns) {
    const matches = userPrompt.matchAll(pattern);
    for (const match of matches) {
      const content = match[1]?.trim() || match[0];
      if (content && content.length > 10) {
        signals.push(createSignal(
          turnNumber,
          'problem_discovered',
          content.slice(0, 200)
        ));
        break;
      }
    }
  }

  // Look for goal patterns in user prompt
  const goalPatterns = [
    /(?:implement|add|create|build|fix|update|refactor)\s+(.{10,100})/gi,
    /(?:i want to|need to|trying to|working on)\s+(.{10,100})/gi,
  ];

  for (const pattern of goalPatterns) {
    const matches = userPrompt.matchAll(pattern);
    for (const match of matches) {
      const content = match[1]?.trim();
      if (content && content.length > 15) {
        signals.push(createSignal(
          turnNumber,
          'goal_stated',
          content.slice(0, 200)
        ));
        break;
      }
    }
  }

  return signals;
}
