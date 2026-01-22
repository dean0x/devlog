/**
 * Debug Writer for Session Knowledge Extraction
 *
 * ARCHITECTURE: File-based debug logging for extraction pipeline
 * Pattern: Activated by DEVLOG_DEBUG=1, writes structured debug files
 *
 * Output structure:
 *   .memory/debug/session-{sessionId}/
 *     01-signals.json              - Input signals from session
 *     02-existing-knowledge.json   - Knowledge context loaded
 *     03-prompt.txt                - Prompt sent to LLM
 *     04-response-raw.txt          - Raw LLM response
 *     05-response-parsed.json      - Parsed decision
 *     06-validation.json           - Validation result
 *     03-prompt-retry-N.txt        - Retry prompts
 *     04-response-raw-retry-N.txt  - Retry responses
 *     ...
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SessionSignal } from '../types/session.js';
import type { KnowledgeCategory, KnowledgeFile, KnowledgeSection } from '../storage/knowledge-store.js';
import type { SessionConsolidationDecision } from './extractor.js';

/**
 * Type for existing knowledge context
 * Accepts either full KnowledgeFile or simplified sections-only format
 */
export type ExistingKnowledgeContext = Map<
  KnowledgeCategory,
  KnowledgeFile | { readonly sections: readonly KnowledgeSection[] }
>;

// ============================================================================
// Types
// ============================================================================

export interface DebugWriterConfig {
  readonly memoryDir: string;
  readonly sessionId: string;
}

export interface ValidationDebugInfo {
  readonly valid: boolean;
  readonly error?: string;
  readonly decision: SessionConsolidationDecision;
}

export interface DebugWriter {
  writeSignals(signals: readonly SessionSignal[]): Promise<void>;
  writeExistingKnowledge(knowledge: ExistingKnowledgeContext): Promise<void>;
  writePrompt(prompt: string, attempt: number): Promise<void>;
  writeRawResponse(response: string, attempt: number): Promise<void>;
  writeParsedDecision(decision: SessionConsolidationDecision, attempt: number): Promise<void>;
  writeValidation(info: ValidationDebugInfo, attempt: number): Promise<void>;
}

// ============================================================================
// Debug Writer Implementation
// ============================================================================

/**
 * Check if debug mode is enabled
 */
export function isDebugEnabled(): boolean {
  return process.env['DEVLOG_DEBUG'] === '1';
}

/**
 * Internal debug writer implementation
 */
class DebugWriterImpl implements DebugWriter {
  private readonly debugDir: string;
  private dirCreated = false;

  constructor(config: DebugWriterConfig) {
    this.debugDir = join(config.memoryDir, 'debug', `session-${config.sessionId}`);
  }

  private async ensureDir(): Promise<void> {
    if (this.dirCreated) return;

    try {
      await fs.mkdir(this.debugDir, { recursive: true });
      this.dirCreated = true;
    } catch (error) {
      console.error(`[debug-writer] Failed to create debug directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async safeWrite(filename: string, content: string): Promise<void> {
    try {
      await this.ensureDir();
      await fs.writeFile(join(this.debugDir, filename), content, 'utf-8');
    } catch (error) {
      console.error(`[debug-writer] Failed to write ${filename}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private formatJson(data: unknown): string {
    return JSON.stringify(data, null, 2);
  }

  private getFilename(base: string, attempt: number, extension: string): string {
    if (attempt === 0) {
      return `${base}.${extension}`;
    }
    return `${base}-retry-${attempt}.${extension}`;
  }

  async writeSignals(signals: readonly SessionSignal[]): Promise<void> {
    await this.safeWrite('01-signals.json', this.formatJson(signals));
  }

  async writeExistingKnowledge(knowledge: ExistingKnowledgeContext): Promise<void> {
    const serializable: Record<string, KnowledgeFile | { readonly sections: readonly KnowledgeSection[] }> = {};
    for (const [category, file] of knowledge) {
      serializable[category] = file;
    }
    await this.safeWrite('02-existing-knowledge.json', this.formatJson(serializable));
  }

  async writePrompt(prompt: string, attempt: number): Promise<void> {
    const filename = this.getFilename('03-prompt', attempt, 'txt');
    await this.safeWrite(filename, prompt);
  }

  async writeRawResponse(response: string, attempt: number): Promise<void> {
    const filename = this.getFilename('04-response-raw', attempt, 'txt');
    await this.safeWrite(filename, response);
  }

  async writeParsedDecision(decision: SessionConsolidationDecision, attempt: number): Promise<void> {
    const filename = this.getFilename('05-response-parsed', attempt, 'json');
    await this.safeWrite(filename, this.formatJson(decision));
  }

  async writeValidation(info: ValidationDebugInfo, attempt: number): Promise<void> {
    const filename = this.getFilename('06-validation', attempt, 'json');
    await this.safeWrite(filename, this.formatJson(info));
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a debug writer for a session
 *
 * Returns null when debug is disabled, allowing optional chaining:
 *   await debugWriter?.writeSignals(signals)
 *
 * ARCHITECTURE: Factory pattern with null return for disabled state
 * Pattern: Callers use optional chaining to avoid conditionals
 */
export function createDebugWriter(config: DebugWriterConfig): DebugWriter | null {
  if (!isDebugEnabled()) {
    return null;
  }
  return new DebugWriterImpl(config);
}
