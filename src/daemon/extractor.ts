/**
 * Memory Extractor
 *
 * ARCHITECTURE: Spawns Claude Code in headless mode to extract memories
 * Pattern: Uses prompt engineering to get structured JSON output
 *
 * The extractor:
 * 1. Takes a batch of queued events
 * 2. Builds a prompt describing the events
 * 3. Spawns `claude -p` with ANTHROPIC_BASE_URL pointing to proxy
 * 4. Parses JSON from the response
 */

import { spawn } from 'node:child_process';
import type {
  QueuedEvent,
  MemoryEntry,
  ExtractionResult,
  Result,
  DaemonError,
  MemoryType,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export interface ExtractorConfig {
  readonly proxyUrl: string;
  readonly timeout: number;
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the following events from a coding session and extract meaningful memories.

For each significant event, create a memory entry. Focus on:
- Important decisions made
- Patterns observed in the code
- Problems encountered
- Solutions implemented
- Coding conventions followed

Output ONLY a valid JSON object with this exact structure (no markdown, no explanation):
{
  "memories": [
    {
      "type": "decision|pattern|problem|solution|convention",
      "title": "Brief descriptive title",
      "content": "Detailed description of what was learned or decided",
      "confidence": 0.0-1.0,
      "files": ["list", "of", "files"],
      "tags": ["relevant", "tags"]
    }
  ]
}

If no meaningful memories can be extracted, return: {"memories": []}

EVENTS TO ANALYZE:
`;

/**
 * Build the prompt for memory extraction
 */
function buildExtractionPrompt(events: readonly QueuedEvent[]): string {
  let prompt = EXTRACTION_PROMPT;

  for (const event of events) {
    prompt += `\n--- Event: ${event.event_type} at ${event.timestamp} ---\n`;

    if (event.tool_name) {
      prompt += `Tool: ${event.tool_name}\n`;
    }

    if (event.tool_input) {
      const inputStr = typeof event.tool_input === 'string'
        ? event.tool_input
        : JSON.stringify(event.tool_input, null, 2);
      // Truncate large inputs
      prompt += `Input: ${inputStr.slice(0, 2000)}${inputStr.length > 2000 ? '...' : ''}\n`;
    }

    if (event.tool_result) {
      // Truncate large results
      prompt += `Result: ${event.tool_result.slice(0, 1000)}${event.tool_result.length > 1000 ? '...' : ''}\n`;
    }

    if (event.conversation_summary) {
      prompt += `Summary: ${event.conversation_summary}\n`;
    }
  }

  return prompt;
}

/**
 * Parse the extraction response into memories
 */
function parseExtractionResponse(response: string): Result<ExtractionResult, DaemonError> {
  // Try to find JSON in the response
  const jsonMatch = response.match(/\{[\s\S]*"memories"[\s\S]*\}/);
  if (!jsonMatch) {
    return Err({
      type: 'extraction_error',
      message: 'No valid JSON found in extraction response',
    });
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      memories?: Array<{
        type?: string;
        title?: string;
        content?: string;
        confidence?: number;
        files?: string[];
        tags?: string[];
      }>;
    };

    if (!Array.isArray(parsed.memories)) {
      return Err({
        type: 'extraction_error',
        message: 'Response missing memories array',
      });
    }

    const validTypes: MemoryType[] = ['decision', 'pattern', 'problem', 'solution', 'convention'];
    const memories: MemoryEntry[] = [];

    for (const mem of parsed.memories) {
      // Validate and sanitize
      const type = validTypes.includes(mem.type as MemoryType)
        ? (mem.type as MemoryType)
        : 'decision';

      if (!mem.title || !mem.content) {
        continue; // Skip invalid entries
      }

      memories.push({
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        type,
        title: String(mem.title).slice(0, 200),
        content: String(mem.content).slice(0, 2000),
        confidence: typeof mem.confidence === 'number'
          ? Math.max(0, Math.min(1, mem.confidence))
          : 0.5,
        files: Array.isArray(mem.files)
          ? mem.files.filter((f): f is string => typeof f === 'string').slice(0, 10)
          : undefined,
        tags: Array.isArray(mem.tags)
          ? mem.tags.filter((t): t is string => typeof t === 'string').slice(0, 10)
          : undefined,
      });
    }

    return Ok({ memories });
  } catch (error) {
    return Err({
      type: 'extraction_error',
      message: `Failed to parse extraction response: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
}

/**
 * Run Claude Code in headless mode for extraction
 */
async function runClaudeExtraction(
  prompt: string,
  config: ExtractorConfig
): Promise<Result<string, DaemonError>> {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      ANTHROPIC_BASE_URL: config.proxyUrl,
    };

    const child = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: config.timeout,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve(Err({
          type: 'extraction_error',
          message: `Claude exited with code ${code}: ${stderr}`,
        }));
        return;
      }

      resolve(Ok(stdout));
    });

    child.on('error', (error) => {
      resolve(Err({
        type: 'extraction_error',
        message: `Failed to spawn Claude: ${error.message}`,
      }));
    });
  });
}

