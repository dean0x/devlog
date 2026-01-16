#!/usr/bin/env node
/**
 * Event Enqueue CLI
 *
 * Called by hook shell scripts to add events to the queue.
 * Reads event data from stdin (JSON) and writes to queue.
 *
 * Auto-initializes .memory directory if it doesn't exist.
 *
 * Usage:
 *   echo '{"event_type":"tool_use",...}' | node enqueue.js
 *
 * Environment:
 *   MEMORY_DIR - Base directory for .memory (default: current working directory)
 */

import { enqueueEvent, initQueue } from '../storage/queue.js';
import { initMemoryStore } from '../storage/memory-store.js';
import type { EventType } from '../types/index.js';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';

interface HookInput {
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly event_type: EventType;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_result?: string;
  readonly conversation_summary?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

async function autoInit(baseDir: string): Promise<void> {
  const memoryPath = join(baseDir, '.memory');

  // Check if .memory already exists
  try {
    await fs.access(memoryPath);
    return; // Already initialized
  } catch {
    // Directory doesn't exist, initialize it
  }

  // Initialize queue directories
  const queueResult = await initQueue({ baseDir: join(memoryPath, 'queue') });
  if (!queueResult.ok) {
    throw new Error(`Failed to initialize queue: ${queueResult.error.message}`);
  }

  // Initialize memory store directories
  const storeResult = await initMemoryStore({ baseDir: memoryPath });
  if (!storeResult.ok) {
    throw new Error(`Failed to initialize memory store: ${storeResult.error.message}`);
  }

  // Create initial memory files
  const today = new Date().toISOString().split('T')[0];
  const shortDir = join(memoryPath, 'short');

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
}

async function main(): Promise<void> {
  const memoryDir = process.env['MEMORY_DIR'] ?? process.cwd();
  const queueDir = join(memoryDir, '.memory', 'queue');

  // Auto-initialize if .memory doesn't exist
  await autoInit(memoryDir);

  // Ensure queue is initialized (idempotent)
  const initResult = await initQueue({ baseDir: queueDir });
  if (!initResult.ok) {
    console.error(`Failed to initialize queue: ${initResult.error.message}`);
    process.exit(1);
  }

  // Read and parse stdin
  let input: HookInput;
  try {
    const stdinData = await readStdin();
    if (stdinData.trim() === '') {
      console.error('No input provided');
      process.exit(1);
    }
    input = JSON.parse(stdinData) as HookInput;
  } catch (error) {
    console.error(`Failed to parse input: ${error instanceof Error ? error.message : 'Unknown error'}`);
    process.exit(1);
  }

  // Validate required fields
  if (!input.event_type) {
    console.error('Missing required field: event_type');
    process.exit(1);
  }

  // Enqueue the event
  const result = await enqueueEvent(
    {
      event_type: input.event_type,
      session_id: input.session_id ?? 'unknown',
      transcript_path: input.transcript_path,
      tool_name: input.tool_name,
      tool_input: input.tool_input,
      tool_result: input.tool_result,
      conversation_summary: input.conversation_summary,
    },
    { baseDir: queueDir }
  );

  if (!result.ok) {
    console.error(`Failed to enqueue event: ${result.error.message}`);
    process.exit(1);
  }

  console.log(`Enqueued event: ${result.value}`);
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
