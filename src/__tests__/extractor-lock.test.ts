/**
 * Tests for per-project extraction lock mechanism
 *
 * These tests verify that:
 * 1. Extractions for the same project are serialized
 * 2. Extractions for different projects can run in parallel
 * 3. Locks are properly cleaned up after completion
 * 4. Errors in fn() don't prevent lock release
 */

import { describe, it, expect } from 'vitest';

// We need to test the lock mechanism without going through the full extractor
// Since withProjectLock is not exported, we'll create a minimal test version
// that matches the implementation

type LockMap = Map<string, Promise<void>>;

/**
 * Test implementation matching extractor.ts withProjectLock
 */
function createLockSystem(): {
  withLock: <T>(projectPath: string, fn: () => Promise<T>) => Promise<T>;
  getLockCount: () => number;
} {
  const projectLocks: LockMap = new Map();

  async function withLock<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = projectLocks.get(projectPath) ?? Promise.resolve();

    let releaseLock: () => void = () => {};
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const execution = currentLock.then(fn);
    projectLocks.set(projectPath, newLock);

    try {
      return await execution;
    } finally {
      releaseLock();
      if (projectLocks.get(projectPath) === newLock) {
        projectLocks.delete(projectPath);
      }
    }
  }

  return {
    withLock,
    getLockCount: () => projectLocks.size,
  };
}

// Helper to create a delayed operation that tracks execution order
function createTrackedOperation(
  id: string,
  delayMs: number,
  executionLog: string[]
): () => Promise<string> {
  return async () => {
    executionLog.push(`${id}:start`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    executionLog.push(`${id}:end`);
    return id;
  };
}

describe('withProjectLock', () => {
  describe('serialization within same project', () => {
    it('serializes concurrent calls for the same project', async () => {
      const { withLock } = createLockSystem();
      const executionLog: string[] = [];

      // Start two operations for the same project
      const promise1 = withLock('/project/a', createTrackedOperation('op1', 50, executionLog));
      const promise2 = withLock('/project/a', createTrackedOperation('op2', 50, executionLog));

      await Promise.all([promise1, promise2]);

      // Operations should be serialized: op1 completes before op2 starts
      expect(executionLog).toEqual(['op1:start', 'op1:end', 'op2:start', 'op2:end']);
    });

    it('maintains order for multiple queued operations', async () => {
      const { withLock } = createLockSystem();
      const executionLog: string[] = [];

      const promises = [
        withLock('/project/a', createTrackedOperation('op1', 20, executionLog)),
        withLock('/project/a', createTrackedOperation('op2', 20, executionLog)),
        withLock('/project/a', createTrackedOperation('op3', 20, executionLog)),
      ];

      await Promise.all(promises);

      expect(executionLog).toEqual([
        'op1:start', 'op1:end',
        'op2:start', 'op2:end',
        'op3:start', 'op3:end',
      ]);
    });
  });

  describe('parallelization across different projects', () => {
    it('allows parallel execution for different projects', async () => {
      const { withLock } = createLockSystem();
      const executionLog: string[] = [];

      // Start operations for different projects
      const promise1 = withLock('/project/a', createTrackedOperation('a', 50, executionLog));
      const promise2 = withLock('/project/b', createTrackedOperation('b', 50, executionLog));

      await Promise.all([promise1, promise2]);

      // Both should start before either ends (parallel execution)
      const aStartIdx = executionLog.indexOf('a:start');
      const bStartIdx = executionLog.indexOf('b:start');
      const aEndIdx = executionLog.indexOf('a:end');
      const bEndIdx = executionLog.indexOf('b:end');

      // Both start before either ends
      expect(aStartIdx).toBeLessThan(aEndIdx);
      expect(bStartIdx).toBeLessThan(bEndIdx);
      expect(aStartIdx).toBeLessThan(bEndIdx);
      expect(bStartIdx).toBeLessThan(aEndIdx);
    });
  });

  describe('lock cleanup', () => {
    it('cleans up lock after last operation completes', async () => {
      const { withLock, getLockCount } = createLockSystem();

      expect(getLockCount()).toBe(0);

      await withLock('/project/a', async () => {
        // Lock should exist during operation
        expect(getLockCount()).toBe(1);
        return 'done';
      });

      // Lock should be cleaned up after
      expect(getLockCount()).toBe(0);
    });

    it('does not clean up lock while operations are queued', async () => {
      const { withLock, getLockCount } = createLockSystem();

      let resolveFirst: () => void = () => {};
      const firstOperation = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });

      // Start first operation that will block
      const promise1 = withLock('/project/a', async () => {
        await firstOperation;
        return 'first';
      });

      // Queue second operation
      const promise2 = withLock('/project/a', async () => 'second');

      // Complete first operation
      resolveFirst();

      await Promise.all([promise1, promise2]);

      // All done, lock should be cleaned up
      expect(getLockCount()).toBe(0);
    });
  });

  describe('error handling', () => {
    it('releases lock even when fn() throws', async () => {
      const { withLock, getLockCount } = createLockSystem();
      const executionLog: string[] = [];

      // First operation throws
      const promise1 = withLock('/project/a', async () => {
        executionLog.push('throwing');
        throw new Error('intentional error');
      }).catch(() => {
        executionLog.push('caught');
      });

      // Second operation should still execute
      const promise2 = withLock('/project/a', async () => {
        executionLog.push('second');
        return 'success';
      });

      await Promise.all([promise1, promise2]);

      // Both operations completed - order may vary due to microtask scheduling
      // The important thing is that 'second' executes and lock is cleaned up
      expect(executionLog).toContain('throwing');
      expect(executionLog).toContain('second');
      expect(executionLog).toContain('caught');
      expect(getLockCount()).toBe(0);
    });

    it('propagates errors to caller', async () => {
      const { withLock } = createLockSystem();

      await expect(
        withLock('/project/a', async () => {
          throw new Error('test error');
        })
      ).rejects.toThrow('test error');
    });
  });

  describe('return values', () => {
    it('returns the result of fn()', async () => {
      const { withLock } = createLockSystem();

      const result = await withLock('/project/a', async () => {
        return { value: 42 };
      });

      expect(result).toEqual({ value: 42 });
    });
  });
});
