/**
 * Session Store Tests
 *
 * Smoke tests for session storage CRUD operations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  initSessionStore,
  createSession,
  readSession,
  writeSession,
  deleteSession,
  getOrCreateSession,
  createSignal,
  appendSignal,
  appendSignalAndPersist,
  listSessions,
  type SessionStoreConfig,
} from '../storage/session-store.js';

describe('session-store', () => {
  let testDir: string;
  let config: SessionStoreConfig;

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

  describe('initSessionStore', () => {
    it('creates working directory', async () => {
      const result = await initSessionStore(config);

      expect(result.ok).toBe(true);
      const stats = await fs.stat(join(testDir, 'working'));
      expect(stats.isDirectory()).toBe(true);
    });

    it('succeeds if directory already exists', async () => {
      await fs.mkdir(join(testDir, 'working'), { recursive: true });

      const result = await initSessionStore(config);

      expect(result.ok).toBe(true);
    });
  });

  describe('createSession', () => {
    it('creates session with correct structure', () => {
      const session = createSession('test-session', '/test/project');

      expect(session.session_id).toBe('test-session');
      expect(session.project_path).toBe('/test/project');
      expect(session.turn_count).toBe(0);
      expect(session.signals).toEqual([]);
      expect(session.files_touched_all).toEqual([]);
      expect(session.status).toBe('active');
    });
  });

  describe('writeSession / readSession', () => {
    beforeEach(async () => {
      await initSessionStore(config);
    });

    it('writes and reads session correctly', async () => {
      const session = createSession('test-session', '/test/project');

      const writeResult = await writeSession(config, session);
      expect(writeResult.ok).toBe(true);

      const readResult = await readSession(config, 'test-session');
      expect(readResult.ok).toBe(true);
      if (readResult.ok && readResult.value) {
        expect(readResult.value.session_id).toBe('test-session');
        expect(readResult.value.project_path).toBe('/test/project');
      }
    });

    it('returns null for non-existent session', async () => {
      const result = await readSession(config, 'non-existent');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('deleteSession', () => {
    beforeEach(async () => {
      await initSessionStore(config);
    });

    it('deletes existing session', async () => {
      const session = createSession('test-session', '/test/project');
      await writeSession(config, session);

      const deleteResult = await deleteSession(config, 'test-session');
      expect(deleteResult.ok).toBe(true);

      const readResult = await readSession(config, 'test-session');
      expect(readResult.ok).toBe(true);
      if (readResult.ok) {
        expect(readResult.value).toBeNull();
      }
    });

    it('succeeds when deleting non-existent session', async () => {
      const result = await deleteSession(config, 'non-existent');

      expect(result.ok).toBe(true);
    });
  });

  describe('getOrCreateSession', () => {
    beforeEach(async () => {
      await initSessionStore(config);
    });

    it('creates new session if not exists', async () => {
      const result = await getOrCreateSession(config, 'new-session', '/test/project');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.session_id).toBe('new-session');
        expect(result.value.project_path).toBe('/test/project');
      }
    });

    it('returns existing session if exists', async () => {
      const session = createSession('existing-session', '/test/project');
      const modifiedSession = { ...session, turn_count: 5 };
      await writeSession(config, modifiedSession);

      const result = await getOrCreateSession(config, 'existing-session', '/other/project');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.session_id).toBe('existing-session');
        expect(result.value.turn_count).toBe(5);
        // Should keep original project path
        expect(result.value.project_path).toBe('/test/project');
      }
    });
  });

  describe('createSignal', () => {
    it('creates signal with correct structure', () => {
      const signal = createSignal(1, 'file_touched', 'touched file.ts', ['file.ts']);

      expect(signal.turn_number).toBe(1);
      expect(signal.signal_type).toBe('file_touched');
      expect(signal.content).toBe('touched file.ts');
      expect(signal.files).toEqual(['file.ts']);
      expect(signal.id).toBeDefined();
      expect(signal.timestamp).toBeDefined();
    });
  });

  describe('appendSignal', () => {
    it('appends signal immutably', () => {
      const session = createSession('test-session', '/test/project');
      const signal = createSignal(1, 'file_touched', 'touched file.ts', ['file.ts']);

      const updated = appendSignal(session, signal);

      // Original unchanged
      expect(session.signals).toHaveLength(0);
      expect(session.files_touched_all).toHaveLength(0);

      // Updated has new signal
      expect(updated.signals).toHaveLength(1);
      expect(updated.signals[0]).toBe(signal);
      expect(updated.files_touched_all).toContain('file.ts');
    });

    it('deduplicates files', () => {
      let session = createSession('test-session', '/test/project');
      const signal1 = createSignal(1, 'file_touched', 'touched', ['a.ts', 'b.ts']);
      const signal2 = createSignal(2, 'file_touched', 'touched', ['b.ts', 'c.ts']);

      session = appendSignal(session, signal1);
      session = appendSignal(session, signal2);

      expect(session.files_touched_all).toHaveLength(3);
      expect(session.files_touched_all).toContain('a.ts');
      expect(session.files_touched_all).toContain('b.ts');
      expect(session.files_touched_all).toContain('c.ts');
    });
  });

  describe('appendSignalAndPersist', () => {
    beforeEach(async () => {
      await initSessionStore(config);
    });

    it('creates session and appends signal', async () => {
      const signal = createSignal(1, 'decision_made', 'using Result types');

      const result = await appendSignalAndPersist(
        config,
        'new-session',
        '/test/project',
        signal
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.signals).toHaveLength(1);
      }

      // Verify persisted
      const readResult = await readSession(config, 'new-session');
      expect(readResult.ok).toBe(true);
      if (readResult.ok && readResult.value) {
        expect(readResult.value.signals).toHaveLength(1);
      }
    });
  });

  describe('listSessions', () => {
    beforeEach(async () => {
      await initSessionStore(config);
    });

    it('lists all sessions', async () => {
      await writeSession(config, createSession('session-1', '/p1'));
      await writeSession(config, createSession('session-2', '/p2'));
      await writeSession(config, createSession('session-3', '/p3'));

      const result = await listSessions(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(3);
        expect(result.value).toContain('session-1');
        expect(result.value).toContain('session-2');
        expect(result.value).toContain('session-3');
      }
    });

    it('returns empty array when no sessions', async () => {
      const result = await listSessions(config);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(0);
      }
    });
  });
});
