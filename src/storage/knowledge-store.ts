/**
 * Knowledge Storage
 *
 * ARCHITECTURE: Concept-based living knowledge files
 * Pattern: Markdown files with YAML frontmatter organized by category
 *
 * Storage structure:
 *   .memory/knowledge/
 *     conventions.md    - How things are done
 *     architecture.md   - Structural decisions
 *     decisions.md      - Explicit choices with rationale
 *     gotchas.md        - Warnings and edge cases
 *   .memory/index.md    - Auto-generated table of contents
 */

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { v4 as uuidv4 } from 'uuid';
import type { Result, StorageError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Categories of knowledge that can be stored
 */
export type KnowledgeCategory =
  | 'conventions'
  | 'architecture'
  | 'decisions'
  | 'gotchas';

/**
 * Confidence level for a knowledge section
 */
export type ConfidenceLevel =
  | 'tentative'    // First observation, might change
  | 'developing'   // Seen a few times, gaining confidence
  | 'established'  // Consistently observed, reliable
  | 'canonical';   // Core project truth, rarely changes

/**
 * A single section of knowledge within a category file
 */
export interface KnowledgeSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly confidence: ConfidenceLevel;
  readonly first_observed: string;
  readonly last_updated: string;
  readonly observations: number;
  readonly related_files?: readonly string[];
  readonly tags?: readonly string[];
  readonly examples?: readonly string[];
  // Staleness tracking fields (optional for backward compatibility)
  readonly last_referenced?: string;  // ISO timestamp - when last surfaced to user
  readonly last_confirmed?: string;   // ISO timestamp - when last validated by LLM
  readonly flagged_for_review?: string;  // ISO timestamp - when flagged for human review
}

/**
 * Frontmatter for a knowledge file
 */
export interface KnowledgeFrontmatter {
  readonly category: KnowledgeCategory;
  readonly sectionCount: number;
  readonly lastUpdated: string;
}

/**
 * A complete knowledge file
 */
export interface KnowledgeFile {
  readonly frontmatter: KnowledgeFrontmatter;
  readonly sections: readonly KnowledgeSection[];
}

// ============================================================================
// Constants
// ============================================================================

const KNOWLEDGE_DIR = 'knowledge';
const INDEX_FILE = 'index.md';

// ============================================================================
// Staleness Constants
// ============================================================================

/** Days without confirmation before established/developing -> tentative */
export const DECAY_THRESHOLD_DAYS = 30;

/** Days without confirmation before flagging for review */
export const REVIEW_THRESHOLD_DAYS = 90;

const CATEGORY_TITLES: Record<KnowledgeCategory, string> = {
  conventions: 'Conventions',
  architecture: 'Architecture',
  decisions: 'Decisions',
  gotchas: 'Gotchas',
};

const CATEGORY_DESCRIPTIONS: Record<KnowledgeCategory, string> = {
  conventions: 'How things are done in this codebase',
  architecture: 'Structural decisions and design patterns',
  decisions: 'Explicit choices with rationale',
  gotchas: 'Warnings, edge cases, and things to watch out for',
};

// ============================================================================
// Path Helpers
// ============================================================================

function getKnowledgeDir(memoryDir: string): string {
  return join(memoryDir, KNOWLEDGE_DIR);
}

function getKnowledgeFilePath(memoryDir: string, category: KnowledgeCategory): string {
  return join(getKnowledgeDir(memoryDir), `${category}.md`);
}

function getIndexPath(memoryDir: string): string {
  return join(memoryDir, INDEX_FILE);
}

// ============================================================================
// Parsing and Serialization
// ============================================================================

interface ParsedDocument<T> {
  readonly frontmatter: T;
  readonly content: string;
}

function parseMarkdownWithFrontmatter<T>(
  content: string,
  path: string
): Result<ParsedDocument<T>, StorageError> {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!frontmatterMatch) {
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
      path,
    });
  }
}

function serializeMarkdownWithFrontmatter<T>(
  frontmatter: T,
  content: string
): string {
  const yaml = stringifyYaml(frontmatter);
  return `---\n${yaml}---\n${content}`;
}

/**
 * Parse knowledge sections from markdown content
 */
