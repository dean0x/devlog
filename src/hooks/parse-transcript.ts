#!/usr/bin/env node
/**
 * Parse Transcript
 *
 * Extracts the last user prompt and assistant response from a JSONL transcript.
 * Called by extract-memo.sh at Stop hook.
 *
 * Usage:
 *   node parse-transcript.js <transcript_path>
 *
 * Output:
 *   JSON object: { user_prompt, assistant_response }
 */

import { promises as fs } from 'node:fs';

interface TranscriptMessage {
  readonly type: 'user' | 'assistant';
  readonly message?: {
    readonly role?: string;
    readonly content?: string | readonly ContentBlock[];
  };
  readonly content?: string | readonly ContentBlock[];
}

interface ContentBlock {
  readonly type: 'text' | 'tool_use' | 'tool_result';
  readonly text?: string;
}

interface ParsedTurn {
  readonly user_prompt: string;
  readonly assistant_response: string;
}

/**
 * Extract text content from a message
 */
function extractText(content: string | readonly ContentBlock[] | undefined): string {
  if (!content) return '';

  if (typeof content === 'string') {
    return content;
  }

  // Filter to text blocks only, skip tool_use and tool_result
  return content
    .filter((block): block is ContentBlock & { text: string } =>
      block.type === 'text' && typeof block.text === 'string'
    )
    .map(block => block.text)
    .join('\n');
}

/**
 * Read last N lines of a file efficiently
 */
async function readLastLines(filePath: string, maxLines: number = 100): Promise<string[]> {
  const content = await fs.readFile(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  return lines.slice(-maxLines);
}

/**
 * Parse the transcript and find the last user/assistant turn
 */
async function parseTranscript(transcriptPath: string): Promise<ParsedTurn> {
  const lines = await readLastLines(transcriptPath);

  let lastUserPrompt = '';
  let lastAssistantResponse = '';

  // Parse lines in order, keeping track of the last user and assistant messages
  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const entry = JSON.parse(line) as TranscriptMessage;

      if (entry.type === 'user') {
        const content = entry.message?.content ?? entry.content;
        const text = extractText(content);
        if (text) {
          lastUserPrompt = text;
          // Reset assistant response when we see a new user message
          lastAssistantResponse = '';
        }
      } else if (entry.type === 'assistant') {
        const content = entry.message?.content ?? entry.content;
        const text = extractText(content);
        if (text) {
          // Append to assistant response (may be multiple assistant entries)
          lastAssistantResponse += (lastAssistantResponse ? '\n' : '') + text;
        }
      }
    } catch {
      // Skip malformed lines
      continue;
    }
  }

  // Truncate for reasonable memo extraction
  const MAX_PROMPT_LENGTH = 2000;
  const MAX_RESPONSE_LENGTH = 4000;

  return {
    user_prompt: lastUserPrompt.slice(0, MAX_PROMPT_LENGTH),
    assistant_response: lastAssistantResponse.slice(0, MAX_RESPONSE_LENGTH),
  };
}

async function main(): Promise<void> {
  const transcriptPath = process.argv[2];

  if (!transcriptPath) {
    console.error('Usage: parse-transcript.js <transcript_path>');
    process.exit(1);
  }

  try {
    const result = await parseTranscript(transcriptPath);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error('Error parsing transcript:', error instanceof Error ? error.message : 'Unknown error');
    // Output empty result on error
    console.log(JSON.stringify({ user_prompt: '', assistant_response: '' }));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unexpected error:', error);
  process.exit(1);
});
