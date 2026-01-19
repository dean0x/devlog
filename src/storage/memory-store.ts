/**
 * Memory Storage
 *
 * ARCHITECTURE: Markdown files with YAML frontmatter
 * Pattern: Immutable updates, Result types for all operations
 *
 * Storage structure:
 *   .memory/short/today.md       - Today's detailed memories
 *   .memory/short/this-week.md   - This week's condensed memories
 *   .memory/short/this-month.md  - This month's summaries
 *   .memory/short/archive/       - Archived months
 *   .memory/long/conventions.md  - Coding conventions
 *   .memory/long/architecture.md - Architecture decisions
 *   .memory/long/rules-of-thumb.md - General patterns
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { format, startOfWeek, startOfMonth } from 'date-fns';
import type {
  MemoryEntry,
  ShortTermMemoryFile,
  LongTermMemory,
  PromotionCandidate,
  Result,
  StorageError,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';

export interface MemoryStoreConfig {
  readonly baseDir: string;
}

const SHORT_DIR = 'short';
const LONG_DIR = 'long';
const ARCHIVE_DIR = 'short/archive';

// ============================================================================
// File Parsing/Serialization
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

function serializeMarkdownWithFrontmatter<T>(doc: MarkdownDocument<T>): string {
  const frontmatter = stringifyYaml(doc.frontmatter);
  return `---\n${frontmatter}---\n${doc.content}`;
}

// ============================================================================
// Memory Entry Formatting
// ============================================================================

function formatMemoryEntry(entry: MemoryEntry): string {
  const time = entry.timestamp.split('T')[1]?.split('.')[0] ?? '';
  let markdown = `## ${time} - ${entry.title}\n\n`;

  switch (entry.type) {
    case 'goal':
      markdown += `**Goal**: ${entry.content}\n`;
      break;
    case 'decision':
      markdown += `**Decision**: ${entry.content}\n`;
      break;
    case 'problem':
      markdown += `**Problem**: ${entry.content}\n`;
      break;
    case 'context':
      markdown += `**Context**: ${entry.content}\n`;
      break;
    case 'insight':
      markdown += `**Insight**: ${entry.content}\n`;
      break;
  }

  if (entry.files && entry.files.length > 0) {
    markdown += `**Files**: ${entry.files.join(', ')}\n`;
  }

  if (entry.tags && entry.tags.length > 0) {
    markdown += `**Tags**: ${entry.tags.join(', ')}\n`;
  }

  markdown += `**Confidence**: ${entry.confidence.toFixed(2)}\n`;

  return markdown;
}

function parseMemoryEntries(content: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  const sections = content.split(/^## /m).slice(1);

  for (const section of sections) {
    const lines = section.split('\n');
    const headerLine = lines[0] ?? '';
    const headerMatch = headerLine.match(/^(\d{2}:\d{2}:\d{2})\s+-\s+(.+)$/);

    if (!headerMatch) continue;

    const time = headerMatch[1];
    const title = headerMatch[2] ?? '';
    const body = lines.slice(1).join('\n');

    // Extract fields
    const typeMatch = body.match(/\*\*(\w+)\*\*:\s*(.+)/);
    const filesMatch = body.match(/\*\*Files\*\*:\s*(.+)/);
    const tagsMatch = body.match(/\*\*Tags\*\*:\s*(.+)/);
    const confidenceMatch = body.match(/\*\*Confidence\*\*:\s*(\d+\.?\d*)/);

    const type = (typeMatch?.[1]?.toLowerCase() ?? 'decision') as MemoryEntry['type'];
    const contentText = typeMatch?.[2] ?? '';
    const files = filesMatch?.[1]?.split(',').map((f) => f.trim()) ?? [];
    const tags = tagsMatch?.[1]?.split(',').map((t) => t.trim()) ?? [];
    const confidence = parseFloat(confidenceMatch?.[1] ?? '0.5');

    entries.push({
      id: `${time}-${title.slice(0, 20).replace(/\s+/g, '-').toLowerCase()}`,
      timestamp: `${new Date().toISOString().split('T')[0]}T${time}`,
      type,
      title: title ?? '',
      content: contentText,
      confidence,
      files: files.length > 0 ? files : undefined,
      tags: tags.length > 0 ? tags : undefined,
    });
  }

  return entries;
}

// ============================================================================
// Short-Term Memory Operations
// ============================================================================

function getShortTermPath(config: MemoryStoreConfig, period: 'today' | 'this-week' | 'this-month'): string {
  return join(config.baseDir, SHORT_DIR, `${period}.md`);
}

export async function readShortTermMemory(
  config: MemoryStoreConfig,
  period: 'today' | 'this-week' | 'this-month'
): Promise<Result<ShortTermMemoryFile, StorageError>> {
  const path = getShortTermPath(config, period);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const parseResult = parseMarkdownWithFrontmatter<{
      date?: string;
      entries?: number;
      last_updated?: string;
    }>(content);

    if (!parseResult.ok) {
      return Err({ ...parseResult.error, path });
    }

    const memories = parseMemoryEntries(parseResult.value.content);

    return Ok({
      date: parseResult.value.frontmatter.date ?? format(new Date(), 'yyyy-MM-dd'),
      entries: parseResult.value.frontmatter.entries ?? memories.length,
      last_updated: parseResult.value.frontmatter.last_updated ?? new Date().toISOString(),
      memories,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // File doesn't exist, return empty
      return Ok({
        date: format(new Date(), 'yyyy-MM-dd'),
        entries: 0,
        last_updated: new Date().toISOString(),
        memories: [],
      });
    }
    return Err({
      type: 'read_error',
      message: `Failed to read memory file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

export async function appendToShortTermMemory(
  config: MemoryStoreConfig,
  period: 'today' | 'this-week' | 'this-month',
  entries: readonly MemoryEntry[]
): Promise<Result<void, StorageError>> {
  if (entries.length === 0) {
    return Ok(undefined);
  }

  const path = getShortTermPath(config, period);

  // Read existing
  const readResult = await readShortTermMemory(config, period);
  if (!readResult.ok) {
    return Err(readResult.error);
  }

  const existing = readResult.value;
  const allMemories = [...existing.memories, ...entries];
  const now = new Date();

  // Build new content
  const frontmatter = {
    date: format(now, 'yyyy-MM-dd'),
    entries: allMemories.length,
    last_updated: now.toISOString(),
  };

  let dateHeader: string;
  switch (period) {
    case 'today':
      dateHeader = format(now, 'yyyy-MM-dd');
      break;
    case 'this-week':
      dateHeader = `Week of ${format(startOfWeek(now), 'yyyy-MM-dd')}`;
      break;
    case 'this-month':
      dateHeader = format(startOfMonth(now), 'MMMM yyyy');
      break;
  }

  const content = `# ${period === 'today' ? "Today's Memory" : period === 'this-week' ? 'This Week' : 'This Month'} - ${dateHeader}\n\n` +
    allMemories.map(formatMemoryEntry).join('\n');

  const markdown = serializeMarkdownWithFrontmatter({ frontmatter, content });

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, markdown, 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write memory file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Write short-term memory file (full rewrite)
 *
 * ARCHITECTURE: Used by updateMemoryEntry for atomic updates
 * Pattern: Read-modify-write with full file replacement
 */
