#!/usr/bin/env node
/**
 * Devlog CLI
 *
 * Usage:
 *   devlog init          - Initialize .memory in current directory
 *   devlog proxy         - Start the Anthropic-to-Ollama proxy
 *   devlog daemon        - Start the memory daemon
 *   devlog status        - Show daemon status
 *   devlog hooks         - Print hook configuration for Claude Code
 *   devlog read [period] - Read memories (today, this-week, this-month)
 */

import { join, resolve } from 'node:path';
import { promises as fs } from 'node:fs';
import { startProxy } from './proxy/server.js';
import { initQueue } from './storage/queue.js';
import { initMemoryStore, readShortTermMemory } from './storage/memory-store.js';

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

async function init(): Promise<void> {
  const cwd = process.cwd();
  const memoryDir = join(cwd, '.memory');

  console.log(`Initializing Devlog in ${cwd}...`);

  // Initialize queue
  const queueResult = await initQueue({ baseDir: join(memoryDir, 'queue') });
  if (!queueResult.ok) {
    console.error(`Failed to initialize queue: ${queueResult.error.message}`);
    process.exit(1);
  }

  // Initialize memory store
  const storeResult = await initMemoryStore({ baseDir: memoryDir });
  if (!storeResult.ok) {
    console.error(`Failed to initialize memory store: ${storeResult.error.message}`);
    process.exit(1);
  }

  // Create initial memory files
  const today = new Date().toISOString().split('T')[0];
  const shortDir = join(memoryDir, 'short');

  for (const file of ['today.md', 'this-week.md', 'this-month.md']) {
    const path = join(shortDir, file);
    try {
      await fs.access(path);
    } catch {
      await fs.writeFile(path, `---
date: ${today}
entries: 0
last_updated: ${new Date().toISOString()}
---
# ${file.replace('.md', '').replace(/-/g, ' ')} - ${today}
`);
    }
  }

  console.log('✓ Created .memory directory structure');
  console.log('✓ Initialized queue directories');
  console.log('✓ Created memory files');
  console.log('\nNext steps:');
  console.log('  1. Run: devlog hooks');
  console.log('  2. Copy the hooks to ~/.claude/settings.json');
  console.log('  3. Start proxy: devlog proxy');
  console.log('  4. Start daemon: devlog daemon');
}

function printHooks(): void {
  const hooksDir = join(PROJECT_ROOT, 'dist', 'hooks');

  const config = {
    hooks: {
      PostToolUse: [{
        matcher: {},
        hooks: [{
          type: 'command',
          command: join(hooksDir, 'post-tool-use.sh'),
          timeout: 5000,
        }],
      }],
      Stop: [{
        matcher: {},
        hooks: [{
          type: 'command',
          command: join(hooksDir, 'session-end.sh'),
          timeout: 10000,
        }],
      }],
    },
  };

  console.log('Add this to your ~/.claude/settings.json:\n');
  console.log(JSON.stringify(config, null, 2));
  console.log('\nNote: Merge with existing settings if you have other hooks configured.');
}

async function runProxy(): Promise<void> {
  const config = {
    port: parseInt(process.env['PROXY_PORT'] ?? '8082', 10),
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    ollamaModel: process.env['OLLAMA_MODEL'] ?? 'llama3.2',
    timeout: parseInt(process.env['PROXY_TIMEOUT'] ?? '120000', 10),
  };

  await startProxy(config);
}

async function runDaemon(): Promise<void> {
  // Import dynamically to avoid loading everything at startup
  const daemonPath = join(PROJECT_ROOT, 'dist', 'daemon', 'memoryd.js');

  // Set environment for current directory
  process.env['MEMORY_DIR'] = process.env['MEMORY_DIR'] ?? join(process.cwd(), '.memory');
  process.env['QUEUE_DIR'] = process.env['QUEUE_DIR'] ?? join(process.cwd(), '.memory', 'queue');

  // Dynamic import and run
  await import(daemonPath);
}

async function showStatus(): Promise<void> {
  const memoryDir = join(process.cwd(), '.memory');
  const statusPath = join(memoryDir, '..', '.memory', 'daemon.status');

  try {
    const content = await fs.readFile(statusPath, 'utf-8');
    const status = JSON.parse(content);
    console.log('Memory Daemon Status:');
    console.log(`  Running: ${status.running}`);
    console.log(`  PID: ${status.pid ?? 'N/A'}`);
    console.log(`  Started: ${status.started_at ?? 'N/A'}`);
    console.log(`  Events processed: ${status.events_processed}`);
    console.log(`  Last extraction: ${status.last_extraction ?? 'Never'}`);
    console.log(`  Last decay: ${status.last_decay ?? 'Never'}`);
  } catch {
    console.log('Daemon is not running or status file not found.');
    console.log(`Expected status file at: ${statusPath}`);
  }
}

async function readMemories(period: 'today' | 'this-week' | 'this-month'): Promise<void> {
  const memoryDir = join(process.cwd(), '.memory');

  const result = await readShortTermMemory({ baseDir: memoryDir }, period);
  if (!result.ok) {
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

function printUsage(): void {
  console.log(`
Devlog - Background memory extraction for Claude Code

Usage:
  devlog <command> [options]

Commands:
  init              Initialize .memory in current directory
  proxy             Start the Anthropic-to-Ollama proxy server
  daemon            Start the memory daemon for current directory
  status            Show daemon status
  hooks             Print hook configuration for ~/.claude/settings.json
  read [period]     Read memories (today, this-week, this-month)

Environment Variables:
  PROXY_PORT        Proxy server port (default: 8082)
  OLLAMA_BASE_URL   Ollama server URL (default: http://localhost:11434)
  OLLAMA_MODEL      Ollama model (default: llama3.2)
  MEMORY_DIR        Memory storage directory (default: ./.memory)

Examples:
  # Set up a new project
  cd /my/project
  devlog init
  devlog hooks  # Copy output to ~/.claude/settings.json

  # Start services (in separate terminals)
  devlog proxy
  devlog daemon

  # View today's memories
  devlog read today
`);
}

// Main
const command = process.argv[2];

switch (command) {
  case 'init':
    init();
    break;

  case 'proxy':
    runProxy();
    break;

  case 'daemon':
    runDaemon();
    break;

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
