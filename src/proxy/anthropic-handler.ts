/**
 * Anthropic API Request Handler
 *
 * ARCHITECTURE: Parses and validates incoming Anthropic API requests
 * Pattern: Returns Result types for validation, pure functions
 */

import type {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  Result,
  ProxyError,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';

/**
 * Validate a content block
 */
function isValidContentBlock(block: unknown): block is AnthropicContentBlock {
  if (typeof block !== 'object' || block === null) {
    return false;
  }

  const obj = block as Record<string, unknown>;

  if (typeof obj['type'] !== 'string') {
    return false;
  }

  switch (obj['type']) {
    case 'text':
      return typeof obj['text'] === 'string';
    case 'tool_use':
      return typeof obj['id'] === 'string' && typeof obj['name'] === 'string';
    case 'tool_result':
      return typeof obj['tool_use_id'] === 'string';
    default:
      return false;
  }
}

/**
 * Validate message content
 */
function isValidContent(content: unknown): content is string | AnthropicContentBlock[] {
  if (typeof content === 'string') {
    return true;
  }

  if (Array.isArray(content)) {
    return content.every(isValidContentBlock);
  }

  return false;
}

/**
 * Validate a message
 */
function isValidMessage(msg: unknown): msg is AnthropicMessage {
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }

  const obj = msg as Record<string, unknown>;

  if (obj['role'] !== 'user' && obj['role'] !== 'assistant') {
    return false;
  }

  return isValidContent(obj['content']);
}

/**
 * Parse and validate an Anthropic request body
 */
export function parseAnthropicRequest(body: unknown): Result<AnthropicRequest, ProxyError> {
  if (typeof body !== 'object' || body === null) {
    return Err({
      type: 'invalid_request',
      message: 'Request body must be a JSON object',
    });
  }

  const obj = body as Record<string, unknown>;

  // Validate required fields
  if (typeof obj['model'] !== 'string') {
    return Err({
      type: 'invalid_request',
      message: 'Missing or invalid "model" field',
    });
  }

  if (!Array.isArray(obj['messages'])) {
    return Err({
      type: 'invalid_request',
      message: 'Missing or invalid "messages" field',
    });
  }

  if (typeof obj['max_tokens'] !== 'number') {
    return Err({
      type: 'invalid_request',
      message: 'Missing or invalid "max_tokens" field',
    });
  }

  // Validate messages
  for (let i = 0; i < obj['messages'].length; i++) {
    if (!isValidMessage(obj['messages'][i])) {
      return Err({
        type: 'invalid_request',
        message: `Invalid message at index ${i}`,
      });
    }
  }

  // Validate optional fields
  if (obj['system'] !== undefined && typeof obj['system'] !== 'string') {
    return Err({
      type: 'invalid_request',
      message: 'Invalid "system" field - must be a string',
    });
  }

  if (obj['stream'] !== undefined && typeof obj['stream'] !== 'boolean') {
    return Err({
      type: 'invalid_request',
      message: 'Invalid "stream" field - must be a boolean',
    });
  }

  if (obj['temperature'] !== undefined && typeof obj['temperature'] !== 'number') {
    return Err({
      type: 'invalid_request',
      message: 'Invalid "temperature" field - must be a number',
    });
  }

  if (obj['stop_sequences'] !== undefined) {
    if (!Array.isArray(obj['stop_sequences']) || !obj['stop_sequences'].every((s) => typeof s === 'string')) {
      return Err({
        type: 'invalid_request',
        message: 'Invalid "stop_sequences" field - must be an array of strings',
      });
    }
  }

  const request: AnthropicRequest = {
    model: obj['model'],
    messages: obj['messages'] as AnthropicMessage[],
    max_tokens: obj['max_tokens'],
    system: obj['system'] as string | undefined,
    stream: obj['stream'] as boolean | undefined,
    temperature: obj['temperature'] as number | undefined,
    stop_sequences: obj['stop_sequences'] as string[] | undefined,
  };

  return Ok(request);
}

/**
 * Create an Anthropic API error response
 */
export function createErrorResponse(
  error: ProxyError,
  statusCode: number
): { status: number; body: object } {
  return {
    status: statusCode,
    body: {
      type: 'error',
      error: {
        type: error.type,
        message: error.message,
      },
    },
  };
}
