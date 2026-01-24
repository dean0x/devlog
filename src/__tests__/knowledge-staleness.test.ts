/**
 * Knowledge Staleness Tracking Tests
 *
 * Tests for confidence decay and staleness tracking functionality.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initKnowledgeStore,
  addSection,
  confirmSection,
  createSection,
  findStaleKnowledge,
  applyConfidenceDecay,
  recordKnowledgeReference,
  readKnowledgeFile,
  writeKnowledgeFile,
  DECAY_THRESHOLD_DAYS,
  REVIEW_THRESHOLD_DAYS,
  type KnowledgeStoreConfig,
  type KnowledgeSection,
  type StaleKnowledgeSection,
} from '../storage/knowledge-store.js';

describe('knowledge-staleness', () => {
  let testDir: string;
  let config: KnowledgeStoreConfig;

  beforeEach(async () => {
    // Create unique temp directory for each test
    testDir = join(tmpdir(), `devlog-staleness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    config = { memoryDir: testDir };
    await initKnowledgeStore(config);
  });

  afterEach(async () => {
    // Clean up test directory
    await fs.rm(testDir, { recursive: true, force: true });
  });

  // ============================================================================
  // Helper Functions
  // ============================================================================

  /**
   * Create a section with a specific last_confirmed date (days ago)
   */
  async function createSectionWithAge(
    title: string,
    confidence: 'tentative' | 'developing' | 'established' | 'canonical',
    daysAgo: number
  ): Promise<string> {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - daysAgo);
    const pastIso = pastDate.toISOString();

    const section: KnowledgeSection = {
      id: `test-${Math.random().toString(36).slice(2, 10)}`,
      title,
      content: `Content for ${title}`,
      confidence,
      first_observed: pastIso.split('T')[0] ?? pastIso,
      last_updated: pastIso,
      last_confirmed: pastIso,
      observations: 5,
    };

    const readResult = await readKnowledgeFile(config, 'conventions');
    if (!readResult.ok) {
      throw new Error('Failed to read knowledge file');
    }

    const sections = [...readResult.value.sections, section];
    const writeResult = await writeKnowledgeFile(config, 'conventions', sections);
    if (!writeResult.ok) {
      throw new Error('Failed to write knowledge file');
    }

    return section.id;
  }

  // ============================================================================
  // findStaleKnowledge Tests
  // ============================================================================

  describe('findStaleKnowledge', () => {
    it('finds sections older than decay threshold', async () => {
      // Create a section that is 35 days old (past 30-day threshold)
      await createSectionWithAge('Old Pattern', 'established', 35);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.section.title).toBe('Old Pattern');
        expect(result.value[0]?.eligibleForDecay).toBe(true);
      }
    });

    it('does not find fresh sections', async () => {
      // Create a section that is only 10 days old
      await createSectionWithAge('Fresh Pattern', 'established', 10);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    it('never finds canonical sections regardless of age', async () => {
      // Create a canonical section that is 100 days old
      await createSectionWithAge('Core Truth', 'canonical', 100);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    it('identifies sections eligible for review (90+ days)', async () => {
      // Create a section that is 95 days old
      await createSectionWithAge('Very Old Pattern', 'tentative', 95);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.eligibleForReview).toBe(true);
      }
    });

    it('accepts custom threshold options', async () => {
      // Create a section that is 15 days old
      await createSectionWithAge('Somewhat Old', 'developing', 15);

      // Default threshold (30 days) should not find it
      const defaultResult = await findStaleKnowledge(config);
      expect(defaultResult.ok).toBe(true);
      if (defaultResult.ok) {
        expect(defaultResult.value.length).toBe(0);
      }

      // Custom threshold (10 days) should find it
      const customResult = await findStaleKnowledge(config, { decayThresholdDays: 10 });
      expect(customResult.ok).toBe(true);
      if (customResult.ok) {
        expect(customResult.value.length).toBe(1);
      }
    });

    it('handles legacy data without last_confirmed field', async () => {
      // Create a section manually without last_confirmed (legacy format)
      const legacySection: KnowledgeSection = {
        id: 'legacy-section',
        title: 'Legacy Pattern',
        content: 'Old content',
        confidence: 'established',
        first_observed: '2020-01-01',
        last_updated: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(), // 45 days ago
        observations: 3,
        // No last_confirmed field - should fall back to last_updated
      };

      const writeResult = await writeKnowledgeFile(config, 'conventions', [legacySection]);
      expect(writeResult.ok).toBe(true);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.section.id).toBe('legacy-section');
      }
    });

    it('sorts results by staleness (most stale first)', async () => {
      await createSectionWithAge('Newer Old', 'developing', 35);
      await createSectionWithAge('Older Old', 'developing', 60);
      await createSectionWithAge('Newest Old', 'developing', 31);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0]?.section.title).toBe('Older Old');
        expect(result.value[2]?.section.title).toBe('Newest Old');
      }
    });
  });

  // ============================================================================
  // applyConfidenceDecay Tests
  // ============================================================================

  describe('applyConfidenceDecay', () => {
    it('decays established to tentative after threshold', async () => {
      const sectionId = await createSectionWithAge('Established Pattern', 'established', 35);

      const staleResult = await findStaleKnowledge(config);
      expect(staleResult.ok).toBe(true);
      if (!staleResult.ok) return;

      const staleSection = staleResult.value[0];
      if (!staleSection) return;

      const decayResult = await applyConfidenceDecay(config, staleSection);

      expect(decayResult.ok).toBe(true);
      if (decayResult.ok) {
        expect(decayResult.value.action).toBe('decayed');
        expect(decayResult.value.previousConfidence).toBe('established');
        expect(decayResult.value.newConfidence).toBe('tentative');
      }

      // Verify the section was actually updated
      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        const updatedSection = readResult.value.sections.find(s => s.id === sectionId);
        expect(updatedSection?.confidence).toBe('tentative');
      }
    });

    it('decays developing to tentative after threshold', async () => {
      await createSectionWithAge('Developing Pattern', 'developing', 40);

      const staleResult = await findStaleKnowledge(config);
      expect(staleResult.ok).toBe(true);
      if (!staleResult.ok) return;

      const staleSection = staleResult.value[0];
      if (!staleSection) return;

      const decayResult = await applyConfidenceDecay(config, staleSection);

      expect(decayResult.ok).toBe(true);
      if (decayResult.ok) {
        expect(decayResult.value.action).toBe('decayed');
        expect(decayResult.value.previousConfidence).toBe('developing');
        expect(decayResult.value.newConfidence).toBe('tentative');
      }
    });

    it('flags tentative sections for review after 90 days', async () => {
      const sectionId = await createSectionWithAge('Tentative Pattern', 'tentative', 95);

      const staleResult = await findStaleKnowledge(config);
      expect(staleResult.ok).toBe(true);
      if (!staleResult.ok) return;

      const staleSection = staleResult.value[0];
      if (!staleSection) return;

      const decayResult = await applyConfidenceDecay(config, staleSection);

      expect(decayResult.ok).toBe(true);
      if (decayResult.ok) {
        expect(decayResult.value.action).toBe('flagged_for_review');
        // Should not decay further - tentative stays tentative
        expect(decayResult.value.newConfidence).toBeUndefined();
      }

      // Verify flagged_for_review timestamp is persisted
      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        const updatedSection = readResult.value.sections.find(s => s.id === sectionId);
        expect(updatedSection?.flagged_for_review).toBeDefined();
        // Verify it's a valid ISO timestamp
        const flagDate = new Date(updatedSection?.flagged_for_review ?? '');
        expect(flagDate.getTime()).not.toBeNaN();
      }
    });

    it('does not overwrite existing flagged_for_review timestamp', async () => {
      // Create a section that was already flagged in the past
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 100);
      const pastFlagDate = new Date();
      pastFlagDate.setDate(pastFlagDate.getDate() - 5);
      const pastIso = pastDate.toISOString();
      const pastFlagIso = pastFlagDate.toISOString();

      const section: KnowledgeSection = {
        id: 'already-flagged',
        title: 'Already Flagged',
        content: 'Content',
        confidence: 'tentative',
        first_observed: pastIso.split('T')[0] ?? pastIso,
        last_updated: pastIso,
        last_confirmed: pastIso,
        observations: 5,
        flagged_for_review: pastFlagIso, // Already flagged 5 days ago
      };

      await writeKnowledgeFile(config, 'conventions', [section]);

      const staleResult = await findStaleKnowledge(config);
      expect(staleResult.ok).toBe(true);
      if (!staleResult.ok) return;

      const staleSection = staleResult.value[0];
      if (!staleSection) return;

      const decayResult = await applyConfidenceDecay(config, staleSection);
      expect(decayResult.ok).toBe(true);

      // Verify the original flag timestamp is preserved
      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        const updatedSection = readResult.value.sections.find(s => s.id === 'already-flagged');
        expect(updatedSection?.flagged_for_review).toBe(pastFlagIso);
      }
    });

    it('skips canonical sections even if passed to decay function', async () => {
      // This should never happen in practice, but test the safety check
      const canonicalSection: StaleKnowledgeSection = {
        category: 'conventions',
        section: {
          id: 'canonical-test',
          title: 'Core Truth',
          content: 'Never changes',
          confidence: 'canonical',
          first_observed: '2020-01-01',
          last_updated: new Date().toISOString(),
          observations: 100,
        },
        daysSinceConfirmed: 100,
        eligibleForDecay: true,
        eligibleForReview: true,
      };

      const decayResult = await applyConfidenceDecay(config, canonicalSection);

      expect(decayResult.ok).toBe(true);
      if (decayResult.ok) {
        expect(decayResult.value.action).toBe('skipped');
      }
    });
  });

  // ============================================================================
  // recordKnowledgeReference Tests
  // ============================================================================

  describe('recordKnowledgeReference', () => {
    it('updates last_referenced timestamp', async () => {
      const section = createSection('Test Pattern', 'Test content');
      const addResult = await addSection(config, 'conventions', section);
      expect(addResult.ok).toBe(true);

      let sectionId = '';
      if (addResult.ok) {
        sectionId = addResult.value;
      }

      // Small delay to ensure timestamps differ
      await new Promise(resolve => setTimeout(resolve, 10));

      const refResult = await recordKnowledgeReference(config, 'conventions', sectionId);
      expect(refResult.ok).toBe(true);

      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        const updatedSection = readResult.value.sections.find(s => s.id === sectionId);
        expect(updatedSection?.last_referenced).toBeDefined();
      }
    });

    it('handles non-existent section gracefully', async () => {
      // Fire-and-forget should not error
      const result = await recordKnowledgeReference(config, 'conventions', 'non-existent-id');
      expect(result.ok).toBe(true);
    });
  });

  // ============================================================================
  // confirmSection Sets last_confirmed Tests
  // ============================================================================

  describe('confirmSection updates last_confirmed', () => {
    it('sets last_confirmed when confirming a section', async () => {
      const section = createSection('Confirmable Pattern', 'Test content');
      const addResult = await addSection(config, 'conventions', section);
      expect(addResult.ok).toBe(true);

      let sectionId = '';
      if (addResult.ok) {
        sectionId = addResult.value;
      }

      // Small delay to ensure timestamps differ
      await new Promise(resolve => setTimeout(resolve, 10));

      const confirmResult = await confirmSection(config, 'conventions', sectionId);
      expect(confirmResult.ok).toBe(true);

      const readResult = await readKnowledgeFile(config, 'conventions');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        const updatedSection = readResult.value.sections.find(s => s.id === sectionId);
        expect(updatedSection?.last_confirmed).toBeDefined();
        expect(updatedSection?.observations).toBe(2); // 1 initial + 1 confirm
      }
    });
  });

  // ============================================================================
  // Constants Tests
  // ============================================================================

  describe('staleness constants', () => {
    it('has correct decay threshold', () => {
      expect(DECAY_THRESHOLD_DAYS).toBe(30);
    });

    it('has correct review threshold', () => {
      expect(REVIEW_THRESHOLD_DAYS).toBe(90);
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('edge cases', () => {
    it('handles empty knowledge store', async () => {
      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    it('handles multiple categories', async () => {
      // Add stale sections to multiple categories
      const pastDate = new Date();
      pastDate.setDate(pastDate.getDate() - 45);
      const pastIso = pastDate.toISOString();

      const staleSection: KnowledgeSection = {
        id: 'arch-stale',
        title: 'Architecture Pattern',
        content: 'Content',
        confidence: 'established',
        first_observed: pastIso.split('T')[0] ?? pastIso,
        last_updated: pastIso,
        last_confirmed: pastIso,
        observations: 2,
      };

      await writeKnowledgeFile(config, 'architecture', [staleSection]);
      await createSectionWithAge('Convention Pattern', 'developing', 40);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        const categories = result.value.map(s => s.category);
        expect(categories).toContain('conventions');
        expect(categories).toContain('architecture');
      }
    });

    it('handles exactly at threshold boundary', async () => {
      // Create section exactly at 30 days
      await createSectionWithAge('Boundary Pattern', 'established', DECAY_THRESHOLD_DAYS);

      const result = await findStaleKnowledge(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(1);
        expect(result.value[0]?.eligibleForDecay).toBe(true);
      }
    });
  });
});