/**
 * Fallback extraction without Claude (simple heuristics)
 * Used when proxy/Claude isn't available
 */
function fallbackExtraction(events: readonly QueuedEvent[]): ExtractionResult {
  const memories: MemoryEntry[] = [];

  for (const event of events) {
    if (event.event_type === 'tool_use' && event.tool_name) {
      // Extract basic memories from tool usage
      const toolName = event.tool_name;

      if (toolName === 'Edit' || toolName === 'Write') {
        const input = event.tool_input as { file_path?: string; old_string?: string; new_string?: string } | undefined;
        if (input?.file_path) {
          memories.push({
            id: uuidv4(),
            timestamp: event.timestamp,
            type: 'decision',
            title: `Modified ${input.file_path.split('/').pop() ?? 'file'}`,
            content: `Made changes to ${input.file_path}`,
            confidence: 0.6,
            files: [input.file_path],
          });
        }
      }

      if (toolName === 'Bash') {
        const input = event.tool_input as { command?: string } | undefined;
        if (input?.command) {
          // Extract interesting commands
          if (input.command.includes('npm') || input.command.includes('yarn') || input.command.includes('pnpm')) {
            memories.push({
              id: uuidv4(),
              timestamp: event.timestamp,
              type: 'decision',
              title: 'Ran package manager command',
              content: `Executed: ${input.command.slice(0, 200)}`,
              confidence: 0.5,
              tags: ['npm', 'dependencies'],
            });
          }
          if (input.command.includes('git')) {
            memories.push({
              id: uuidv4(),
              timestamp: event.timestamp,
              type: 'decision',
              title: 'Git operation',
              content: `Executed: ${input.command.slice(0, 200)}`,
              confidence: 0.5,
              tags: ['git'],
            });
          }
        }
      }
    }

    if (event.event_type === 'session_end' && event.conversation_summary) {
      memories.push({
        id: uuidv4(),
        timestamp: event.timestamp,
        type: 'decision',
        title: 'Session summary',
        content: event.conversation_summary,
        confidence: 0.7,
      });
    }
  }

  return { memories };
}

/**
 * Extract memories from a batch of events
 */
export async function extractMemories(
  events: readonly QueuedEvent[],
  config: ExtractorConfig
): Promise<Result<ExtractionResult, DaemonError>> {
  if (events.length === 0) {
    return Ok({ memories: [] });
  }

  // Try Claude extraction first
  const prompt = buildExtractionPrompt(events);
  const claudeResult = await runClaudeExtraction(prompt, config);

  if (claudeResult.ok) {
    const parseResult = parseExtractionResponse(claudeResult.value);
    if (parseResult.ok) {
      return parseResult;
    }
    console.warn('Failed to parse Claude response, using fallback:', parseResult.error.message);
  } else {
    console.warn('Claude extraction failed, using fallback:', claudeResult.error.message);
  }

  // Fallback to simple heuristic extraction
  return Ok(fallbackExtraction(events));
}
