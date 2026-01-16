#!/usr/bin/env node
/**
 * Event Enqueue CLI
 *
 * Called by hook shell scripts to add events to the queue.
 * Reads event data from stdin (JSON) and writes to queue.
 *
 * Usage:
 *   echo '{"event_type":"tool_use",...}' | node enqueue.js
 *
 * Environment:
 *   MEMORY_DIR - Base directory for .memory (default: current working directory)
 */

import { enqueueEvent, initQueue } from '../storage/queue.js';
import type { EventType } from '../types/index.js';
import { join } from 'node:path';

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

async function main(): Promise<void> {
  const memoryDir = process.env['MEMORY_DIR'] ?? process.cwd();
  const queueDir = join(memoryDir, '.memory', 'queue');

  // Initialize queue
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
