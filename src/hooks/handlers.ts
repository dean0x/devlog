/**
 * Hook Handlers Module
 *
 * TypeScript implementations of Claude Code hook handlers.
 * Called via CLI commands: devlog hook:post-tool-use, devlog hook:stop
 *
 * This provides a stable API for hooks - internal implementation
 * can change without breaking user configuration.
 */

import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { enqueueEvent, initQueue } from '../storage/queue.js';
import { getGlobalQueueDir, initGlobalDirs, isGlobalInitialized } from '../paths.js';
import type { Result } from '../types/index.js';

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
  return `/tmp/devlog-files-${sessionId}`;
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
 * Reads transcript, gets files from buffer, queues turn_complete event,
 * and clears the buffer.
 *
 * Environment:
 *   CLAUDE_SESSION_ID - Session identifier
 *   CLAUDE_TRANSCRIPT_PATH - Path to session transcript (JSONL)
 *
 * Stdin (optional):
 *   { "transcript_path": "/path/to/transcript.jsonl" }
 */
export async function handleStop(): Promise<Result<void, Error>> {
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

    // Initialize queue
    const queueDir = getGlobalQueueDir();
    const initResult = await initQueue({ baseDir: queueDir });
    if (!initResult.ok) {
      return {
        ok: false,
        error: new Error(`Failed to initialize queue: ${initResult.error.message}`),
      };
    }

    // Enqueue turn_complete event
    const result = await enqueueEvent(
      {
        event_type: 'turn_complete',
        session_id: sessionId,
        project_path: resolve(projectPath),
        user_prompt: turnData.user_prompt,
        assistant_response: turnData.assistant_response,
        files_touched: filesTouched,
      },
      { baseDir: queueDir }
    );

    if (!result.ok) {
      return {
        ok: false,
        error: new Error(`Failed to enqueue event: ${result.error.message}`),
      };
    }

    // Log success (visible in Claude Code hook output)
    console.log(`Enqueued event: ${result.value}`);

    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}
