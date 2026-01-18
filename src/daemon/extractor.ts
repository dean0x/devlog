/**
 * Memory Extractor
 *
 * ARCHITECTURE: Spawns Claude Code in headless mode to extract concise memos
 * Pattern: Uses prompt engineering to get structured JSON output
 *
 * The extractor:
 * 1. Takes a single turn event (user prompt + assistant response + files)
 * 2. Loads existing memo context (gradual attention mechanism)
 * 3. Acquires extraction lock (only one Claude instance at a time)
 * 4. Builds context-aware extraction prompt
 * 5. Spawns `claude -p` with ANTHROPIC_BASE_URL pointing to proxy
 * 6. Parses decision JSON (create, update, or skip)
 */

import { spawn } from 'node:child_process';
import type {
  QueuedEvent,
  MemoryEntry,
  ExtractionResult,
  ExtractedMemo,
  ExtractionDecision,
  MemoContext,
  AttentionConfig,
  LongTermMemory,
  Result,
  DaemonError,
  MemoryType,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';
import {
  readShortTermMemory,
  readAllLongTermMemories,
  type MemoryStoreConfig,
} from '../storage/memory-store.js';

export interface ExtractorConfig {
  readonly proxyUrl: string;
  readonly timeout: number;
}

// ============================================================================
// Extraction Lock - Ensures only one Claude instance at a time
// ============================================================================

/**
 * ARCHITECTURE: Simple promise-based mutex for extraction
 * Pattern: Prevents resource contention when multiple batches overlap
 */
let extractionLock: Promise<void> = Promise.resolve();

async function withExtractionLock<T>(fn: () => Promise<T>): Promise<T> {
  const previousLock = extractionLock;
  let releaseLock: () => void;
  extractionLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;
  try {
    return await fn();
  } finally {
    releaseLock!();
  }
}

// ============================================================================
// Default Attention Configuration
// ============================================================================

const DEFAULT_ATTENTION_CONFIG: AttentionConfig = {
  longTermLimit: 10,
  thisWeekLimit: 5,
  todayLimit: 3,
};

// ============================================================================
// Legacy Extraction Prompt (without context)
// ============================================================================

const EXTRACTION_PROMPT = `You are a developer's second brain. Create a concise memo from this interaction.

USER ASKED:
{user_prompt}

ASSISTANT DID:
{assistant_response}

FILES INVOLVED:
{files_touched}

Create ONE memo if this interaction is worth remembering. Output JSON:
{
  "memo": {
    "type": "goal|decision|problem|context|insight",
    "title": "One-line summary (max 80 chars)",
    "content": "2-3 sentences max. What matters for future context?",
    "files": ["relevant", "files"],
    "tags": ["optional", "tags"]
  }
}

If this interaction is trivial (typo fix, minor query, simple question), return:
{ "memo": null }

RULES:
- Be concise. Memos should be scannable in seconds.
- Focus on WHY and WHAT WAS DECIDED, not implementation details
- Capture decisions and rationale, not actions
- If unsure whether to include, don't
- One memo per turn maximum

Memory types:
- goal: Current objective being worked on
- decision: Choice made with rationale
- problem: Issue discovered that needs attention
- context: Work-in-progress state
- insight: Learning about the codebase or patterns

OUTPUT ONLY VALID JSON, NO EXPLANATION:`;

/**
 * Build the prompt for memo extraction from a turn event
 */
function buildExtractionPrompt(event: QueuedEvent): string {
  const filesStr = event.files_touched.length > 0
    ? event.files_touched.join('\n')
    : '(none)';

  return EXTRACTION_PROMPT
    .replace('{user_prompt}', event.user_prompt)
    .replace('{assistant_response}', event.assistant_response)
    .replace('{files_touched}', filesStr);
}

/**
 * Parse the extraction response into a memo (or null)
 */
function parseExtractionResponse(response: string): Result<ExtractionResult, DaemonError> {
  // Try to find JSON in the response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return Err({
      type: 'extraction_error',
      message: 'No valid JSON found in extraction response',
    });
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      memo?: {
        type?: string;
        title?: string;
        content?: string;
        files?: string[];
        tags?: string[];
      } | null;
    };

    // Handle null memo (trivial interaction)
    if (parsed.memo === null) {
      return Ok({ memo: null });
    }

    if (!parsed.memo) {
      return Err({
        type: 'extraction_error',
        message: 'Response missing memo field',
      });
    }

    const validTypes: MemoryType[] = ['goal', 'decision', 'problem', 'context', 'insight'];
    const type = validTypes.includes(parsed.memo.type as MemoryType)
      ? (parsed.memo.type as MemoryType)
      : 'context';

    if (!parsed.memo.title || !parsed.memo.content) {
      return Err({
        type: 'extraction_error',
        message: 'Memo missing required title or content',
      });
    }

    const memo: ExtractedMemo = {
      type,
      title: String(parsed.memo.title).slice(0, 80),
      content: String(parsed.memo.content).slice(0, 500),
      files: Array.isArray(parsed.memo.files)
        ? parsed.memo.files.filter((f): f is string => typeof f === 'string').slice(0, 10)
        : [],
      tags: Array.isArray(parsed.memo.tags)
        ? parsed.memo.tags.filter((t): t is string => typeof t === 'string').slice(0, 10)
        : undefined,
    };

    return Ok({ memo });
  } catch (error) {
    return Err({
      type: 'extraction_error',
      message: `Failed to parse extraction response: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

/**
 * Run Claude Code in headless mode for extraction
 */
async function runClaudeExtraction(
  prompt: string,
  config: ExtractorConfig
): Promise<Result<string, DaemonError>> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: config.proxyUrl,
    };

    const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve(Err({
          type: 'extraction_error',
          message: `Claude exited with code ${code}: ${stderr}`,
        }));
        return;
      }

      resolve(Ok(stdout));
    });

    child.on('error', (error) => {
      resolve(Err({
        type: 'extraction_error',
        message: `Failed to spawn Claude: ${error.message}`,
      }));
    });
  });
}

/**
 * Fallback extraction without Claude (simple heuristics)
 * Used when proxy/Claude isn't available
 */
function fallbackExtraction(event: QueuedEvent): ExtractionResult {
  // Only create memos for substantial interactions
  if (event.user_prompt.length < 20 && event.assistant_response.length < 100) {
    return { memo: null };
  }

  // Skip trivial queries
  const trivialPatterns = [
    /^(fix|typo|rename|update|change)/i,
    /^(what|how|where|why|when|who|which) (is|are|does|do|did|was|were)/i,
    /^(run|execute|show|list|display|print)/i,
  ];

  for (const pattern of trivialPatterns) {
    if (pattern.test(event.user_prompt.trim())) {
      return { memo: null };
    }
  }

  // Create a basic context memo
  const title = event.user_prompt.slice(0, 80).replace(/\n/g, ' ');
  const content = event.assistant_response.slice(0, 200).replace(/\n/g, ' ');

  const memo: ExtractedMemo = {
    type: 'context',
    title,
    content: content.length > 0 ? content : 'Working on task',
    files: [...event.files_touched],
  };

  return { memo };
}

/**
 * Convert an extracted memo to a memory entry for storage
 */
export function memoToMemoryEntry(memo: ExtractedMemo): MemoryEntry {
  return {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    type: memo.type,
    title: memo.title,
    content: memo.content,
    confidence: 0.8, // Fixed confidence for extracted memos
    files: memo.files.length > 0 ? memo.files : undefined,
    tags: memo.tags,
  };
}

/**
 * Extract a memo from a single turn event
 */
export async function extractMemo(
  event: QueuedEvent,
  config: ExtractorConfig
): Promise<Result<ExtractionResult, DaemonError>> {
  // Try Claude extraction first
  const prompt = buildExtractionPrompt(event);
  const claudeResult = await runClaudeExtraction(prompt, config);

  if (claudeResult.ok) {
    const parseResult = parseExtractionResponse(claudeResult.value);
    if (parseResult.ok) {
      return parseResult;
    }
    console.warn('Failed to parse Claude response, using fallback:', parseResult.error.message);
  } else {
    console.warn('Claude extraction failed, using fallback:', claudeResult.error.message);
  }

  // Fallback to simple heuristic extraction
  return Ok(fallbackExtraction(event));
}

/**
 * Legacy function for batch extraction (delegates to single extraction)
 * @deprecated Use extractMemo for single turn extraction
 */
export async function extractMemories(
  events: readonly QueuedEvent[],
  config: ExtractorConfig
): Promise<Result<{ memories: readonly MemoryEntry[] }, DaemonError>> {
  if (events.length === 0) {
    return Ok({ memories: [] });
  }

  const memories: MemoryEntry[] = [];

  for (const event of events) {
    const result = await extractMemo(event, config);
    if (result.ok && result.value.memo) {
      memories.push(memoToMemoryEntry(result.value.memo));
    }
  }

  return Ok({ memories });
}

// ============================================================================
// Context-Aware Extraction (New)
// ============================================================================

const CONTEXT_AWARE_PROMPT = `You are a developer's memory system. Review this turn WITH existing context.

## EXISTING MEMORY CONTEXT

### Long-term patterns (established):
{long_term_context}

### This week's memos (recent):
{this_week_context}

### Today's memos (current session):
{today_context}

---

## NEW TURN TO EVALUATE

USER: {user_prompt}

ASSISTANT: {assistant_response}

FILES: {files_touched}

---

## YOUR TASK

Review this turn considering existing memos. Decide:

1. **CREATE** - New significant information not captured
2. **UPDATE** - Refines/supersedes an existing memo (provide memo ID)
3. **SKIP** - Trivial, already captured, or not worth remembering

Output JSON:
{
  "action": "create|update|skip",
  "memo": { "type": "goal|decision|problem|context|insight", "title": "One-line summary (max 80 chars)", "content": "2-3 sentences max", "files": ["relevant", "files"] },
  "updateTarget": "memo-id-if-updating",
  "updateFields": { "content": "refined content" },
  "reasoning": "Brief explanation"
}

RULES:
- Prefer UPDATE over CREATE if this refines existing context
- SKIP trivial interactions (typos, simple queries, minor edits)
- CREATE only for genuinely new decisions, goals, or insights
- Focus on WHY and WHAT WAS DECIDED, not implementation details

Memory types:
- goal: Current objective being worked on
- decision: Choice made with rationale
- problem: Issue discovered that needs attention
- context: Work-in-progress state
- insight: Learning about the codebase or patterns

OUTPUT ONLY VALID JSON, NO EXPLANATION:`;

/**
 * Format long-term memories for context
 */
function formatLongTermContext(memories: readonly LongTermMemory[]): string {
  if (memories.length === 0) {
    return '(none established yet)';
  }
  return memories
    .map((m) => `- [${m.category}] ${m.title}: ${m.content.slice(0, 100)}...`)
    .join('\n');
}

/**
 * Format short-term memories for context
 */
function formatShortTermContext(memories: readonly MemoryEntry[]): string {
  if (memories.length === 0) {
    return '(none)';
  }
  return memories
    .map((m) => `- [${m.id}] (${m.type}) ${m.title}: ${m.content.slice(0, 80)}...`)
    .join('\n');
}

/**
 * Load existing memo context for extraction
 */
async function loadMemoContext(
  memoryDir: string,
  config: AttentionConfig = DEFAULT_ATTENTION_CONFIG
): Promise<MemoContext> {
  const storeConfig: MemoryStoreConfig = { baseDir: memoryDir };

  // Load all sources in parallel
  const [longTermResult, weekResult, todayResult] = await Promise.all([
    readAllLongTermMemories(storeConfig),
    readShortTermMemory(storeConfig, 'this-week'),
    readShortTermMemory(storeConfig, 'today'),
  ]);

  return {
    longTerm: longTermResult.ok
      ? longTermResult.value.slice(0, config.longTermLimit)
      : [],
    thisWeek: weekResult.ok
      ? weekResult.value.memories.slice(-config.thisWeekLimit)
      : [],
    today: todayResult.ok
      ? todayResult.value.memories.slice(-config.todayLimit)
      : [],
  };
}

/**
 * Build the context-aware prompt for extraction
 */
function buildContextAwarePrompt(event: QueuedEvent, context: MemoContext): string {
  const filesStr =
    event.files_touched.length > 0 ? event.files_touched.join('\n') : '(none)';

  return CONTEXT_AWARE_PROMPT.replace(
    '{long_term_context}',
    formatLongTermContext(context.longTerm)
  )
    .replace('{this_week_context}', formatShortTermContext(context.thisWeek))
    .replace('{today_context}', formatShortTermContext(context.today))
    .replace('{user_prompt}', event.user_prompt)
    .replace('{assistant_response}', event.assistant_response)
    .replace('{files_touched}', filesStr);
}

/**
 * Parse the context-aware extraction decision
 */
function parseExtractionDecision(
  response: string
): Result<ExtractionDecision, DaemonError> {
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return Err({
      type: 'extraction_error',
      message: 'No valid JSON found in extraction response',
    });
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      action?: string;
      memo?: {
        type?: string;
        title?: string;
        content?: string;
        files?: string[];
        tags?: string[];
      };
      updateTarget?: string;
      updateFields?: {
        title?: string;
        content?: string;
        files?: string[];
        tags?: string[];
      };
      reasoning?: string;
    };

    const action = ['create', 'update', 'skip'].includes(parsed.action ?? '')
      ? (parsed.action as 'create' | 'update' | 'skip')
      : 'skip';

    const reasoning = String(parsed.reasoning ?? 'No reasoning provided');

    // For skip action, return minimal decision
    if (action === 'skip') {
      return Ok({ action, reasoning });
    }

    // For update action, validate target
    if (action === 'update') {
      if (!parsed.updateTarget) {
        return Err({
          type: 'extraction_error',
          message: 'Update action requires updateTarget',
        });
      }

      return Ok({
        action,
        updateTarget: String(parsed.updateTarget),
        updateFields: parsed.updateFields
          ? {
              ...(parsed.updateFields.title !== undefined && {
                title: String(parsed.updateFields.title).slice(0, 80),
              }),
              ...(parsed.updateFields.content !== undefined && {
                content: String(parsed.updateFields.content).slice(0, 500),
              }),
              ...(parsed.updateFields.files !== undefined && {
                files: Array.isArray(parsed.updateFields.files)
                  ? parsed.updateFields.files
                      .filter((f): f is string => typeof f === 'string')
                      .slice(0, 10)
                  : undefined,
              }),
              ...(parsed.updateFields.tags !== undefined && {
                tags: Array.isArray(parsed.updateFields.tags)
                  ? parsed.updateFields.tags
                      .filter((t): t is string => typeof t === 'string')
                      .slice(0, 10)
                  : undefined,
              }),
            }
          : undefined,
        reasoning,
      });
    }

    // For create action, validate memo
    if (!parsed.memo || !parsed.memo.title || !parsed.memo.content) {
      return Err({
        type: 'extraction_error',
        message: 'Create action requires memo with title and content',
      });
    }

    const validTypes: MemoryType[] = [
      'goal',
      'decision',
      'problem',
      'context',
      'insight',
    ];
    const type = validTypes.includes(parsed.memo.type as MemoryType)
      ? (parsed.memo.type as MemoryType)
      : 'context';

    const memo: ExtractedMemo = {
      type,
      title: String(parsed.memo.title).slice(0, 80),
      content: String(parsed.memo.content).slice(0, 500),
      files: Array.isArray(parsed.memo.files)
        ? parsed.memo.files
            .filter((f): f is string => typeof f === 'string')
            .slice(0, 10)
        : [],
      tags: Array.isArray(parsed.memo.tags)
        ? parsed.memo.tags
            .filter((t): t is string => typeof t === 'string')
            .slice(0, 10)
        : undefined,
    };

    return Ok({ action, memo, reasoning });
  } catch (error) {
    return Err({
      type: 'extraction_error',
      message: `Failed to parse extraction decision: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

/**
 * Fallback decision when extraction fails
 */
function fallbackDecision(event: QueuedEvent): ExtractionDecision {
  const legacyResult = fallbackExtraction(event);

  if (legacyResult.memo === null) {
    return {
      action: 'skip',
      reasoning: 'Fallback: Trivial interaction',
    };
  }

  return {
    action: 'create',
    memo: legacyResult.memo,
    reasoning: 'Fallback: Claude extraction unavailable',
  };
}

/**
 * Extract a memo with context awareness
 *
 * ARCHITECTURE: Main entry point for context-aware extraction
 * Pattern: Loads context, acquires lock, runs Claude, applies decision
 */
export async function extractMemoWithContext(
  event: QueuedEvent,
  memoryDir: string,
  config: ExtractorConfig
): Promise<Result<ExtractionDecision, DaemonError>> {
  return withExtractionLock(async () => {
    // 1. Load existing context
    const context = await loadMemoContext(memoryDir, DEFAULT_ATTENTION_CONFIG);

    // 2. Build context-aware prompt
    const prompt = buildContextAwarePrompt(event, context);

    // 3. Run Claude extraction
    const claudeResult = await runClaudeExtraction(prompt, config);
    if (!claudeResult.ok) {
      console.warn(
        'Claude extraction failed, using fallback:',
        claudeResult.error.message
      );
      return Ok(fallbackDecision(event));
    }

    // 4. Parse decision
    const decisionResult = parseExtractionDecision(claudeResult.value);
    if (!decisionResult.ok) {
      console.warn(
        'Failed to parse extraction decision, using fallback:',
        decisionResult.error.message
      );
      return Ok(fallbackDecision(event));
    }

    return Ok(decisionResult.value);
  });
}
