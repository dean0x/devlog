/**
 * Session Knowledge Extractor
 *
 * ARCHITECTURE: Direct ollama-js calls for session consolidation
 * Pattern: Uses prompt engineering to get structured JSON output
 *
 * The extractor:
 * 1. Takes a session with accumulated signals
 * 2. Loads existing knowledge context
 * 3. Acquires extraction lock (only one Ollama call at a time)
 * 4. Builds session consolidation prompt
 * 5. Calls Ollama directly via ollama-js
 * 6. Parses decision JSON (create, extend, confirm, or skip)
 */

import { Ollama } from 'ollama';

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

import type {
  Result,
  DaemonError,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';
import type { SessionAccumulator, SessionSignal } from '../types/session.js';
import type {
  KnowledgeSection,
  KnowledgeCategory,
  KnowledgeStoreConfig,
} from '../storage/knowledge-store.js';
import { readAllKnowledge } from '../storage/knowledge-store.js';

export interface ExtractorConfig {
  readonly ollamaUrl: string;
  readonly model: string;
  readonly timeout?: number;
}

// ============================================================================
// Extraction Lock - Ensures only one Ollama call at a time
// ============================================================================

/**
 * ARCHITECTURE: Simple promise-based mutex for extraction
 * Pattern: Prevents resource contention when multiple sessions overlap
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

    if (char === '"' && !escape) {
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
        num_predict: 1000,
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

Session ID: {session_id}
Project: {project_path}
Duration: {turn_count} turns
Files touched: {files_touched}

### Signals from this session:

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

## QUALITY GUIDELINES

### GOOD knowledge (worth capturing):
- "Using Result<T,E> pattern for error handling because it makes errors explicit and prevents forgotten error cases"
- "API endpoints follow REST conventions with /api/v1 prefix - discovered from existing routes"
- "Race condition in checkout: two concurrent requests can both pass inventory check"

### NOT knowledge (skip these):
- "Made some code changes" (too vague)
- "Fixed a bug" (no insight about what/why)
- "User asked a question" (just conversation)
- Session with only file_touched signals and no decisions

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
 */
function formatExistingKnowledge(
  knowledge: Map<KnowledgeCategory, { sections: readonly KnowledgeSection[] }>
): string {
  const parts: string[] = [];

  for (const [category, file] of knowledge) {
    if (file.sections.length === 0) continue;

    parts.push(`### ${category.toUpperCase()}`);
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
    return '(No signals recorded)';
  }

  return signals.map(signal => {
    let line = `- [${signal.signal_type}] ${signal.content}`;
    if (signal.files && signal.files.length > 0) {
      line += `\n  Files: ${signal.files.slice(0, 3).join(', ')}`;
    }
    return line;
  }).join('\n');
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
    .replace('{session_id}', session.session_id)
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
// Fallback Extraction
// ============================================================================

/**
 * Fallback consolidation when LLM is unavailable
 */
function fallbackSessionConsolidation(
  session: SessionAccumulator
): SessionConsolidationDecision {
  // Simple heuristic: if we have decisions, create a section
  const decisions = session.signals.filter(s => s.signal_type === 'decision_made');
  const problems = session.signals.filter(s => s.signal_type === 'problem_discovered');

  if (decisions.length > 0) {
    const firstDecision = decisions[0];
    return {
      action: 'create_section',
      category: 'decisions',
      new_section: {
        title: firstDecision?.content.slice(0, 80) ?? 'Decision from session',
        content: decisions.map(d => d.content).join('\n\n'),
        tags: ['auto-extracted'],
      },
      reasoning: 'Fallback: Found decision signals',
    };
  }

  if (problems.length > 0) {
    const firstProblem = problems[0];
    return {
      action: 'create_section',
      category: 'gotchas',
      new_section: {
        title: firstProblem?.content.slice(0, 80) ?? 'Issue from session',
        content: problems.map(p => p.content).join('\n\n'),
        tags: ['auto-extracted'],
      },
      reasoning: 'Fallback: Found problem signals',
    };
  }

  return {
    action: 'skip',
    reasoning: 'Fallback: No valuable signals found',
  };
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Extract knowledge from a session using LLM
 *
 * ARCHITECTURE: Session-level extraction for knowledge consolidation
 * Pattern: Load context, run LLM, return consolidation decision
 */
export async function extractSessionKnowledge(
  session: SessionAccumulator,
  knowledgeStoreConfig: KnowledgeStoreConfig,
  extractorConfig: ExtractorConfig
): Promise<Result<SessionConsolidationDecision, DaemonError>> {
  return withExtractionLock(async () => {
    debugLog('Starting session consolidation', {
      session_id: session.session_id,
      signals_count: session.signals.length,
      files_count: session.files_touched_all.length,
    });

    // 1. Load existing knowledge
    const knowledgeResult = await readAllKnowledge(knowledgeStoreConfig);
    const existingKnowledge = knowledgeResult.ok
      ? knowledgeResult.value
      : new Map<KnowledgeCategory, { sections: readonly KnowledgeSection[] }>();

    debugLog('Loaded existing knowledge', {
      categories: existingKnowledge.size,
    });

    // 2. Build prompt
    const prompt = buildSessionConsolidationPrompt(session, existingKnowledge);

    // 3. Run LLM
    const ollamaResult = await runOllamaExtraction(prompt, extractorConfig);
    if (!ollamaResult.ok) {
      debugLog('Ollama failed, using fallback', { error: ollamaResult.error.message });
      return Ok(fallbackSessionConsolidation(session));
    }

    // 4. Parse response
    const parseResult = parseSessionConsolidationResponse(ollamaResult.value);
    if (!parseResult.ok) {
      debugLog('Parse failed, using fallback', { error: parseResult.error.message });
      return Ok(fallbackSessionConsolidation(session));
    }

    debugLog('Session consolidation decision', {
      action: parseResult.value.action,
      category: parseResult.value.category,
      reasoning: parseResult.value.reasoning,
    });

    return Ok(parseResult.value);
  });
}