export async function writeShortTermMemory(
  config: MemoryStoreConfig,
  period: 'today' | 'this-week' | 'this-month',
  memories: readonly MemoryEntry[]
): Promise<Result<void, StorageError>> {
  const path = getShortTermPath(config, period);
  const now = new Date();

  let dateHeader: string;
  switch (period) {
    case 'today':
      dateHeader = format(now, 'yyyy-MM-dd');
      break;
    case 'this-week':
      dateHeader = `Week of ${format(startOfWeek(now), 'yyyy-MM-dd')}`;
      break;
    case 'this-month':
      dateHeader = format(startOfMonth(now), 'MMMM yyyy');
      break;
  }

  const frontmatter = {
    date: format(now, 'yyyy-MM-dd'),
    entries: memories.length,
    last_updated: now.toISOString(),
  };

  const content =
    `# ${period === 'today' ? "Today's Memory" : period === 'this-week' ? 'This Week' : 'This Month'} - ${dateHeader}\n\n` +
    memories.map(formatMemoryEntry).join('\n');

  const markdown = serializeMarkdownWithFrontmatter({ frontmatter, content });

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, markdown, 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write memory file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Update a specific memory entry by ID
 *
 * ARCHITECTURE: Atomic update with immutable pattern
 * Pattern: Read-modify-write, returns new file state
 */
export async function updateMemoryEntry(
  config: MemoryStoreConfig,
  period: 'today' | 'this-week' | 'this-month',
  memoId: string,
  updates: Partial<Pick<MemoryEntry, 'title' | 'content' | 'files' | 'tags'>>
): Promise<Result<void, StorageError>> {
  const readResult = await readShortTermMemory(config, period);
  if (!readResult.ok) {
    return Err(readResult.error);
  }

  const existing = readResult.value.memories;
  const targetIndex = existing.findIndex((m) => m.id === memoId);

  if (targetIndex === -1) {
    return Err({
      type: 'read_error',
      message: `Memory entry not found: ${memoId}`,
      path: getShortTermPath(config, period),
    });
  }

  const target = existing[targetIndex];
  if (!target) {
    return Err({
      type: 'read_error',
      message: `Memory entry not found: ${memoId}`,
      path: getShortTermPath(config, period),
    });
  }

  // Immutable update
  const updated: MemoryEntry = {
    ...target,
    ...(updates.title !== undefined && { title: updates.title }),
    ...(updates.content !== undefined && { content: updates.content }),
    ...(updates.files !== undefined && { files: updates.files }),
    ...(updates.tags !== undefined && { tags: updates.tags }),
  };

  const updatedMemories = [
    ...existing.slice(0, targetIndex),
    updated,
    ...existing.slice(targetIndex + 1),
  ];

  return writeShortTermMemory(config, period, updatedMemories);
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

export async function appendLongTermMemory(
  config: MemoryStoreConfig,
  memory: LongTermMemory
): Promise<Result<void, StorageError>> {
  const path = getLongTermPath(config, memory.category);

  // Read existing
  const readResult = await readLongTermMemory(config, memory.category);
  if (!readResult.ok) {
    return Err(readResult.error);
  }

  const existing = readResult.value;

  // Check for duplicates by title
  const existingIndex = existing.findIndex(
    (m) => m.title.toLowerCase() === memory.title.toLowerCase()
  );

  let allMemories: LongTermMemory[];
  if (existingIndex >= 0) {
    // Update existing entry
    const existingEntry = existing[existingIndex];
    if (existingEntry) {
      allMemories = [
        ...existing.slice(0, existingIndex),
        {
          ...existingEntry,
          occurrences: existingEntry.occurrences + 1,
          last_validated: format(new Date(), 'yyyy-MM-dd'),
        },
        ...existing.slice(existingIndex + 1),
      ];
    } else {
      allMemories = [...existing, memory];
    }
  } else {
    allMemories = [...existing, memory];
  }

  // Build markdown
  const categoryTitle = memory.category
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const frontmatter = {
    created: existing.length > 0 ? (existing[0]?.first_observed ?? format(new Date(), 'yyyy-MM-dd')) : format(new Date(), 'yyyy-MM-dd'),
    last_validated: format(new Date(), 'yyyy-MM-dd'),
  };

  let content = `# Project ${categoryTitle}\n\n`;
  for (const mem of allMemories) {
    content += `## ${mem.title}\n`;
    content += `${mem.content}\n`;
    content += `*First observed: ${mem.first_observed}, Occurrences: ${mem.occurrences}*\n\n`;
  }

  const markdown = serializeMarkdownWithFrontmatter({ frontmatter, content });

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, markdown, 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write long-term memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
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

// ============================================================================
// Promotion Candidates
// ============================================================================

export async function readPromotionCandidates(
  config: MemoryStoreConfig
): Promise<Result<PromotionCandidate[], StorageError>> {
  const path = join(config.baseDir, 'candidates.json');

  try {
    const content = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(content);
    // Handle both array format and {candidates: []} wrapper format
    let candidates: PromotionCandidate[];
    if (Array.isArray(parsed)) {
      candidates = parsed;
    } else if (parsed && Array.isArray(parsed.candidates)) {
      candidates = parsed.candidates;
    } else {
      candidates = [];
    }
    return Ok(candidates);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok([]);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read promotion candidates: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

export async function writePromotionCandidates(
  config: MemoryStoreConfig,
  candidates: readonly PromotionCandidate[]
): Promise<Result<void, StorageError>> {
  const path = join(config.baseDir, 'candidates.json');

  try {
    await fs.writeFile(path, JSON.stringify(candidates, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write promotion candidates: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

// ============================================================================
// Archive Operations
// ============================================================================

export async function archiveMonth(
  config: MemoryStoreConfig,
  year: number,
  month: number
): Promise<Result<void, StorageError>> {
  const archivePath = join(config.baseDir, ARCHIVE_DIR, `${year}-${month.toString().padStart(2, '0')}.md`);

  // Read this-month
  const readResult = await readShortTermMemory(config, 'this-month');
  if (!readResult.ok) {
    return Err(readResult.error);
  }

  if (readResult.value.memories.length === 0) {
    return Ok(undefined);
  }

  // Generate summary
  const memories = readResult.value.memories;
  const frontmatter = {
    year,
    month,
    entries: memories.length,
    archived_at: new Date().toISOString(),
  };

  const monthName = format(new Date(year, month - 1), 'MMMM yyyy');
  let content = `# Archive - ${monthName}\n\n`;
  content += `## Summary\n`;
  content += `Processed ${memories.length} memories this month.\n\n`;

  // Group by type
  const byType = memories.reduce((acc, m) => {
    const existing = acc.get(m.type);
    if (existing) {
      existing.push(m);
    } else {
      acc.set(m.type, [m]);
    }
    return acc;
  }, new Map<string, MemoryEntry[]>());

  for (const [type, entries] of byType) {
    content += `### ${type.charAt(0).toUpperCase() + type.slice(1)}s (${entries.length})\n`;
    for (const entry of entries.slice(0, 5)) {
      content += `- ${entry.title}\n`;
    }
    if (entries.length > 5) {
      content += `- ... and ${entries.length - 5} more\n`;
    }
    content += '\n';
  }

  const markdown = serializeMarkdownWithFrontmatter({ frontmatter, content });

  try {
    await fs.mkdir(dirname(archivePath), { recursive: true });
    await fs.writeFile(archivePath, markdown, 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write archive: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: archivePath,
    });
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export async function initMemoryStore(config: MemoryStoreConfig): Promise<Result<void, StorageError>> {
  const dirs = [
    join(config.baseDir, SHORT_DIR),
    join(config.baseDir, LONG_DIR),
    join(config.baseDir, ARCHIVE_DIR),
  ];

  try {
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to initialize memory store: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: config.baseDir,
    });
  }
}
