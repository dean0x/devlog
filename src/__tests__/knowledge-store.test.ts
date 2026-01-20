/**
 * Knowledge Store Tests
 *
 * Smoke tests for knowledge storage CRUD operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initKnowledgeStore,
  readKnowledgeFile,
  writeKnowledgeFile,
  addSection,
  updateSection,
  confirmSection,
  deleteSection,
  findSectionByTitle,
  searchKnowledge,
  readAllKnowledge,
  createSection,
  type KnowledgeStoreConfig,
  type KnowledgeSection,
} from '../storage/knowledge-store.js';

describe('knowledge-store', () => {
  let testDir: string;
  let config: KnowledgeStoreConfig;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `devlog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    config = { memoryDir: testDir };
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe('initKnowledgeStore', () => {
    it('creates knowledge directory', async () => {
      const result = await initKnowledgeStore(config);

      expect(result.ok).toBe(true);
      const stats = await fs.stat(join(testDir, 'knowledge'));
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe('readKnowledgeFile', () => {
    it('returns empty file for non-existent category', async () => {
      const result = await readKnowledgeFile(config, 'conventions');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sections).toHaveLength(0);
        expect(result.value.frontmatter.category).toBe('conventions');
      }
    });
  });

  describe('writeKnowledgeFile / readKnowledgeFile', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
    });

    it('writes and reads knowledge file correctly', async () => {
      const sections: KnowledgeSection[] = [
        {
          id: 'conv-12345678',
          title: 'Use Result types',
          content: 'Always use Result<T, E> for error handling',
          confidence: 'established',
          first_observed: '2024-01-15',
          last_updated: new Date().toISOString(),
          observations: 5,
          tags: ['error-handling', 'patterns'],
        },
      ];

      const writeResult = await writeKnowledgeFile(config, 'conventions', sections);
      expect(writeResult.ok).toBe(true);

      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.sections).toHaveLength(1);
        expect(readResult.value.sections[0]?.title).toBe('Use Result types');
        expect(readResult.value.sections[0]?.confidence).toBe('established');
      }
    });
  });

  describe('addSection', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
    });

    it('adds new section to category', async () => {
      const section = createSection(
        'Dependency Injection',
        'Always inject dependencies through constructor',
        { tags: ['di', 'testing'] }
      );

      const addResult = await addSection(config, 'conventions', section);
      expect(addResult.ok).toBe(true);

      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.sections).toHaveLength(1);
        expect(readResult.value.sections[0]?.title).toBe('Dependency Injection');
        expect(readResult.value.sections[0]?.confidence).toBe('tentative');
        expect(readResult.value.sections[0]?.observations).toBe(1);
      }
    });
  });

  describe('updateSection', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
    });

    it('updates existing section', async () => {
      const section = createSection('Original Title', 'Original content');
      const addResult = await addSection(config, 'architecture', section);
      expect(addResult.ok).toBe(true);

      let sectionId = '';
      if (addResult.ok) {
        sectionId = addResult.value;
      }

      const updateResult = await updateSection(config, 'architecture', sectionId, {
        title: 'Updated Title',
        content: 'Updated content',
      });
      expect(updateResult.ok).toBe(true);

      const readResult = await readKnowledgeFile(config, 'architecture');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.sections[0]?.title).toBe('Updated Title');
        expect(readResult.value.sections[0]?.content).toBe('Updated content');
      }
    });

    it('returns error for non-existent section', async () => {
      const result = await updateSection(config, 'architecture', 'non-existent', {
        title: 'New Title',
      });

      expect(result.ok).toBe(false);
    });
  });

  describe('confirmSection', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
    });

    it('increments observations', async () => {
      const section = createSection('Test Pattern', 'Test content');
      const addResult = await addSection(config, 'conventions', section);
      expect(addResult.ok).toBe(true);

      let sectionId = '';
      if (addResult.ok) {
        sectionId = addResult.value;
      }

      await confirmSection(config, 'conventions', sectionId);
      await confirmSection(config, 'conventions', sectionId);

      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.sections[0]?.observations).toBe(3);
      }
    });

    it('upgrades confidence at thresholds', async () => {
      const section = createSection('Test Pattern', 'Test content');
      const addResult = await addSection(config, 'conventions', section);
      expect(addResult.ok).toBe(true);

      let sectionId = '';
      if (addResult.ok) {
        sectionId = addResult.value;
      }

      // Confirm 4 times to reach 5 observations
      for (let i = 0; i < 4; i++) {
        await confirmSection(config, 'conventions', sectionId);
      }

      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.sections[0]?.confidence).toBe('developing');
      }
    });
  });

  describe('deleteSection', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
    });

    it('removes section from file', async () => {
      const section = createSection('To Delete', 'Delete me');
      const addResult = await addSection(config, 'gotchas', section);
      expect(addResult.ok).toBe(true);

      let sectionId = '';
      if (addResult.ok) {
        sectionId = addResult.value;
      }

      const deleteResult = await deleteSection(config, 'gotchas', sectionId);
      expect(deleteResult.ok).toBe(true);

      const readResult = await readKnowledgeFile(config, 'gotchas');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value.sections).toHaveLength(0);
      }
    });
  });

  describe('findSectionByTitle', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
      await addSection(config, 'conventions', createSection('Error Handling Pattern', 'Use Result types'));
      await addSection(config, 'conventions', createSection('Testing Best Practices', 'Test behaviors'));
    });

    it('finds section by partial title match', async () => {
      const result = await findSectionByTitle(config, 'conventions', 'error');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value?.title).toBe('Error Handling Pattern');
      }
    });

    it('returns null when no match', async () => {
      const result = await findSectionByTitle(config, 'conventions', 'xyz');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('searchKnowledge', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
      await addSection(config, 'conventions', createSection('Error Handling', 'Use Result types'));
      await addSection(config, 'architecture', createSection('Module Structure', 'Organize by feature'));
      await addSection(config, 'gotchas', createSection('Race Condition', 'Watch for errors in async'));
    });

    it('searches across all categories', async () => {
      const result = await searchKnowledge(config, 'error');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeGreaterThanOrEqual(2);
        const titles = result.value.map(r => r.section.title);
        expect(titles).toContain('Error Handling');
      }
    });
  });

  describe('readAllKnowledge', () => {
    beforeEach(async () => {
      await initKnowledgeStore(config);
      await addSection(config, 'conventions', createSection('Convention 1', 'Content'));
      await addSection(config, 'architecture', createSection('Architecture 1', 'Content'));
    });

    it('reads all categories', async () => {
      const result = await readAllKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.size).toBeGreaterThanOrEqual(2);
        expect(result.value.has('conventions')).toBe(true);
        expect(result.value.has('architecture')).toBe(true);
      }
    });
  });

  describe('createSection helper', () => {
    it('creates section with defaults', () => {
      const section = createSection('Title', 'Content');

      expect(section.title).toBe('Title');
      expect(section.content).toBe('Content');
      expect(section.confidence).toBe('tentative');
    });

    it('creates section with options', () => {
      const section = createSection('Title', 'Content', {
        confidence: 'established',
        tags: ['tag1', 'tag2'],
        examples: ['example1'],
      });

      expect(section.confidence).toBe('established');
      expect(section.tags).toEqual(['tag1', 'tag2']);
      expect(section.examples).toEqual(['example1']);
    });
  });
});
