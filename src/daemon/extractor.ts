/**
 * Session Knowledge Extractor
 *
 * ARCHITECTURE: Direct ollama-js calls for session consolidation
 * Pattern: Uses prompt engineering to get structured JSON output
 *
 * The extractor:
 * 1. Takes a session with accumulated signals
 * 2. Loads existing knowledge context
 * 3. Acquires per-project lock (allows parallel extraction across projects)
 * 4. Builds session consolidation prompt
 * 5. Calls Ollama directly via ollama-js
 * 6. Parses decision JSON (create, extend, confirm, or skip)
 */

import { Ollama } from 'ollama';

import type { Result, DaemonError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';
import type { SessionAccumulator, SessionSignal } from '../types/session.js';
import type {
  KnowledgeSection,
  KnowledgeCategory,
  KnowledgeStoreConfig,
} from '../storage/knowledge-store.js';
import { readAllKnowledge } from '../storage/knowledge-store.js';
import { createDebugWriter } from './debug-writer.js';

// ============================================================================
// Debug Logging
// ============================================================================

function debugLog(msg: string, data?: Record<string, unknown>): void {
  if (process.env['DEVLOG_DEBUG'] !== '1') return;

  const timestamp = new Date().toTimeString().slice(0, 8);
  let dataStr = '';
  if (data) {
    const pairs = Object.entries(data).map(([k, v]) => {
      const str = v === undefined ? 'undefined' : (typeof v === 'string' ? v : JSON.stringify(v) ?? 'null');
      return `${k}=${str.length > 100 ? str.slice(0, 97) + '...' : str}`;
    });
    dataStr = pairs.length > 0 ? ` (${pairs.join(', ')})` : '';
  }
  console.log(`[${timestamp}] [DEBUG] [extractor] ${msg}${dataStr}`);
}

export interface ExtractorConfig {
  readonly ollamaUrl: string;
  readonly model: string;
  readonly timeout?: number;
}

// ============================================================================
// Extraction Lock - Per-project mutex for Ollama calls
// ============================================================================

/**
 * ARCHITECTURE: Per-project promise-based mutex for extraction
 * Pattern: Prevents resource contention within a project while allowing
 * parallel extraction across different projects
 */
const projectLocks = new Map<string, Promise<void>>();

async function withProjectLock<T>(
  projectPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const currentLock = projectLocks.get(projectPath) ?? Promise.resolve();

  // Deferred promise pattern: we need a promise we can resolve externally
  // so that subsequent callers can chain after this operation completes.
  // The releaseLock function is captured in the finally block and called
  // when this operation finishes, allowing the next queued operation to proceed.
  let releaseLock: () => void = () => {};
  const newLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  // Chain after current lock for this project
  const execution = currentLock.then(fn);

  // Set new lock before awaiting (other callers will queue behind it)
  projectLocks.set(projectPath, newLock);

  try {
    return await execution;
  } finally {
    releaseLock();
    // Clean up if this is still the current lock
    if (projectLocks.get(projectPath) === newLock) {
      projectLocks.delete(projectPath);
    }
  }
}

// ============================================================================
// Ollama Communication
// ============================================================================

/**
 * Extract the first complete JSON object from a response string.
 * Handles models that output <think>...</think> or other text around JSON.
 */
function extractJsonFromResponse(response: string): string | null {
  const startIdx = response.indexOf('{');
  if (startIdx === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < response.length; i++) {
    const char = response[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    // At this point, escape is always false (if it was true, we continued above)
    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          return response.slice(startIdx, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Run extraction through Ollama using ollama-js
 */
async function runOllamaExtraction(
  prompt: string,
  config: ExtractorConfig
): Promise<Result<string, DaemonError>> {
  try {
    debugLog('Creating Ollama client', { url: config.ollamaUrl, model: config.model });

    const ollama = new Ollama({ host: config.ollamaUrl });

    debugLog('Sending chat request');
    const response = await ollama.chat({
      model: config.model,
      messages: [
        {
          role: 'system',
          content: 'You are a knowledge consolidation system. Output only valid JSON.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      options: {
        temperature: 0.3,
        // No num_predict limit - local Ollama has no cost, let model complete naturally
      },
    });

    const content = response.message?.content ?? '';
    debugLog('Received response', { length: content.length });
    return Ok(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    debugLog('Ollama request failed', { error: message });
    return Err({
      type: 'extraction_error',
      message: `Ollama request failed: ${message}`,
    });
  }
}

// ============================================================================
// Session Consolidation Types
// ============================================================================

/**
 * Session consolidation action types
 */
export type SessionConsolidationAction =
  | 'create_section'   // Create new knowledge section
  | 'extend_section'   // Add detail to existing section
  | 'add_example'      // Add concrete example to section
  | 'confirm_pattern'  // Reinforce existing (no content change)
  | 'flag_contradiction' // Conflicts with existing knowledge
  | 'skip';            // No valuable knowledge

/**
 * Session consolidation decision
 */
export interface SessionConsolidationDecision {
  readonly action: SessionConsolidationAction;
  readonly category?: KnowledgeCategory;
  readonly section_id?: string;
  readonly new_section?: {
    readonly title: string;
    readonly content: string;
    readonly tags?: readonly string[];
    readonly examples?: readonly string[];
  };
  readonly extension?: {
    readonly additional_content: string;
    readonly new_examples?: readonly string[];
  };
  readonly reasoning: string;
}

// ============================================================================
// Session Consolidation Prompt
// ============================================================================

/**
 * Session consolidation prompt
 *
 * ARCHITECTURE: Session-level analysis instead of per-turn
 * Pattern: "How does this session update my understanding?"
 */
const SESSION_CONSOLIDATION_PROMPT = `You are a developer's knowledge consolidation system.

## EXISTING KNOWLEDGE

{existing_knowledge}

---

## SESSION TO CONSOLIDATE

Project: {project_path}
Duration: {turn_count} turns
Files touched: {files_touched}

### Session turns (raw context for your analysis):

{signals}

---

## YOUR TASK

Analyze this session and decide how it updates the project's knowledge base.

**Decision types:**

1. **create_section** - Genuinely new knowledge not captured anywhere
2. **extend_section** - Add detail/context to existing section
3. **add_example** - Add a concrete example to existing section
4. **confirm_pattern** - Session confirms existing knowledge (just note it)
5. **flag_contradiction** - Session conflicts with existing knowledge
6. **skip** - No valuable knowledge in this session

Output JSON:
{
  "action": "create_section|extend_section|add_example|confirm_pattern|flag_contradiction|skip",
  "category": "conventions|architecture|decisions|gotchas",
  "section_id": "existing-section-id-if-updating",
  "new_section": {
    "title": "Clear, specific title",
    "content": "Detailed explanation with rationale. Focus on WHY.",
    "tags": ["relevant", "tags"],
    "examples": ["Concrete example 1", "Concrete example 2"]
  },
  "extension": {
    "additional_content": "New detail to add",
    "new_examples": ["New example"]
  },
  "reasoning": "Why this decision?"
}

## CRITICAL CONSTRAINTS

- **category** is REQUIRED for create_section, extend_section, add_example
- **section_id** must be EXACTLY one of the IDs listed above (if extending)
- If you cannot find a matching section_id, use create_section or skip instead
- Valid categories are: conventions, architecture, decisions, gotchas

## QUALITY GUIDELINES

### GOOD knowledge (worth capturing):
- "Using Result<T,E> pattern for error handling because it makes errors explicit and prevents forgotten error cases"
- "API endpoints follow REST conventions with /api/v1 prefix - discovered from existing routes"
- "Race condition in checkout: two concurrent requests can both pass inventory check"

### NOT knowledge (skip these):
- "Made some code changes" (too vague)
- "Fixed a bug" (no insight about what/why)
- "User asked a question" (just conversation)
- Sessions with only file edits and no meaningful decisions or insights

## RULES
- PREFER extending/confirming existing knowledge over creating new
- Only CREATE new if genuinely novel insight
- SKIP if session is just routine coding without decisions
- Content must explain WHY, not just WHAT
- flag_contradiction only if directly conflicting (not just different)

OUTPUT ONLY VALID JSON:`;

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Format existing knowledge for context
 *
 * ARCHITECTURE: Explicitly lists valid section IDs to constrain LLM choices
 * Pattern: Reduce hallucination by making valid options explicit
 */
function formatExistingKnowledge(
  knowledge: Map<KnowledgeCategory, { sections: readonly KnowledgeSection[] }>
): string {
  const parts: string[] = [];

  for (const [category, file] of knowledge) {
    if (file.sections.length === 0) continue;

    parts.push(`### ${category.toUpperCase()}`);
    parts.push(`Valid section IDs for ${category}: ${file.sections.map(s => s.id).join(', ')}`);
    parts.push('');
    for (const section of file.sections.slice(0, 10)) {
      parts.push(`[${section.id}] ${section.title}`);
      parts.push(`  ${section.content.slice(0, 150)}...`);
      parts.push(`  (${section.confidence}, ${section.observations} observations)`);
    }
    parts.push('');
  }

  return parts.length > 0 ? parts.join('\n') : '(No existing knowledge yet)';
}

/**
 * Format session signals for the prompt
 */
function formatSessionSignals(signals: readonly SessionSignal[]): string {
  if (signals.length === 0) {
    return '(No turns recorded)';
  }

  // Group by type for cleaner output
  const fileTouched = signals.filter(s => s.signal_type === 'file_touched');
  const turnContexts = signals.filter(s => s.signal_type === 'turn_context');

  const parts: string[] = [];

  // Show turn contexts (the actual conversation)
  for (const signal of turnContexts) {
    parts.push(`### Turn ${signal.turn_number}`);
    parts.push(signal.content);
    parts.push('');
  }

  // Summarize files at the end
  if (fileTouched.length > 0) {
    const allFiles = fileTouched.flatMap(s => s.files ?? []);
    const uniqueFiles = [...new Set(allFiles)];
    if (uniqueFiles.length > 0) {
      parts.push(`### Files modified: ${uniqueFiles.slice(0, 10).join(', ')}`);
    }
  }

  return parts.join('\n');
}

/**
 * Build session consolidation prompt
 */
function buildSessionConsolidationPrompt(
  session: SessionAccumulator,
  existingKnowledge: Map<KnowledgeCategory, { sections: readonly KnowledgeSection[] }>
): string {
  return SESSION_CONSOLIDATION_PROMPT
    .replace('{existing_knowledge}', formatExistingKnowledge(existingKnowledge))
    .replace('{project_path}', session.project_path)
    .replace('{turn_count}', String(session.turn_count))
    .replace('{files_touched}', session.files_touched_all.join(', ') || '(none)')
    .replace('{signals}', formatSessionSignals(session.signals));
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse session consolidation response
 */
function parseSessionConsolidationResponse(
  response: string
): Result<SessionConsolidationDecision, DaemonError> {
  const jsonStr = extractJsonFromResponse(response);
  if (!jsonStr) {
    return Err({
      type: 'extraction_error',
      message: 'No valid JSON found in consolidation response',
    });
  }

  try {
    const parsed = JSON.parse(jsonStr) as {
      action?: string;
      category?: string;
      section_id?: string;
      new_section?: {
        title?: string;
        content?: string;
        tags?: string[];
        examples?: string[];
      };
      extension?: {
        additional_content?: string;
        new_examples?: string[];
      };
      reasoning?: string;
    };

    const validActions: SessionConsolidationAction[] = [
      'create_section', 'extend_section', 'add_example',
      'confirm_pattern', 'flag_contradiction', 'skip'
    ];

    const action = validActions.includes(parsed.action as SessionConsolidationAction)
      ? (parsed.action as SessionConsolidationAction)
      : 'skip';

    const validCategories: KnowledgeCategory[] = [
      'conventions', 'architecture', 'decisions', 'gotchas'
    ];

    const category = validCategories.includes(parsed.category as KnowledgeCategory)
      ? (parsed.category as KnowledgeCategory)
      : undefined;

    const decision: SessionConsolidationDecision = {
      action,
      category,
      section_id: parsed.section_id,
      new_section: parsed.new_section ? {
        title: String(parsed.new_section.title ?? ''),
        content: String(parsed.new_section.content ?? ''),
        tags: Array.isArray(parsed.new_section.tags)
          ? parsed.new_section.tags.filter((t): t is string => typeof t === 'string')
          : undefined,
        examples: Array.isArray(parsed.new_section.examples)
          ? parsed.new_section.examples.filter((e): e is string => typeof e === 'string')
          : undefined,
      } : undefined,
      extension: parsed.extension ? {
        additional_content: String(parsed.extension.additional_content ?? ''),
        new_examples: Array.isArray(parsed.extension.new_examples)
          ? parsed.extension.new_examples.filter((e): e is string => typeof e === 'string')
          : undefined,
      } : undefined,
      reasoning: String(parsed.reasoning ?? 'No reasoning provided'),
    };

    return Ok(decision);
  } catch (error) {
    return Err({
      type: 'extraction_error',
      message: `Failed to parse consolidation response: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

// ============================================================================
// Decision Validation
// ============================================================================

interface ValidationResult {
  readonly valid: boolean;
  readonly error?: string;
}

/**
 * Validate a consolidation decision against existing knowledge
 *
 * ARCHITECTURE: Validates LLM output before applying
 * Pattern: Catch invalid decisions early, enable retry with feedback
 */
function validateDecision(
  decision: SessionConsolidationDecision,
  existingKnowledge: Map<KnowledgeCategory, { sections: readonly KnowledgeSection[] }>
): ValidationResult {
  // Actions that don't need validation
  if (decision.action === 'skip' || decision.action === 'confirm_pattern' || decision.action === 'flag_contradiction') {
    return { valid: true };
  }

  // Require category for content-modifying actions
  if (!decision.category) {
    return {
      valid: false,
      error: `Action "${decision.action}" requires a valid category (conventions|architecture|decisions|gotchas)`,
    };
  }

  // create_section needs new_section
  if (decision.action === 'create_section') {
    if (!decision.new_section?.title || !decision.new_section?.content) {
      return {
        valid: false,
        error: 'create_section requires new_section with title and content',
      };
    }
    return { valid: true };
  }

  // extend_section and add_example need section_id that exists
  if (decision.action === 'extend_section' || decision.action === 'add_example') {
    if (!decision.section_id) {
      return {
        valid: false,
        error: `${decision.action} requires a valid section_id`,
      };
    }

    const categoryFile = existingKnowledge.get(decision.category);
    const validIds = categoryFile?.sections.map(s => s.id) ?? [];

    if (!validIds.includes(decision.section_id)) {
      return {
        valid: false,
        error: `section_id "${decision.section_id}" not found in ${decision.category}. Valid IDs: ${validIds.join(', ') || '(none)'}`,
      };
    }

    if (decision.action === 'extend_section' && !decision.extension?.additional_content) {
      return {
        valid: false,
        error: 'extend_section requires extension.additional_content',
      };
    }

    return { valid: true };
  }

  return { valid: true };
}

// ============================================================================
// Fallback Extraction
// ============================================================================

/**
 * Fallback consolidation when LLM is unavailable
 *
 * Since we no longer do regex-based signal extraction, we can't make
 * meaningful decisions without the LLM. Just skip.
 */
function fallbackSessionConsolidation(
  _session: SessionAccumulator
): SessionConsolidationDecision {
  return {
    action: 'skip',
    reasoning: 'Fallback: LLM unavailable, cannot analyze raw turn context',
  };
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Extract knowledge from a session using LLM
 *
 * ARCHITECTURE: Session-level extraction with validation and retry
 * Pattern: Load context, run LLM, validate, retry with feedback if invalid
 *
 * Retry behavior:
 * - If LLM response fails validation, retry with error feedback appended
 * - Max 2 attempts to avoid infinite loops
 * - Force skip after exhausting retries
 */
export async function extractSessionKnowledge(
  session: SessionAccumulator,
  knowledgeStoreConfig: KnowledgeStoreConfig,
  extractorConfig: ExtractorConfig,
  maxRetries: number = 2
): Promise<Result<SessionConsolidationDecision, DaemonError>> {
  return withProjectLock(session.project_path, async () => {
    debugLog('Starting session consolidation', {
      project: session.project_path,
      signals_count: session.signals.length,
      files_count: session.files_touched_all.length,
    });

    // Create debug writer (null if debug disabled)
    const debugWriter = createDebugWriter({
      memoryDir: knowledgeStoreConfig.memoryDir,
      sessionId: session.session_id,
    });

    // Write input signals
    await debugWriter?.writeSignals(session.signals);

    // 1. Load existing knowledge
    const knowledgeResult = await readAllKnowledge(knowledgeStoreConfig);
    const existingKnowledge = knowledgeResult.ok
      ? knowledgeResult.value
      : new Map<KnowledgeCategory, { sections: readonly KnowledgeSection[] }>();

    debugLog('Loaded existing knowledge', {
      categories: existingKnowledge.size,
    });

    // Write existing knowledge context
    await debugWriter?.writeExistingKnowledge(existingKnowledge);

    // 2. Build initial prompt
    let prompt = buildSessionConsolidationPrompt(session, existingKnowledge);
    let lastError: string | undefined;

    // 3. Try up to maxRetries times
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // If retrying, append error feedback to prompt
      if (attempt > 0 && lastError) {
        prompt = `${prompt}\n\n## CORRECTION NEEDED\nYour previous response had an error: ${lastError}\nPlease fix and output valid JSON:`;
        debugLog('Retrying with feedback', { attempt, error: lastError });
      }

      // Write prompt before LLM call
      await debugWriter?.writePrompt(prompt, attempt);

      // Call LLM
      const ollamaResult = await runOllamaExtraction(prompt, extractorConfig);
      if (!ollamaResult.ok) {
        debugLog('Ollama failed, using fallback', { error: ollamaResult.error.message });
        // Write failed response info
        await debugWriter?.writeRawResponse(`ERROR: ${ollamaResult.error.message}`, attempt);
        return Ok(fallbackSessionConsolidation(session));
      }

      // Write raw response
      await debugWriter?.writeRawResponse(ollamaResult.value, attempt);

      // Parse response
      const parseResult = parseSessionConsolidationResponse(ollamaResult.value);
      if (!parseResult.ok) {
        lastError = parseResult.error.message;
        // Write parse failure as validation info
        await debugWriter?.writeValidation({
          valid: false,
          error: `Parse error: ${parseResult.error.message}`,
          decision: { action: 'skip', reasoning: 'Parse failed' },
        }, attempt);
        continue;
      }

      // Write parsed decision
      await debugWriter?.writeParsedDecision(parseResult.value, attempt);

      // Validate decision
      const validation = validateDecision(parseResult.value, existingKnowledge);

      // Write validation result
      await debugWriter?.writeValidation({
        valid: validation.valid,
        error: validation.error,
        decision: parseResult.value,
      }, attempt);

      if (!validation.valid) {
        lastError = validation.error;
        debugLog('Validation failed', { error: validation.error });
        continue;
      }

      // Success!
      debugLog('Session consolidation decision', {
        action: parseResult.value.action,
        category: parseResult.value.category,
        attempts: attempt + 1,
      });

      return Ok(parseResult.value);
    }

    // All retries exhausted - force skip
    debugLog('Max retries reached, forcing skip', { lastError });
    return Ok({
      action: 'skip',
      reasoning: `Forced skip after ${maxRetries} failed attempts. Last error: ${lastError}`,
    });
  });
}
