/**
 * LLM-based Catch-Up Summarizer
 *
 * ARCHITECTURE: Generate coherent prose summaries using Ollama
 * Pattern: Collect session data, build prompt, call LLM, cache result
 *
 * Uses the same Ollama patterns as extractor.ts for consistency.
 */

import { Ollama } from 'ollama';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { formatDistanceToNow, parseISO } from 'date-fns';
import type { SessionAccumulator } from '../types/session.js';
import type { RecentSessionSummary } from './recent-sessions.js';
import type { Result, StorageError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

export interface SummaryConfig {
  readonly ollamaUrl: string;
  readonly model: string;
  readonly timeout?: number;
}

export interface CachedSummary {
  readonly hash: string;
  readonly summary: string;
  readonly generated_at: string;
}

// ============================================================================
// Constants
// ============================================================================

const CACHE_FILE = 'catch-up-cache.json';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

// ============================================================================
// Cache Operations
// ============================================================================

function getCachePath(memoryDir: string): string {
  return join(memoryDir, 'working', CACHE_FILE);
}

/**
 * Compute cache key from session data
 */
export function computeCacheHash(
  activeSessions: readonly SessionAccumulator[],
  recentSummaries: readonly RecentSessionSummary[]
): string {
  const data = {
    active: activeSessions.map(s => ({
      id: s.session_id,
      last: s.last_activity,
      signals: s.signals.length,
    })),
    recent: recentSummaries.map(s => ({
      id: s.session_id,
      at: s.consolidated_at,
    })),
  };
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

/**
 * Read cached summary if valid
 */
async function readCache(
  memoryDir: string,
  hash: string
): Promise<Result<string | null, StorageError>> {
  const path = getCachePath(memoryDir);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const cached = JSON.parse(content) as CachedSummary;

    // Check hash match
    if (cached.hash !== hash) {
      return Ok(null);
    }

    // Check TTL
    const age = Date.now() - new Date(cached.generated_at).getTime();
    if (age > CACHE_TTL_MS) {
      return Ok(null);
    }

    return Ok(cached.summary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(null);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read catch-up cache: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Write summary to cache
 */
async function writeCache(
  memoryDir: string,
  hash: string,
  summary: string
): Promise<Result<void, StorageError>> {
  const path = getCachePath(memoryDir);

  const cached: CachedSummary = {
    hash,
    summary,
    generated_at: new Date().toISOString(),
  };

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(cached, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write catch-up cache: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

// ============================================================================
// Prompt Building
// ============================================================================

/**
 * Format an active session for the prompt
 *
 * Now that we store raw turn context instead of regex-extracted signals,
 * we just pass through the turn content directly for LLM analysis.
 */
function formatActiveSessionForPrompt(session: SessionAccumulator): string {
  const age = formatDistanceToNow(parseISO(session.started_at), { addSuffix: true });
  const lines: string[] = [`Current Session (started ${age}):`];

  // Get turn context signals (the actual conversation)
  const turnContexts = session.signals.filter(s => s.signal_type === 'turn_context');

  for (const signal of turnContexts.slice(0, 5)) { // Limit to recent turns
    lines.push('');
    lines.push(signal.content);
  }

  if (session.files_touched_all.length > 0) {
    const files = session.files_touched_all.slice(0, 5).join(', ');
    const more = session.files_touched_all.length > 5
      ? ` (+${session.files_touched_all.length - 5} more)`
      : '';
    lines.push('');
    lines.push(`Files touched: ${files}${more}`);
  }

  return lines.join('\n');
}

/**
 * Format a recent session summary for the prompt
 *
 * Handles both old signal types (for backwards compatibility) and new turn_context format.
 */
function formatRecentSessionForPrompt(summary: RecentSessionSummary): string {
  const age = formatDistanceToNow(parseISO(summary.consolidated_at), { addSuffix: true });
  const goal = summary.goal || 'Session';

  const lines: string[] = [`[${age}] ${goal}`];

  for (const signal of summary.key_signals.slice(0, 3)) {
    // Handle both old signal types and new turn_context
    if (signal.type === 'turn_context') {
      // New format: show truncated content
      const truncated = signal.content.slice(0, 150);
      lines.push(`  ${truncated}${signal.content.length > 150 ? '...' : ''}`);
    } else {
      // Old format (backwards compatibility): show with label
      lines.push(`  - ${signal.content.slice(0, 100)}${signal.content.length > 100 ? '...' : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * Build the LLM prompt for summarization
 */
export function buildSummaryPrompt(
  activeSessions: readonly SessionAccumulator[],
  recentSummaries: readonly RecentSessionSummary[]
): string {
  const parts: string[] = [
    'You are summarizing a developer\'s recent Claude Code sessions for context restoration.',
    '',
    'Generate a concise 2-3 paragraph summary that:',
    '1. States what the developer was working on',
    '2. Highlights key decisions and their rationale',
    '3. Notes any unresolved problems',
    '4. Mentions the key files involved',
    '',
    'Be direct and factual. No pleasantries. Use second person ("You were...").',
    '',
    '---',
    '',
  ];

  // Add active sessions
  if (activeSessions.length > 0) {
    for (const session of activeSessions) {
      parts.push(formatActiveSessionForPrompt(session));
      parts.push('');
    }
  }

  // Add recent sessions
  if (recentSummaries.length > 0) {
    parts.push('Recent Sessions:');
    for (const summary of recentSummaries.slice(0, 5)) {
      parts.push(formatRecentSessionForPrompt(summary));
    }
    parts.push('');
  }

  parts.push('---');
  parts.push('');
  parts.push('Write the summary:');

  return parts.join('\n');
}

// ============================================================================
// LLM Summarization
// ============================================================================

export interface LLMSummaryResult {
  readonly summary: string;
  readonly fromCache: boolean;
}

/**
 * Generate LLM summary from session data
 *
 * Returns Result with summary string or error
 */
export async function generateLLMSummary(
  activeSessions: readonly SessionAccumulator[],
  recentSummaries: readonly RecentSessionSummary[],
  memoryDir: string,
  config: SummaryConfig
): Promise<Result<LLMSummaryResult, Error>> {
  // Check for no data
  if (activeSessions.length === 0 && recentSummaries.length === 0) {
    return Ok({
      summary: 'No sessions found. Start a Claude Code session with devlog hooks enabled.',
      fromCache: false,
    });
  }

  // Check cache first
  const hash = computeCacheHash(activeSessions, recentSummaries);
  const cacheResult = await readCache(memoryDir, hash);
  if (cacheResult.ok && cacheResult.value !== null) {
    return Ok({
      summary: cacheResult.value,
      fromCache: true,
    });
  }

  // Build prompt
  const prompt = buildSummaryPrompt(activeSessions, recentSummaries);

  // Call Ollama with timeout
  const timeout = config.timeout ?? DEFAULT_TIMEOUT_MS;

  try {
    const ollama = new Ollama({ host: config.ollamaUrl });

    const chatPromise = ollama.chat({
      model: config.model,
      messages: [{ role: 'user', content: prompt }],
      options: {
        temperature: 0.3,
        // No num_predict limit - local Ollama has no cost, let model complete naturally
      },
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Ollama request timed out after ${timeout}ms`)), timeout);
    });

    const response = await Promise.race([chatPromise, timeoutPromise]);
    const summary = response.message?.content ?? '';

    if (!summary) {
      return Err(new Error('Empty response from Ollama'));
    }

    // Cache the result
    await writeCache(memoryDir, hash, summary);

    return Ok({
      summary,
      fromCache: false,
    });
  } catch (error) {
    return Err(error instanceof Error ? error : new Error('Unknown Ollama error'));
  }
}
