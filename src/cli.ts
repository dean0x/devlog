#!/usr/bin/env node
/**
 * Devlog CLI
 *
 * Global daemon architecture - setup once, works everywhere.
 *
 * Usage:
 *   devlog setup         - Full setup (init + hooks + start daemon)
 *   devlog init          - Initialize global ~/.devlog directory only
 *   devlog daemon        - Start the global memory daemon
 *   devlog status        - Show daemon status (global + current project)
 *   devlog hooks         - Print hook configuration for Claude Code
 *   devlog read [period] - Read memories (today, this-week, this-month)
 */

import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readShortTermMemory } from './storage/memory-store.js';
import { getQueueStats } from './storage/queue.js';
import {
  getGlobalDir,
  getGlobalQueueDir,
  getGlobalStatusPath,
  getGlobalConfigPath,
  getProjectMemoryDir,
  initGlobalDirs,
  isGlobalInitialized,
  readGlobalConfig,
  writeGlobalConfig,
} from './paths.js';
import { handlePostToolUse, handleStop } from './hooks/handlers.js';
import type { DaemonStatus } from './types/index.js';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

async function init(): Promise<void> {
  const globalDir = getGlobalDir();
  const isInitialized = await isGlobalInitialized();

  if (isInitialized) {
    console.log(`Devlog already initialized at ${globalDir}`);
    console.log('\nRun "devlog status" to check daemon status.');
    return;
  }

  console.log(`Initializing Devlog globally at ${globalDir}...`);

  // Initialize global directories
  const result = await initGlobalDirs();
  if (!result.ok) {
    console.error(`Failed to initialize: ${result.error.message}`);
    process.exit(1);
  }

  // Create default config
  const configResult = await readGlobalConfig();
  if (configResult.ok) {
    await writeGlobalConfig(configResult.value);
  }

  console.log('Created global directory structure');
  console.log('Created default configuration');
  console.log('\nNext steps:');
  console.log('  1. Run: devlog hooks');
  console.log('  2. Copy the hooks to ~/.claude/settings.json');
  console.log('  3. Start daemon: devlog daemon');
  console.log('\nThat\'s it! The daemon will auto-create .memory/ in each project as needed.');
}

// Hook command constants - stable CLI interface for Claude Code hooks
const HOOK_COMMAND_POST_TOOL_USE = 'devlog hook:post-tool-use';
const HOOK_COMMAND_STOP = 'devlog hook:stop';

function printHooks(): void {
  const config = {
    hooks: {
      PostToolUse: [{
        matcher: 'Edit|Write',
        hooks: [{
          type: 'command',
          command: HOOK_COMMAND_POST_TOOL_USE,
          timeout: 1000,
        }],
      }],
      Stop: [{
        matcher: {},
        hooks: [{
          type: 'command',
          command: HOOK_COMMAND_STOP,
          timeout: 30000,
        }],
      }],
    },
  };

  console.log('Add this to your ~/.claude/settings.json:\n');
  console.log(JSON.stringify(config, null, 2));
  console.log('\nNote: Merge with existing settings if you have other hooks configured.');
}

// ============================================================================
// Setup Helper Functions
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isDaemonRunning(): Promise<boolean> {
  try {
    const content = await fs.readFile(getGlobalStatusPath(), 'utf-8');
    const status = JSON.parse(content) as DaemonStatus;
    if (status.pid) {
      try {
        process.kill(status.pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  } catch {
    return false;
  }
}

async function promptUser(question: string): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      const normalized = answer.trim().toLowerCase();
      resolve(normalized === '' || normalized === 'y' || normalized === 'yes');
    });
  });
}

async function backupFile(filePath: string): Promise<string | null> {
  try {
    await fs.access(filePath);
    const timestamp = Date.now();
    const backupPath = `${filePath}.${timestamp}.bak`;
    await fs.copyFile(filePath, backupPath);
    return backupPath;
  } catch {
    return null; // File doesn't exist, no backup needed
  }
}

// ============================================================================
// Setup Command
// ============================================================================