function parseSections(content: string): KnowledgeSection[] {
  const sections: KnowledgeSection[] = [];
  const sectionBlocks = content.split(/^## /m).slice(1);

  for (const block of sectionBlocks) {
    const lines = block.split('\n');
    const headerLine = lines[0] ?? '';

    // Parse header: [id] Title
    const headerMatch = headerLine.match(/^\[([^\]]+)\]\s+(.+)$/);
    if (!headerMatch) {
      continue;
    }

    const id = headerMatch[1] ?? '';
    const title = headerMatch[2]?.trim() ?? '';
    const body = lines.slice(1).join('\n');

    // Extract metadata from body
    const confidenceMatch = body.match(/\*\*Confidence\*\*:\s*(\w+)/);
    const firstObservedMatch = body.match(/\*\*First observed\*\*:\s*([\d-]+)/);
    const observationsMatch = body.match(/\*\*Observations\*\*:\s*(\d+)/);
    const relatedFilesMatch = body.match(/\*\*Related files\*\*:\s*`([^`]+)`/);
    const tagsMatch = body.match(/\*\*Tags\*\*:\s*(.+)/);
    const lastUpdatedMatch = body.match(/\*\*Last updated\*\*:\s*([\dT:.Z+-]+)/);
    // Staleness tracking fields
    const lastReferencedMatch = body.match(/\*\*Last referenced\*\*:\s*([\dT:.Z+-]+)/);
    const lastConfirmedMatch = body.match(/\*\*Last confirmed\*\*:\s*([\dT:.Z+-]+)/);
    const flaggedForReviewMatch = body.match(/\*\*Flagged for review\*\*:\s*([\dT:.Z+-]+)/);

    // Extract content (everything before the metadata block)
    const metadataStart = body.indexOf('**Confidence**');
    const contentText = metadataStart > 0
      ? body.slice(0, metadataStart).trim()
      : body.trim();

    // Parse examples
    const examples: string[] = [];
    const examplesMatch = body.match(/### Examples\n([\s\S]*?)(?=\n\*\*|$)/);
    if (examplesMatch) {
      const exampleLines = examplesMatch[1]?.split('\n').filter(l => l.startsWith('- '));
      for (const line of exampleLines ?? []) {
        examples.push(line.slice(2));
      }
    }

    const confidence = (['tentative', 'developing', 'established', 'canonical'] as const)
      .includes(confidenceMatch?.[1] as ConfidenceLevel)
      ? (confidenceMatch?.[1] as ConfidenceLevel)
      : 'tentative';

    sections.push({
      id,
      title,
      content: contentText,
      confidence,
      first_observed: firstObservedMatch?.[1] ?? new Date().toISOString().split('T')[0] ?? '',
      last_updated: lastUpdatedMatch?.[1] ?? new Date().toISOString(),
      observations: parseInt(observationsMatch?.[1] ?? '1', 10),
      related_files: relatedFilesMatch?.[1]?.split(',').map(f => f.trim()),
      tags: tagsMatch?.[1]?.split(',').map(t => t.trim()),
      examples: examples.length > 0 ? examples : undefined,
      // Staleness tracking fields (undefined if not present for backward compatibility)
      last_referenced: lastReferencedMatch?.[1],
      last_confirmed: lastConfirmedMatch?.[1],
      flagged_for_review: flaggedForReviewMatch?.[1],
    });
  }

  return sections;
}

/**
 * Serialize a knowledge section to markdown
 */
function serializeSection(section: KnowledgeSection): string {
  let markdown = `## [${section.id}] ${section.title}\n\n`;
  markdown += `${section.content}\n\n`;

  if (section.examples && section.examples.length > 0) {
    markdown += `### Examples\n`;
    for (const example of section.examples) {
      markdown += `- ${example}\n`;
    }
    markdown += '\n';
  }

  markdown += `**Confidence**: ${section.confidence}\n`;
  markdown += `**First observed**: ${section.first_observed}\n`;
  markdown += `**Last updated**: ${section.last_updated}\n`;
  markdown += `**Observations**: ${section.observations}\n`;

  if (section.related_files && section.related_files.length > 0) {
    markdown += `**Related files**: \`${section.related_files.join(', ')}\`\n`;
  }

  if (section.tags && section.tags.length > 0) {
    markdown += `**Tags**: ${section.tags.join(', ')}\n`;
  }

  // Staleness tracking fields (only if present)
  if (section.last_referenced) {
    markdown += `**Last referenced**: ${section.last_referenced}\n`;
  }

  if (section.last_confirmed) {
    markdown += `**Last confirmed**: ${section.last_confirmed}\n`;
  }

  if (section.flagged_for_review) {
    markdown += `**Flagged for review**: ${section.flagged_for_review}\n`;
  }

  markdown += '\n---\n\n';
  return markdown;
}

