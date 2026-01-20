/**
 * Hook Handlers Module
 *
 * TypeScript implementations of Claude Code hook handlers.
 * Called via CLI commands: devlog hook:post-tool-use, devlog hook:stop
 *
 * This provides a stable API for hooks - internal implementation
 * can change without breaking user configuration.
 */

import { promises as fs, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  initSessionStore,
  appendSignalAndPersist,
  extractSignalsFromTurn,
  type SessionStoreConfig,
} from '../storage/session-store.js';
import {
  getProjectMemoryDir,
  initGlobalDirs,
  isGlobalInitialized,
  cleanupLegacyMemory,
  registerProject,
} from '../paths.js';
import { markCatchUpDirty } from '../catch-up/precomputed-store.js';
import type { Result } from '../types/index.js';

// ============================================================================
// Extraction Detection - Prevents hook feedback loop
// ============================================================================

/**
 * Marker file created by daemon during extraction.
 * Must match EXTRACTION_MARKER in extractor.ts
 */
const EXTRACTION_MARKER = join(tmpdir(), 'devlog-extraction-active');

/**
 * Check if daemon extraction is in progress
 *
 * ARCHITECTURE: Uses filesystem marker instead of environment variables
 * because Claude Code spawns hooks as separate subprocesses that do not
 * inherit the parent Claude process's environment variables.
 */
function isExtractionInProgress(): boolean {
  return existsSync(EXTRACTION_MARKER);
}

// ============================================================================
// Types
// ============================================================================

interface PostToolUseInput {
  readonly tool_name?: string;
  readonly tool_input?: {
    readonly file_path?: string;
  };
}

interface StopInput {
  readonly transcript_path?: string;
}

interface TranscriptMessage {
  readonly type: 'user' | 'assistant';
  readonly message?: {
    readonly role?: string;
    readonly content?: string | readonly ContentBlock[];
  };
  readonly content?: string | readonly ContentBlock[];
}

interface ContentBlock {
  readonly type: 'text' | 'tool_use' | 'tool_result';
  readonly text?: string;
}

interface ParsedTurn {
  readonly user_prompt: string;
  readonly assistant_response: string;
}

// ============================================================================
// Helpers
// ============================================================================

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

function getBufferFilePath(sessionId: string): string {
  return join(tmpdir(), `devlog-files-${sessionId}`);
}

async function ensureGlobalInit(): Promise<void> {
  const initialized = await isGlobalInitialized();
  if (initialized) return;

  const result = await initGlobalDirs();
  if (!result.ok) {
    throw new Error(`Failed to initialize global directories: ${result.error.message}`);
  }
}

/**
 * Extract text content from a message
 */
function extractText(content: string | readonly ContentBlock[] | undefined): string {
  if (!content) return '';

  if (typeof content === 'string') {
    return content;
  }

  // Filter to text blocks only, skip tool_use and tool_result
  return content
    .filter((block): block is ContentBlock & { text: string } =>
      block.type === 'text' && typeof block.text === 'string'
    )
    .map(block => block.text)
    .join('\n');
}

/**
 * Read last N lines of a file efficiently
 */
async function readLastLines(filePath: string, maxLines: number = 100): Promise<string[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  return lines.slice(-maxLines);
}

/**
 * Parse the transcript and find the last user/assistant turn
 */
