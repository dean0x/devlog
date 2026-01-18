#!/usr/bin/env node
/**
 * Event Enqueue CLI
 *
 * Called by hook shell scripts to add events to the global queue.
 * Reads event data from stdin (JSON) and writes to ~/.devlog/queue.
 *
 * Auto-initializes global directories if they don't exist.
 * Includes project_path in events for multi-project routing.
 *
 * Usage:
 *   echo '{"event_type":"tool_use",...}' | node enqueue.js
 *
 * Environment:
 *   DEVLOG_QUEUE_DIR - Queue directory (default: ~/.devlog/queue)
 *   PROJECT_PATH - Project path (default: current working directory)
 */

import { enqueueEvent, initQueue } from '../storage/queue.js';
import { getGlobalQueueDir, initGlobalDirs, isGlobalInitialized } from '../paths.js';
import type { EventType } from '../types/index.js';
import { resolve } from 'node:path';

/**
 * Input from Stop hook for turn_complete events
 */
interface HookInput {
  readonly session_id?: string;
  readonly event_type: EventType;
  readonly project_path?: string;
  readonly user_prompt: string;
  readonly assistant_response: string;
  readonly files_touched?: readonly string[];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf-8');
}

async function ensureGlobalInit(): Promise<void> {
  const initialized = await isGlobalInitialized();
  if (initialized) {
    return;
  }

  const result = await initGlobalDirs();
  if (!result.ok) {
    throw new Error(`Failed to initialize global directories: ${result.error.message}`);
  }
}

async function main(): Promise<void> {
  // Use global queue directory
  const queueDir = getGlobalQueueDir();

  // Get project path from environment or stdin data, default to cwd
  const projectPath = process.env['PROJECT_PATH'] ?? process.cwd();

  // Auto-initialize global dirs if needed
  await ensureGlobalInit();

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

  if (!input.user_prompt) {
    console.error('Missing required field: user_prompt');
    process.exit(1);
  }

  // Resolve project path to absolute
  const resolvedProjectPath = resolve(input.project_path ?? projectPath);

  // Enqueue the turn_complete event
  const result = await enqueueEvent(
    {
      event_type: input.event_type,
      session_id: input.session_id ?? 'unknown',
      project_path: resolvedProjectPath,
      user_prompt: input.user_prompt,
      assistant_response: input.assistant_response ?? '',
      files_touched: input.files_touched ?? [],
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