interface SetupOptions {
  skipConfirmation?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<void> {
  const { skipConfirmation = false } = options;
  console.log('Setting up Devlog...\n');

  // 1. Initialize global dirs
  const initialized = await isGlobalInitialized();
  if (!initialized) {
    const result = await initGlobalDirs();
    if (!result.ok) {
      console.error(`Failed to initialize: ${result.error.message}`);
      process.exit(1);
    }
    console.log('✓ Created ~/.devlog/');
  } else {
    console.log('✓ ~/.devlog/ already exists');
  }

  // 2. Write default config if missing
  const configPath = getGlobalConfigPath();
  try {
    await fs.access(configPath);
    console.log('✓ Config file exists');
  } catch {
    const configResult = await readGlobalConfig();
    if (configResult.ok) {
      await writeGlobalConfig(configResult.value);
      console.log('✓ Created default config');
    }
  }

  // 3. Configure Claude Code hooks
  const claudeSettingsPath = join(homedir(), '.claude', 'settings.json');

  const postToolUseHook = {
    matcher: 'Edit|Write',
    hooks: [{
      type: 'command',
      command: HOOK_COMMAND_POST_TOOL_USE,
      timeout: 1000,
    }],
  };

  const stopHook = {
    matcher: {},
    hooks: [{
      type: 'command',
      command: HOOK_COMMAND_STOP,
      timeout: 30000,
    }],
  };

  try {
    let settings: Record<string, unknown> = {};
    let settingsExist = false;
    try {
      const content = await fs.readFile(claudeSettingsPath, 'utf-8');
      settings = JSON.parse(content) as Record<string, unknown>;
      settingsExist = true;
    } catch {
      // File doesn't exist, start fresh
    }

    // Get existing hooks or empty object
    const existingHooks = (settings['hooks'] ?? {}) as Record<string, unknown[]>;

    // Helper to check if our hook already exists in an array
    // Detects both new CLI commands and legacy shell script paths for migration
    const hasDevlogHook = (hookArray: unknown[], command: string): boolean => {
      return hookArray.some((entry) => {
        if (typeof entry !== 'object' || entry === null) return false;
        const hooks = (entry as Record<string, unknown>)['hooks'];
        if (!Array.isArray(hooks)) return false;
        return hooks.some((h) => {
          if (typeof h !== 'object' || h === null) return false;
          const hookCommand = (h as Record<string, unknown>)['command'];
          if (typeof hookCommand !== 'string') return false;
          // Match exact command or legacy shell script
          return hookCommand === command ||
            hookCommand.includes('devlog') && hookCommand.includes('hook:');
        });
      });
    };

    // Check if hooks are already installed
    const existingPostToolUse = Array.isArray(existingHooks['PostToolUse'])
      ? existingHooks['PostToolUse']
      : [];
    const existingStop = Array.isArray(existingHooks['Stop'])
      ? existingHooks['Stop']
      : [];

    const needsPostToolUse = !hasDevlogHook(existingPostToolUse, HOOK_COMMAND_POST_TOOL_USE);
    const needsStop = !hasDevlogHook(existingStop, HOOK_COMMAND_STOP);

    if (!needsPostToolUse && !needsStop) {
      console.log('✓ Claude Code hooks already configured');
    } else {
      // Show what exists
      if (settingsExist) {
        console.log(`\nFound existing ${claudeSettingsPath}`);
      }

      // Show what will be added
      console.log('\nWill add the following hooks:');
      if (needsPostToolUse) {
        console.log(`  PostToolUse (Edit|Write): ${HOOK_COMMAND_POST_TOOL_USE}`);
      }
      if (needsStop) {
        console.log(`  Stop: ${HOOK_COMMAND_STOP}`);
      }

      // Ask for confirmation (unless --yes flag is set)
      let confirmed = skipConfirmation;
      if (!skipConfirmation) {
        confirmed = await promptUser('\nProceed with hook configuration? [Y/n] ');
      }

      if (!confirmed) {
        console.log('\nSkipped hook configuration.');
        console.log('Run "devlog hooks" to see the configuration and add manually.');
      } else {
        // Create backup before modification
        const backupPath = await backupFile(claudeSettingsPath);
        if (backupPath) {
          console.log(`\nBackup created: ${backupPath}`);
        }

        // Merge hooks
        if (needsPostToolUse) {
          existingHooks['PostToolUse'] = [...existingPostToolUse, postToolUseHook];
        }
        if (needsStop) {
          existingHooks['Stop'] = [...existingStop, stopHook];
        }

        settings['hooks'] = existingHooks;

        await fs.mkdir(dirname(claudeSettingsPath), { recursive: true });
        await fs.writeFile(claudeSettingsPath, JSON.stringify(settings, null, 2));
        console.log('✓ Configured Claude Code hooks');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`⚠ Failed to configure hooks: ${message}`);
    console.log('  Run "devlog hooks" and add manually to ~/.claude/settings.json');
  }

  // 4. Start daemon (if not running)
  const daemonRunning = await isDaemonRunning();
  if (!daemonRunning) {
    spawn('node', [join(PROJECT_ROOT, 'dist', 'cli.js'), 'daemon'], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    console.log('✓ Started daemon');
  } else {
    console.log('✓ Daemon already running');
  }

  // 5. Wait and verify
  await sleep(2000);
  console.log('\n✓ Setup complete!\n');
  console.log('Devlog is now running. Use Claude Code in any project:');
  console.log('  cd /any/project');
  console.log('  claude');
  console.log('\nView memories with:');
  console.log('  devlog read today');
}

async function runDaemon(): Promise<void> {
  // Import dynamically to avoid loading everything at startup
  const daemonPath = join(PROJECT_ROOT, 'dist', 'daemon', 'memoryd.js');

  // Dynamic import and run
  await import(daemonPath);
}

async function stopDaemon(): Promise<void> {
  const pidFile = join(homedir(), '.devlog', 'daemon.pid');

  try {
    const pidContent = await fs.readFile(pidFile, 'utf-8');
    const pid = parseInt(pidContent.trim(), 10);

    if (isNaN(pid)) {
      console.log('Invalid PID in daemon.pid file.');
      return;
    }

    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID ${pid})`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.log('No daemon PID file found. Daemon may not be running.');
    } else if (err.code === 'ESRCH') {
      console.log('Daemon process not found. Cleaning up stale PID file.');
      await fs.unlink(pidFile).catch(() => {});
    } else {
      console.error('Failed to stop daemon:', error);
    }
  }
}

async function showStatus(): Promise<void> {
  const globalDir = getGlobalDir();
  const statusPath = getGlobalStatusPath();
  const queueDir = getGlobalQueueDir();
  const currentProjectPath = process.cwd();
  const currentProjectMemoryDir = getProjectMemoryDir(currentProjectPath);

  console.log('=== Global Devlog Status ===\n');
  console.log(`Global directory: ${globalDir}`);

  // Check if initialized
  const initialized = await isGlobalInitialized();
  if (!initialized) {
    console.log('\nDevlog is not initialized. Run "devlog init" first.');
    return;
  }

  // Read daemon status
  try {
    const content = await fs.readFile(statusPath, 'utf-8');
    const status = JSON.parse(content) as DaemonStatus;

    console.log(`\nDaemon Status:`);
    console.log(`  Running: ${status.running}`);
    console.log(`  PID: ${status.pid ?? 'N/A'}`);
    console.log(`  Started: ${status.started_at ?? 'N/A'}`);
    console.log(`  Events processed: ${status.events_processed}`);
    console.log(`  Last extraction: ${status.last_extraction ?? 'Never'}`);
    console.log(`  Last decay: ${status.last_decay ?? 'Never'}`);

    // Queue stats
    const queueStats = await getQueueStats({ baseDir: queueDir });
    if (queueStats.ok) {
      console.log(`\nQueue:`);
      console.log(`  Pending: ${queueStats.value.pending}`);
      console.log(`  Processing: ${queueStats.value.processing}`);
      console.log(`  Failed: ${queueStats.value.failed}`);
    }

    // Projects summary
    if (status.projects && Object.keys(status.projects).length > 0) {
      console.log(`\nKnown Projects (${Object.keys(status.projects).length}):`);
      for (const [path, stats] of Object.entries(status.projects)) {
        const isCurrent = path === currentProjectPath ? ' (current)' : '';
        console.log(`  ${path}${isCurrent}`);
        console.log(`    Events: ${stats.events_processed}, Memories: ${stats.memories_extracted}`);
      }
    }
  } catch {
    console.log('\nDaemon is not running.');
  }

  // Current project info
  console.log(`\n=== Current Project ===\n`);
  console.log(`Path: ${currentProjectPath}`);
  console.log(`Memory directory: ${currentProjectMemoryDir}`);

  try {
    await fs.access(currentProjectMemoryDir);
    console.log('Status: Initialized');

    // Read today's memories count
    const todayResult = await readShortTermMemory({ baseDir: currentProjectMemoryDir }, 'today');
    if (todayResult.ok) {
      console.log(`Today's memories: ${todayResult.value.memories.length}`);
    }

    const weekResult = await readShortTermMemory({ baseDir: currentProjectMemoryDir }, 'this-week');
    if (weekResult.ok) {
      console.log(`This week's memories: ${weekResult.value.memories.length}`);
    }
  } catch {
    console.log('Status: Not initialized (will auto-create on first event)');
  }
}

async function readMemories(period: 'today' | 'this-week' | 'this-month'): Promise<void> {
  const memoryDir = getProjectMemoryDir(process.cwd());

  const result = await readShortTermMemory({ baseDir: memoryDir }, period);
  if (!result.ok) {
    if (result.error.type === 'read_error' && result.error.message.includes('ENOENT')) {
      console.log('No memories found for this project yet.');
      console.log('Memories will be auto-created when you use Claude Code with devlog hooks.');
      return;
    }
    console.error(`Failed to read memories: ${result.error.message}`);
    process.exit(1);
  }

  const { memories, date, last_updated } = result.value;

  console.log(`\n=== ${period.toUpperCase()} (${date}) ===`);
  console.log(`Last updated: ${last_updated}\n`);

  if (memories.length === 0) {
    console.log('No memories recorded yet.');
    return;
  }

  for (const memory of memories) {
    const time = memory.timestamp.split('T')[1]?.split('.')[0] ?? '';
    console.log(`[${time}] ${memory.type.toUpperCase()}: ${memory.title}`);
    console.log(`  ${memory.content}`);
    if (memory.files && memory.files.length > 0) {
      console.log(`  Files: ${memory.files.join(', ')}`);
    }
    console.log(`  Confidence: ${(memory.confidence * 100).toFixed(0)}%`);
    console.log();
  }
}

async function showConfig(): Promise<void> {
  const configPath = getGlobalConfigPath();

  console.log(`Config file: ${configPath}\n`);

  const result = await readGlobalConfig();
  if (!result.ok) {
    console.error(`Failed to read config: ${result.error.message}`);
    process.exit(1);
  }

  console.log('Current configuration:');
  console.log(JSON.stringify(result.value, null, 2));
}

function printUsage(): void {
  console.log(`
Devlog - Background memory extraction for Claude Code

Global daemon architecture - setup once, works everywhere.

Usage:
  devlog <command> [options]

Commands:
  setup [--yes]        Full setup (init + hooks + start daemon)
  init                 Initialize global ~/.devlog directory only
  daemon [start] [-d]  Start the global memory daemon (--debug for verbose)
  daemon stop          Stop the running daemon
  status               Show daemon status (global + current project)
  hooks                Print hook configuration for ~/.claude/settings.json
  read [period]        Read memories (today, this-week, this-month)
  config               Show current configuration

Hook Commands (internal, called by Claude Code):
  hook:post-tool-use  Handle PostToolUse events (file tracking)
  hook:stop           Handle Stop events (memo extraction)

Options:
  --yes, -y         Skip confirmation prompts (for setup command)

Environment Variables:
  OLLAMA_BASE_URL   Ollama server URL (default: from config or http://localhost:11434)
  OLLAMA_MODEL      Ollama model (default: from config or llama3.2)
  DEVLOG_HOME       Override global directory (default: ~/.devlog)
  DEVLOG_DEBUG      Enable debug logging (set to 1 or use --debug flag)

Quick Start:
  devlog setup             # One command does everything!

  # Use Claude Code in any project - memories auto-created
  cd /any/project
  claude                   # Just works!

  # View this project's memories
  devlog read today
`);
}

// Main
const command = process.argv[2];

switch (command) {
  case 'setup':
    const setupArgs = process.argv.slice(3);
    const skipConfirmation = setupArgs.includes('--yes') || setupArgs.includes('-y');
    setup({ skipConfirmation });
    break;

  case 'init':
    init();
    break;

  case 'daemon': {
    const daemonArgs = process.argv.slice(3);
    const subcommand = daemonArgs.find(arg => ['start', 'stop'].includes(arg));
    const debugFlag = daemonArgs.includes('--debug') || daemonArgs.includes('-d');

    if (subcommand === 'stop') {
      stopDaemon();
    } else if (subcommand === 'start' || !subcommand || daemonArgs.length === 0 || (daemonArgs.length === 1 && debugFlag)) {
      // Set debug mode environment variable before running daemon
      if (debugFlag) {
        process.env['DEVLOG_DEBUG'] = '1';
      }
      runDaemon();
    } else {
      console.error(`Unknown daemon subcommand: ${subcommand}`);
      console.log('Usage: devlog daemon [start|stop] [--debug]');
      process.exit(1);
    }
    break;
  }

  case 'status':
    showStatus();
    break;

  case 'hooks':
    printHooks();
    break;

  case 'read':
    const period = (process.argv[3] ?? 'today') as 'today' | 'this-week' | 'this-month';
    if (!['today', 'this-week', 'this-month'].includes(period)) {
      console.error('Invalid period. Use: today, this-week, or this-month');
      process.exit(1);
    }
    readMemories(period);
    break;

  case 'config':
    showConfig();
    break;

  // Hook commands (called by Claude Code, not user-facing)
  case 'hook:post-tool-use':
    handlePostToolUse().then(() => {
      // Always exit cleanly - don't break Claude Code on errors
      process.exit(0);
    }).catch(() => {
      process.exit(0);
    });
    break;

  case 'hook:stop':
    handleStop().then(() => {
      // Always exit cleanly - don't break Claude Code on errors
      process.exit(0);
    }).catch(() => {
      process.exit(0);
    });
    break;

  case 'help':
  case '--help':
  case '-h':
  case undefined:
    printUsage();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
