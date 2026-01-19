/**
 * Global and Project Path Utilities
 *
 * ARCHITECTURE: Centralized path management for global daemon architecture
 * Pattern: All paths computed from well-known locations, no hardcoded paths elsewhere
 *
 * Global structure (~/.devlog/):
 *   config.json          - Global configuration
 *   daemon.status        - Global daemon status
 *   queue/
 *     pending/           - Events from all projects
 *     processing/        - Events being processed
 *     failed/            - Failed events
 *
 * Per-project structure ({project}/.memory/):
 *   short/               - Short-term memories
 *   long/                - Long-term memories
 *   candidates.json      - Promotion candidates
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import type { GlobalConfig, Result, StorageError } from './types/index.js';
import { Ok, Err } from './types/index.js';
import type { SessionConfig } from './types/session.js';
import { DEFAULT_SESSION_CONFIG } from './types/session.js';

// ============================================================================
// Global Paths (setup once, works everywhere)
// ============================================================================

const GLOBAL_DIR_NAME = '.devlog';
const CONFIG_FILE = 'config.json';
const STATUS_FILE = 'daemon.status';
const QUEUE_DIR = 'queue';

/**
 * Get the global devlog directory (~/.devlog/)
 */
export function getGlobalDir(): string {
  return process.env['DEVLOG_HOME'] ?? join(homedir(), GLOBAL_DIR_NAME);
}

/**
 * Get the global queue directory (~/.devlog/queue/)
 */
export function getGlobalQueueDir(): string {
  return process.env['DEVLOG_QUEUE_DIR'] ?? join(getGlobalDir(), QUEUE_DIR);
}

/**
 * Get the global config file path (~/.devlog/config.json)
 */
export function getGlobalConfigPath(): string {
  return join(getGlobalDir(), CONFIG_FILE);
}

/**
 * Get the global daemon status file path (~/.devlog/daemon.status)
 */
export function getGlobalStatusPath(): string {
  return join(getGlobalDir(), STATUS_FILE);
}

// ============================================================================
// Per-Project Paths
// ============================================================================

const PROJECT_MEMORY_DIR = '.memory';

/**
 * Get a project's memory directory ({project}/.memory/)
 */
export function getProjectMemoryDir(projectPath: string): string {
  return join(projectPath, PROJECT_MEMORY_DIR);
}

/**
 * Check if a path looks like a valid project path
 * (exists and is a directory)
 */
export async function isValidProjectPath(path: string): Promise<boolean> {
  try {
    const stat = await fs.stat(path);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ============================================================================
// Global Initialization
// ============================================================================

/**
 * Initialize global devlog directories
 */
export async function initGlobalDirs(): Promise<Result<void, StorageError>> {
  const globalDir = getGlobalDir();
  const queueDir = getGlobalQueueDir();

  const dirs = [
    globalDir,
    join(queueDir, 'pending'),
    join(queueDir, 'processing'),
    join(queueDir, 'failed'),
  ];

  try {
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to create global directories: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: globalDir,
    });
  }
}

/**
 * Check if global devlog is initialized
 */
export async function isGlobalInitialized(): Promise<boolean> {
  const globalDir = getGlobalDir();
  const queueDir = getGlobalQueueDir();

  try {
    await fs.access(globalDir);
    await fs.access(join(queueDir, 'pending'));
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Global Configuration
// ============================================================================

const DEFAULT_CONFIG: GlobalConfig = {
  ollama_base_url: 'http://localhost:11434',
  ollama_model: 'llama3.2',
};

/**
 * Read global configuration
 */
export async function readGlobalConfig(): Promise<Result<GlobalConfig, StorageError>> {
  const configPath = getGlobalConfigPath();

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as GlobalConfig;
    return Ok({ ...DEFAULT_CONFIG, ...config });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(DEFAULT_CONFIG);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read global config: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: configPath,
    });
  }
}

/**
 * Write global configuration
 */
export async function writeGlobalConfig(config: GlobalConfig): Promise<Result<void, StorageError>> {
  const configPath = getGlobalConfigPath();

  try {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write global config: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: configPath,
    });
  }
}

// ============================================================================
// Per-Project Initialization
// ============================================================================

/**
 * Initialize a project's memory directories
 * Auto-called by daemon when processing events for a new project
 */
export async function initProjectMemory(projectPath: string): Promise<Result<void, StorageError>> {
  const memoryDir = getProjectMemoryDir(projectPath);

  const dirs = [
    join(memoryDir, 'short'),
    join(memoryDir, 'short', 'archive'),
    join(memoryDir, 'long'),
  ];

  try {
    for (const dir of dirs) {
      await fs.mkdir(dir, { recursive: true });
    }

    // Create initial memory files if they don't exist
    const today = new Date().toISOString().split('T')[0];
    const shortDir = join(memoryDir, 'short');

    for (const file of ['today.md', 'this-week.md', 'this-month.md']) {
      const filePath = join(shortDir, file);
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, `---
date: ${today}
entries: 0
last_updated: ${new Date().toISOString()}
---
# ${file.replace('.md', '').replace(/-/g, ' ')} - ${today}
`);
      }
    }

    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to initialize project memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: memoryDir,
    });
  }
}

/**
 * Check if a project has memory initialized
 */
export async function isProjectMemoryInitialized(projectPath: string): Promise<boolean> {
  const memoryDir = getProjectMemoryDir(projectPath);

  try {
    await fs.access(join(memoryDir, 'short'));
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Session Configuration
// ============================================================================

/**
 * Read session configuration from global config
 */
export async function readSessionConfig(): Promise<Result<SessionConfig, StorageError>> {
  const configPath = getGlobalConfigPath();

  try {
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as { session?: Partial<SessionConfig> };
    return Ok({
      ...DEFAULT_SESSION_CONFIG,
      ...(config.session ?? {}),
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return Ok(DEFAULT_SESSION_CONFIG);
    }
    return Err({
      type: 'read_error',
      message: `Failed to read session config: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: configPath,
    });
  }
}

/**
 * Write session configuration to global config
 */
export async function writeSessionConfig(
  sessionConfig: Partial<SessionConfig>
): Promise<Result<void, StorageError>> {
  const configPath = getGlobalConfigPath();

  try {
    // Read existing config
    let existing: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      existing = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // File doesn't exist or is invalid, start fresh
    }

    // Merge session config
    const updated = {
      ...existing,
      session: {
        ...(existing['session'] as object ?? {}),
        ...sessionConfig,
      },
    };

    await fs.writeFile(configPath, JSON.stringify(updated, null, 2), 'utf-8');
    return Ok(undefined);
  } catch (error) {
    return Err({
      type: 'write_error',
      message: `Failed to write session config: ${error instanceof Error ? error.message : 'Unknown error'}`,
      path: configPath,
    });
  }
}