// ============================================================================
// Store Configuration
// ============================================================================

export interface KnowledgeStoreConfig {
  readonly memoryDir: string;
}

// ============================================================================
// Store Operations
// ============================================================================

/**
 * Initialize the knowledge store directory
 */
export async function initKnowledgeStore(
  config: KnowledgeStoreConfig
): Promise<Result<void, StorageError>> {
  const knowledgeDir = getKnowledgeDir(config.memoryDir);

  try {
    await fs.mkdir(knowledgeDir, { recursive: true });
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to create knowledge directory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: knowledgeDir,
    });
  }
}

/**
 * Read a knowledge file by category
 */
export async function readKnowledgeFile(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory
): Promise<Result<KnowledgeFile, StorageError>> {
  const path = getKnowledgeFilePath(config.memoryDir, category);

  try {
    const content = await fs.readFile(path, 'utf-8');
    const parseResult = parseMarkdownWithFrontmatter<KnowledgeFrontmatter>(content, path);

    if (!parseResult.ok) {
      return parseResult;
    }

    const sections = parseSections(parseResult.value.content);

    return Ok({
      frontmatter: {
        category,
        sectionCount: sections.length,
        lastUpdated: parseResult.value.frontmatter.lastUpdated ?? new Date().toISOString(),
      },
      sections,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Return empty file
      return Ok({
        frontmatter: {
          category,
          sectionCount: 0,
          lastUpdated: new Date().toISOString(),
        },
        sections: [],
      });
    }
    return Err({
      type: 'read_error',
      message: `Failed to read knowledge file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Write a knowledge file
 */
export async function writeKnowledgeFile(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory,
  sections: readonly KnowledgeSection[]
): Promise<Result<void, StorageError>> {
  const path = getKnowledgeFilePath(config.memoryDir, category);
  const now = new Date().toISOString();

  const frontmatter: KnowledgeFrontmatter = {
    category,
    sectionCount: sections.length,
    lastUpdated: now,
  };

  let content = `# ${CATEGORY_TITLES[category]}\n\n`;
  content += `> ${CATEGORY_DESCRIPTIONS[category]}\n\n`;

  for (const section of sections) {
    content += serializeSection(section);
  }

  const markdown = serializeMarkdownWithFrontmatter(frontmatter, content);

  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, markdown, 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write knowledge file: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

/**
 * Add a new section to a knowledge category
 */
export async function addSection(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory,
  section: Omit<KnowledgeSection, 'id' | 'first_observed' | 'last_updated' | 'observations'>
): Promise<Result<string, StorageError>> {
  const readResult = await readKnowledgeFile(config, category);
  if (!readResult.ok) {
    return readResult;
  }

  const now = new Date().toISOString();
  const id = `${category.slice(0, 4)}-${uuidv4().slice(0, 8)}`;

  const newSection: KnowledgeSection = {
    ...section,
    id,
    first_observed: now.split('T')[0] ?? now,
    last_updated: now,
    observations: 1,
  };

  const updatedSections = [...readResult.value.sections, newSection];
  const writeResult = await writeKnowledgeFile(config, category, updatedSections);

  if (!writeResult.ok) {
    return writeResult;
  }

  return Ok(id);
}

/**
 * Update an existing section
 */
export async function updateSection(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory,
  sectionId: string,
  updates: Partial<Pick<KnowledgeSection, 'title' | 'content' | 'confidence' | 'related_files' | 'tags' | 'examples' | 'flagged_for_review'>>
): Promise<Result<void, StorageError>> {
  const readResult = await readKnowledgeFile(config, category);
  if (!readResult.ok) {
    return readResult;
  }

  const index = readResult.value.sections.findIndex(s => s.id === sectionId);
  if (index === -1) {
    return Err({
      type: 'read_error',
      message: `Section not found: ${sectionId}`,
      path: getKnowledgeFilePath(config.memoryDir, category),
    });
  }

  const existing = readResult.value.sections[index];
  if (!existing) {
    return Err({
      type: 'read_error',
      message: `Section not found: ${sectionId}`,
      path: getKnowledgeFilePath(config.memoryDir, category),
    });
  }

  const updatedSection: KnowledgeSection = {
    ...existing,
    ...updates,
    last_updated: new Date().toISOString(),
  };

  const updatedSections = [
    ...readResult.value.sections.slice(0, index),
    updatedSection,
    ...readResult.value.sections.slice(index + 1),
  ];

  return writeKnowledgeFile(config, category, updatedSections);
}

/**
 * Confirm/reinforce a section (increment observations, potentially upgrade confidence)
 */
export async function confirmSection(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory,
  sectionId: string
): Promise<Result<void, StorageError>> {
  const readResult = await readKnowledgeFile(config, category);
  if (!readResult.ok) {
    return readResult;
  }

  const index = readResult.value.sections.findIndex(s => s.id === sectionId);
  if (index === -1) {
    return Err({
      type: 'read_error',
      message: `Section not found: ${sectionId}`,
      path: getKnowledgeFilePath(config.memoryDir, category),
    });
  }

  const existing = readResult.value.sections[index];
  if (!existing) {
    return Err({
      type: 'read_error',
      message: `Section not found: ${sectionId}`,
      path: getKnowledgeFilePath(config.memoryDir, category),
    });
  }

  const newObservations = existing.observations + 1;

  // Auto-upgrade confidence based on observations
  let newConfidence = existing.confidence;
  if (newObservations >= 10 && existing.confidence !== 'canonical') {
    newConfidence = 'established';
  } else if (newObservations >= 5 && existing.confidence === 'tentative') {
    newConfidence = 'developing';
  }

  const now = new Date().toISOString();
  const updatedSection: KnowledgeSection = {
    ...existing,
    observations: newObservations,
    confidence: newConfidence,
    last_updated: now,
    last_confirmed: now,  // Confirmation sets last_confirmed timestamp
  };

  const updatedSections = [
    ...readResult.value.sections.slice(0, index),
    updatedSection,
    ...readResult.value.sections.slice(index + 1),
  ];

  return writeKnowledgeFile(config, category, updatedSections);
}

/**
 * Delete a section
 */
export async function deleteSection(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory,
  sectionId: string
): Promise<Result<void, StorageError>> {
  const readResult = await readKnowledgeFile(config, category);
  if (!readResult.ok) {
    return readResult;
  }

  const updatedSections = readResult.value.sections.filter(s => s.id !== sectionId);
  return writeKnowledgeFile(config, category, updatedSections);
}

/**
 * Find a section by title (fuzzy match)
 */
export async function findSectionByTitle(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory,
  titleQuery: string
): Promise<Result<KnowledgeSection | null, StorageError>> {
  const readResult = await readKnowledgeFile(config, category);
  if (!readResult.ok) {
    return readResult;
  }

  const normalizedQuery = titleQuery.toLowerCase();
  const section = readResult.value.sections.find(s =>
    s.title.toLowerCase().includes(normalizedQuery)
  );

  return Ok(section ?? null);
}

/**
 * Search across all knowledge files
 */
export async function searchKnowledge(
  config: KnowledgeStoreConfig,
  query: string
): Promise<Result<Array<{ category: KnowledgeCategory; section: KnowledgeSection }>, StorageError>> {
  const categories: KnowledgeCategory[] = ['conventions', 'architecture', 'decisions', 'gotchas'];
  const results: Array<{ category: KnowledgeCategory; section: KnowledgeSection }> = [];
  const normalizedQuery = query.toLowerCase();

  for (const category of categories) {
    const readResult = await readKnowledgeFile(config, category);
    if (!readResult.ok) {
      continue; // Skip on error, don't fail entire search
    }

    for (const section of readResult.value.sections) {
      const matchesTitle = section.title.toLowerCase().includes(normalizedQuery);
      const matchesContent = section.content.toLowerCase().includes(normalizedQuery);
      const matchesTags = section.tags?.some(t => t.toLowerCase().includes(normalizedQuery));

      if (matchesTitle || matchesContent || matchesTags) {
        results.push({ category, section });
      }
    }
  }

  // Sort by relevance (title matches first, then by observations)
  results.sort((a, b) => {
    const aTitle = a.section.title.toLowerCase().includes(normalizedQuery);
    const bTitle = b.section.title.toLowerCase().includes(normalizedQuery);

    if (aTitle && !bTitle) return -1;
    if (!aTitle && bTitle) return 1;

    return b.section.observations - a.section.observations;
  });

  return Ok(results);
}

/**
 * Read all knowledge across all categories
 */
export async function readAllKnowledge(
  config: KnowledgeStoreConfig
): Promise<Result<Map<KnowledgeCategory, KnowledgeFile>, StorageError>> {
  const categories: KnowledgeCategory[] = ['conventions', 'architecture', 'decisions', 'gotchas'];
  const result = new Map<KnowledgeCategory, KnowledgeFile>();

  for (const category of categories) {
    const readResult = await readKnowledgeFile(config, category);
    if (readResult.ok) {
      result.set(category, readResult.value);
    }
  }

  return Ok(result);
}

/**
 * Generate and update the index file (table of contents)
 */
export async function updateIndex(
  config: KnowledgeStoreConfig
): Promise<Result<void, StorageError>> {
  const allKnowledge = await readAllKnowledge(config);
  if (!allKnowledge.ok) {
    return allKnowledge;
  }

  const now = new Date().toISOString();
  let totalSections = 0;

  let content = `# Knowledge Index\n\n`;
  content += `> Auto-generated table of contents for project knowledge\n\n`;
  content += `Last updated: ${now}\n\n`;

  for (const [category, file] of allKnowledge.value) {
    const categoryTitle = CATEGORY_TITLES[category];
    content += `## ${categoryTitle}\n\n`;
    content += `[${file.sections.length} sections](knowledge/${category}.md)\n\n`;

    if (file.sections.length > 0) {
      // Show top 5 sections by observations
      const topSections = [...file.sections]
        .sort((a, b) => b.observations - a.observations)
        .slice(0, 5);

      for (const section of topSections) {
        content += `- [${section.id}] ${section.title} *(${section.confidence})*\n`;
      }

      if (file.sections.length > 5) {
        content += `- ... and ${file.sections.length - 5} more\n`;
      }
    }

    content += '\n';
    totalSections += file.sections.length;
  }

  content += `---\n\n`;
  content += `**Total**: ${totalSections} knowledge sections across ${allKnowledge.value.size} categories\n`;

  const path = getIndexPath(config.memoryDir);

  try {
    await fs.writeFile(path, content, 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write index: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path,
    });
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Get all categories
 */
export function getAllCategories(): readonly KnowledgeCategory[] {
  return ['conventions', 'architecture', 'decisions', 'gotchas'] as const;
}

/**
 * Get category title
 */
export function getCategoryTitle(category: KnowledgeCategory): string {
  return CATEGORY_TITLES[category];
}

/**
 * Get category description
 */
export function getCategoryDescription(category: KnowledgeCategory): string {
  return CATEGORY_DESCRIPTIONS[category];
}

/**
 * Create a new knowledge section from content
 */
export function createSection(
  title: string,
  content: string,
  options: {
    confidence?: ConfidenceLevel;
    related_files?: readonly string[];
    tags?: readonly string[];
    examples?: readonly string[];
  } = {}
): Omit<KnowledgeSection, 'id' | 'first_observed' | 'last_updated' | 'observations'> {
  return {
    title,
    content,
    confidence: options.confidence ?? 'tentative',
    related_files: options.related_files,
    tags: options.tags,
    examples: options.examples,
  };
}

// ============================================================================
// Staleness Tracking Functions
// ============================================================================

/**
 * Stale knowledge section with category context
 */
export interface StaleKnowledgeSection {
  readonly category: KnowledgeCategory;
  readonly section: KnowledgeSection;
  readonly daysSinceConfirmed: number;
  readonly eligibleForDecay: boolean;    // 30+ days
  readonly eligibleForReview: boolean;   // 90+ days
}

/**
 * Record that a knowledge section was referenced (surfaced to user)
 *
 * ARCHITECTURE: Fire-and-forget pattern - updates last_referenced timestamp
 * Pattern: Called when knowledge is displayed to track usage
 */
export async function recordKnowledgeReference(
  config: KnowledgeStoreConfig,
  category: KnowledgeCategory,
  sectionId: string
): Promise<Result<void, StorageError>> {
  const readResult = await readKnowledgeFile(config, category);
  if (!readResult.ok) {
    return readResult;
  }

  const sections = readResult.value.sections;
  const index = sections.findIndex(s => s.id === sectionId);
  const existing = sections[index];
  if (!existing) {
    // Section not found - not an error for fire-and-forget
    return Ok(undefined);
  }

  const updatedSection: KnowledgeSection = {
    ...existing,
    last_referenced: new Date().toISOString(),
  };

  const updatedSections = [
    ...readResult.value.sections.slice(0, index),
    updatedSection,
    ...readResult.value.sections.slice(index + 1),
  ];

  return writeKnowledgeFile(config, category, updatedSections);
}

/**
 * Find stale knowledge sections eligible for decay or review
 *
 * ARCHITECTURE: Returns sections that need attention based on time thresholds
 * Pattern: NEVER includes canonical confidence - canonical knowledge never decays
 *
 * @param config - Knowledge store configuration
 * @param options - Optional threshold overrides
 * @returns Array of stale sections with metadata
 */
export async function findStaleKnowledge(
  config: KnowledgeStoreConfig,
  options: {
    decayThresholdDays?: number;
    reviewThresholdDays?: number;
  } = {}
): Promise<Result<StaleKnowledgeSection[], StorageError>> {
  const decayThreshold = options.decayThresholdDays ?? DECAY_THRESHOLD_DAYS;
  const reviewThreshold = options.reviewThresholdDays ?? REVIEW_THRESHOLD_DAYS;
  const now = Date.now();
  const staleSections: StaleKnowledgeSection[] = [];

  for (const category of getAllCategories()) {
    const readResult = await readKnowledgeFile(config, category);
    if (!readResult.ok) {
      continue; // Skip on error, don't fail entire search
    }

    for (const section of readResult.value.sections) {
      // CRITICAL: canonical confidence NEVER decays
      if (section.confidence === 'canonical') {
        continue;
      }

      // Use last_confirmed as primary, fall back to last_updated
      const lastConfirmedStr = section.last_confirmed ?? section.last_updated;
      const lastConfirmed = new Date(lastConfirmedStr).getTime();
      const daysSinceConfirmed = Math.floor((now - lastConfirmed) / (1000 * 60 * 60 * 24));

      const eligibleForDecay = daysSinceConfirmed >= decayThreshold;
      const eligibleForReview = daysSinceConfirmed >= reviewThreshold;

      if (eligibleForDecay || eligibleForReview) {
        staleSections.push({
          category,
          section,
          daysSinceConfirmed,
          eligibleForDecay,
          eligibleForReview,
        });
      }
    }
  }

  // Sort by staleness (most stale first)
  staleSections.sort((a, b) => b.daysSinceConfirmed - a.daysSinceConfirmed);

  return Ok(staleSections);
}

/**
 * Decay result from applying confidence decay to a section
 */
export interface DecayResult {
  readonly sectionId: string;
  readonly category: KnowledgeCategory;
  readonly action: 'decayed' | 'flagged_for_review' | 'skipped';
  readonly previousConfidence?: ConfidenceLevel;
  readonly newConfidence?: ConfidenceLevel;
  readonly daysSinceConfirmed: number;
}

/**
 * Apply confidence decay to a stale section
 *
 * ARCHITECTURE: Decays confidence based on time since last confirmation
 * Pattern:
 *   - canonical -> NEVER decays (this function is never called for canonical)
 *   - established + 30 days -> tentative
 *   - developing + 30 days -> tentative
 *   - tentative + 90 days -> flagged for review (no further decay)
 *
 * @param config - Knowledge store configuration
 * @param staleSection - Section to potentially decay
 * @returns Result of decay application
 */
export async function applyConfidenceDecay(
  config: KnowledgeStoreConfig,
  staleSection: StaleKnowledgeSection
): Promise<Result<DecayResult, StorageError>> {
  const { category, section, daysSinceConfirmed, eligibleForDecay, eligibleForReview } = staleSection;

  // Safety check: canonical NEVER decays
  if (section.confidence === 'canonical') {
    return Ok({
      sectionId: section.id,
      category,
      action: 'skipped',
      daysSinceConfirmed,
    });
  }

  // Determine action based on confidence and age
  let newConfidence: ConfidenceLevel | undefined;
  let action: DecayResult['action'] = 'skipped';

  const canDecay = section.confidence === 'established' || section.confidence === 'developing';

  if (canDecay && eligibleForDecay) {
    newConfidence = 'tentative';
    action = 'decayed';
  } else if (section.confidence === 'tentative' && eligibleForReview) {
    // Already tentative - flag for review but don't decay further
    action = 'flagged_for_review';
  }

  // Apply decay if needed
  if (newConfidence) {
    const updateResult = await updateSection(config, category, section.id, {
      confidence: newConfidence,
    });

    if (!updateResult.ok) {
      return updateResult;
    }
  }

  // Persist flagged_for_review timestamp if flagged
  if (action === 'flagged_for_review' && !section.flagged_for_review) {
    const flagResult = await updateSection(config, category, section.id, {
      flagged_for_review: new Date().toISOString(),
    });

    if (!flagResult.ok) {
      return flagResult;
    }
  }

  return Ok({
    sectionId: section.id,
    category,
    action,
    previousConfidence: section.confidence,
    newConfidence,
    daysSinceConfirmed,
  });
}