async function parseTranscript(transcriptPath: string): Promise<ParsedTurn> {
  const lines = await readLastLines(transcriptPath);

  let lastUserPrompt = '';
  let lastAssistantResponse = '';

  // Parse lines in order, keeping track of the last user and assistant messages
  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as TranscriptMessage;

      if (entry.type === 'user') {
        const content = entry.message?.content ?? entry.content;
        const text = extractText(content);
        if (text) {
          lastUserPrompt = text;
          // Reset assistant response when we see a new user message
          lastAssistantResponse = '';
        }
      } else if (entry.type === 'assistant') {
        const content = entry.message?.content ?? entry.content;
        const text = extractText(content);
        if (text) {
          // Append to assistant response (may be multiple assistant entries)
          lastAssistantResponse += (lastAssistantResponse ? '\n' : '') + text;
        }
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // Truncate for reasonable memo extraction
  const MAX_PROMPT_LENGTH = 2000;
  const MAX_RESPONSE_LENGTH = 4000;

  return {
    user_prompt: lastUserPrompt.slice(0, MAX_PROMPT_LENGTH),
    assistant_response: lastAssistantResponse.slice(0, MAX_RESPONSE_LENGTH),
  };
}

// ============================================================================
// Hook Handlers
// ============================================================================

/**
 * Handle PostToolUse hook - track file paths from Edit/Write
 *
 * Reads stdin JSON with tool execution details, extracts file_path from
 * tool_input, and appends to a session-specific buffer file.
 *
 * Environment:
 *   CLAUDE_SESSION_ID - Session identifier for buffer file isolation
 *
 * Stdin:
 *   { "tool_name": "Edit", "tool_input": { "file_path": "/path/to/file.ts" } }
 */
export async function handlePostToolUse(): Promise<Result<void, Error>> {
  // Skip if daemon extraction is in progress to prevent feedback loop
  if (isExtractionInProgress()) {
    return { ok: true, value: undefined };
  }

  try {
    const stdinData = await readStdin();

    // Skip if no data
    if (!stdinData.trim()) {
      return { ok: true, value: undefined };
    }

    // Parse input
    let input: PostToolUseInput;
    try {
      input = JSON.parse(stdinData) as PostToolUseInput;
    } catch {
      // Silent failure - don't break Claude Code on malformed input
      return { ok: true, value: undefined };
    }

    // Extract file path
    const filePath = input.tool_input?.file_path;
    if (!filePath) {
      return { ok: true, value: undefined };
    }

    // Get session ID from environment
    const sessionId = process.env['CLAUDE_SESSION_ID'] ?? 'unknown';
    const bufferFile = getBufferFilePath(sessionId);

    // Append file path to buffer
    await fs.appendFile(bufferFile, filePath + '\n');

    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

/**
 * Handle Stop hook - extract memo from turn
 *
 * Reads transcript, gets files from buffer, and either:
 * - (legacy) Queues turn_complete event for per-turn extraction
 * - (new) Accumulates signals to session buffer for consolidation
 *
 * Environment:
 *   CLAUDE_SESSION_ID - Session identifier
 *   CLAUDE_TRANSCRIPT_PATH - Path to session transcript (JSONL)
 *
 * Stdin (optional):
 *   { "transcript_path": "/path/to/transcript.jsonl" }
 */
export async function handleStop(): Promise<Result<void, Error>> {
  // Skip if daemon extraction is in progress to prevent feedback loop
  if (isExtractionInProgress()) {
    return { ok: true, value: undefined };
  }

  try {
    const sessionId = process.env['CLAUDE_SESSION_ID'] ?? 'unknown';
    const projectPath = process.cwd();

    // Get transcript path from environment first
    let transcriptPath = process.env['CLAUDE_TRANSCRIPT_PATH'] ?? '';

    // Only read stdin if we don't have transcript path from env and stdin is piped
    if (!transcriptPath && !process.stdin.isTTY) {
      const stdinData = await readStdin();
      if (stdinData.trim()) {
        try {
          const input = JSON.parse(stdinData) as StopInput;
          transcriptPath = input.transcript_path ?? '';
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Skip if no transcript path
    if (!transcriptPath) {
      return { ok: true, value: undefined };
    }

    // Read and clear file buffer
    const bufferFile = getBufferFilePath(sessionId);
    let filesTouched: string[] = [];

    try {
      const bufferContent = await fs.readFile(bufferFile, 'utf-8');
      const lines = bufferContent.trim().split('\n').filter(l => l.length > 0);
      // Deduplicate files
      filesTouched = [...new Set(lines)];
      // Clear buffer
      await fs.unlink(bufferFile);
    } catch {
      // Buffer file doesn't exist - no files were touched
    }

    // Parse transcript
    let turnData: ParsedTurn;
    try {
      turnData = await parseTranscript(transcriptPath);
    } catch {
      turnData = { user_prompt: '', assistant_response: '' };
    }

    // Skip if no meaningful content
    if (!turnData.user_prompt) {
      return { ok: true, value: undefined };
    }

    // Auto-initialize global dirs if needed
    await ensureGlobalInit();

    const memoryDir = getProjectMemoryDir(resolve(projectPath));

    // Clean up legacy memory structure on first run (silent)
    await cleanupLegacyMemory(resolve(projectPath));

    const sessionStoreConfig: SessionStoreConfig = { memoryDir };

    // Initialize session store
    await initSessionStore(sessionStoreConfig);

    // Get turn number from session (we estimate based on signal count)
    // In practice, this is incremented each time we add signals
    const turnNumber = Date.now(); // Use timestamp as unique turn identifier

    // Extract signals from turn
    const signals = extractSignalsFromTurn(
      turnNumber,
      turnData.user_prompt,
      turnData.assistant_response,
      filesTouched
    );

    // Append signals to session buffer
    for (const signal of signals) {
      const appendResult = await appendSignalAndPersist(
        sessionStoreConfig,
        sessionId,
        resolve(projectPath),
        signal
      );

      if (!appendResult.ok) {
        console.warn(`Failed to append signal: ${appendResult.error.message}`);
      }
    }

    // Mark catch-up as dirty so daemon will recompute summary
    if (signals.length > 0) {
      await markCatchUpDirty(memoryDir);
      // Register project with daemon for discovery
      await registerProject(projectPath);
      console.log(`Accumulated ${signals.length} signals`);
    }

    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
