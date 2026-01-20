/**
 * Precomputed Store Tests
 *
 * Smoke tests for catch-up summary storage and dirty flag operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readPrecomputedSummary,
  writePrecomputedSummary,
  readCatchUpState,
  markCatchUpDirty,
  clearCatchUpDirty,
  shouldRecomputeSummary,
  DEBOUNCE_MS,
  MAX_STALE_MS,
  type PrecomputedSummary,
  type CatchUpState,
} from '../catch-up/precomputed-store.js';

describe('precomputed-store', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `devlog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(join(testDir, 'working'), { recursive: true });
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('readPrecomputedSummary', () => {
    it('returns null for non-existent summary', async () => {
      const result = await readPrecomputedSummary(testDir);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('writePrecomputedSummary / readPrecomputedSummary', () => {
    it('writes and reads summary correctly', async () => {
      const summary: PrecomputedSummary = {
        source_hash: 'abc123',
        summary: 'Test summary content',
        generated_at: new Date().toISOString(),
        status: 'fresh',
      };

      const writeResult = await writePrecomputedSummary(testDir, summary);
      expect(writeResult.ok).toBe(true);

      const readResult = await readPrecomputedSummary(testDir);
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value).not.toBeNull();
        expect(readResult.value?.source_hash).toBe('abc123');
        expect(readResult.value?.summary).toBe('Test summary content');
        expect(readResult.value?.status).toBe('fresh');
      }
    });

    it('preserves error field when present', async () => {
      const summary: PrecomputedSummary = {
        source_hash: 'abc123',
        summary: '',
        generated_at: new Date().toISOString(),
        status: 'stale',
        last_error: 'Ollama connection failed',
      };

      await writePrecomputedSummary(testDir, summary);

      const readResult = await readPrecomputedSummary(testDir);
      expect(readResult.ok).toBe(true);
      if (readResult.ok && readResult.value) {
        expect(readResult.value.last_error).toBe('Ollama connection failed');
      }
    });
  });

  describe('readCatchUpState', () => {
    it('returns null for non-existent state', async () => {
      const result = await readCatchUpState(testDir);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('markCatchUpDirty', () => {
    it('creates dirty state', async () => {
      const result = await markCatchUpDirty(testDir);
      expect(result.ok).toBe(true);

      const readResult = await readCatchUpState(testDir);
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value?.dirty).toBe(true);
        expect(readResult.value?.dirty_since).toBeDefined();
      }
    });

    it('preserves dirty_since when already dirty', async () => {
      // First mark dirty
      await markCatchUpDirty(testDir);

      const firstRead = await readCatchUpState(testDir);
      const originalDirtySince = firstRead.ok ? firstRead.value?.dirty_since : null;

      // Wait a bit and mark dirty again
      await new Promise(resolve => setTimeout(resolve, 10));
      await markCatchUpDirty(testDir);

      const secondRead = await readCatchUpState(testDir);
      expect(secondRead.ok).toBe(true);
      if (secondRead.ok) {
        // dirty_since should not change
        expect(secondRead.value?.dirty_since).toBe(originalDirtySince);
      }
    });
  });

  describe('clearCatchUpDirty', () => {
    it('clears dirty flag', async () => {
      await markCatchUpDirty(testDir);

      const clearResult = await clearCatchUpDirty(testDir);
      expect(clearResult.ok).toBe(true);

      const readResult = await readCatchUpState(testDir);
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value?.dirty).toBe(false);
        expect(readResult.value?.dirty_since).toBeUndefined();
      }
    });
  });

  describe('shouldRecomputeSummary', () => {
    it('returns false when not dirty', () => {
      const state: CatchUpState = { dirty: false };
      const summary: PrecomputedSummary = {
        source_hash: 'abc',
        summary: 'test',
        generated_at: new Date().toISOString(),
        status: 'fresh',
      };

      expect(shouldRecomputeSummary(state, summary)).toBe(false);
    });

    it('returns false when null state', () => {
      const summary: PrecomputedSummary = {
        source_hash: 'abc',
        summary: 'test',
        generated_at: new Date().toISOString(),
        status: 'fresh',
      };

      expect(shouldRecomputeSummary(null, summary)).toBe(false);
    });

    it('returns true when dirty without timestamp', () => {
      const state: CatchUpState = { dirty: true };

      expect(shouldRecomputeSummary(state, null)).toBe(true);
    });

    it('returns false when dirty but within debounce period', () => {
      const now = Date.now();
      const state: CatchUpState = {
        dirty: true,
        dirty_since: new Date(now - 1000).toISOString(), // 1 second ago
      };

      expect(shouldRecomputeSummary(state, null)).toBe(false);
    });

    it('returns true when dirty and debounce period elapsed', () => {
      const now = Date.now();
      const state: CatchUpState = {
        dirty: true,
        dirty_since: new Date(now - DEBOUNCE_MS - 1000).toISOString(),
      };

      expect(shouldRecomputeSummary(state, null)).toBe(true);
    });

    it('returns true when dirty for longer than max stale time', () => {
      const now = Date.now();
      const state: CatchUpState = {
        dirty: true,
        dirty_since: new Date(now - MAX_STALE_MS - 1000).toISOString(),
      };

      expect(shouldRecomputeSummary(state, null)).toBe(true);
    });
  });
});
