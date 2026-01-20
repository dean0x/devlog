/**
 * Memory Storage - Long-term Memory Only
 *
 * ARCHITECTURE: Markdown files with YAML frontmatter
 * Pattern: Immutable reads, Result types for all operations
 *
 * This module provides read access to long-term memories used by
 * the knowledge consolidation system for context.
 *
 * NOTE: Short-term memory and promotion candidates have been removed.
 * Use the knowledge-store.ts module for the new session-based system.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { format } from 'date-fns';
import type {
  LongTermMemory,
  Result,
  StorageError,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';

export interface MemoryStoreConfig {
  readonly baseDir: string;
}

const LONG_DIR = 'long';

// ============================================================================
// File Parsing
// ============================================================================

interface MarkdownDocument<T> {
  readonly frontmatter: T;
  readonly content: string;
}

function parseMarkdownWithFrontmatter<T>(
  content: string
): Result<MarkdownDocument<T>, StorageError> {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
    // No frontmatter, treat entire content as body
    return Ok({
      frontmatter: {} as T,
      content: content,
    });
  }

  try {
    const frontmatter = parseYaml(frontmatterMatch[1] ?? '') as T;
    return Ok({
      frontmatter,
      content: frontmatterMatch[2] ?? '',
    });
  } catch (error) {
    return Err({
      type: 'parse_error',
      message: `Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: 'unknown',
    });
  }
}

// ============================================================================
// Long-Term Memory Operations
// ============================================================================

function getLongTermPath(
  config: MemoryStoreConfig,
  category: LongTermMemory['category']
): string {
  const filename = category.replace(/_/g, '-') + '.md';
  return join(config.baseDir, LONG_DIR, filename);
}

export async function readLongTermMemory(
  config: MemoryStoreConfig,
  category: LongTermMemory['category']
): Promise<Result<LongTermMemory[], StorageError>> {
  const path = getLongTermPath(config, category);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const parseResult = parseMarkdownWithFrontmatter<{
      created?: string;
      last_validated?: string;
    }>(content);

    if (!parseResult.ok) {
      return Err({ ...parseResult.error, path });
    }

    // Parse entries from markdown sections
    const memories: LongTermMemory[] = [];
    const sections = parseResult.value.content.split(/^## /m).slice(1);

    for (const section of sections) {
      const lines = section.split('\n');
      const title = lines[0]?.trim() ?? '';
      const body = lines.slice(1).join('\n');

      const observedMatch = body.match(/First observed:\s*(\d{4}-\d{2}-\d{2})/);
      const occurrencesMatch = body.match(/Occurrences:\s*(\d+)/);
      const contentLines = body.split('\n').filter(
        (l) => !l.includes('First observed:') && !l.includes('Occurrences:') && l.trim() !== ''
      );

      memories.push({
        id: title.toLowerCase().replace(/\s+/g, '-').slice(0, 50),
        category,
        title,
        content: contentLines.join('\n').trim(),
        first_observed: observedMatch?.[1] ?? format(new Date(), 'yyyy-MM-dd'),
        last_validated: parseResult.value.frontmatter.last_validated ?? format(new Date(), 'yyyy-MM-dd'),
        occurrences: parseInt(occurrencesMatch?.[1] ?? '1', 10),
        source_entries: [],
      });
    }

    return Ok(memories);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok([]);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read long-term memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Read all long-term memories across all categories
 *
 * ARCHITECTURE: Used by context-aware extraction
 * Pattern: Aggregates all categories, sorted by occurrences (highest weight)
 */
export async function readAllLongTermMemories(
  config: MemoryStoreConfig
): Promise<Result<LongTermMemory[], StorageError>> {
  const categories: LongTermMemory['category'][] = ['conventions', 'architecture', 'rules_of_thumb'];
  const allMemories: LongTermMemory[] = [];

  for (const category of categories) {
    const result = await readLongTermMemory(config, category);
    if (!result.ok) {
      // Don't fail on individual category errors, just skip
      continue;
    }
    allMemories.push(...result.value);
  }

  // Sort by occurrences (most established patterns first)
  allMemories.sort((a, b) => b.occurrences - a.occurrences);

  return Ok(allMemories);
}
