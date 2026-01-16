/**
 * Anthropic <-> Ollama Format Translator
 *
 * ARCHITECTURE: Pure functions for format conversion
 * Pattern: No side effects, returns Result types for validation
 */

import type {
  AnthropicRequest,
  AnthropicMessage,
  AnthropicContentBlock,
  AnthropicResponse,
  AnthropicStreamEvent,
  OllamaRequest,
  OllamaMessage,
  OllamaResponse,
  OllamaStreamChunk,
  Result,
  ProxyError,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';

// Model mapping from Anthropic models to Ollama
const MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-20250514': 'llama3.2',
  'claude-3-5-sonnet-20241022': 'llama3.2',
  'claude-3-5-haiku-20241022': 'llama3.2:3b',
  'claude-3-opus-20240229': 'llama3.2',
  'claude-3-sonnet-20240229': 'llama3.2',
  'claude-3-haiku-20240307': 'llama3.2:3b',
};

const DEFAULT_OLLAMA_MODEL = 'llama3.2';

/**
 * Extract text content from Anthropic message content
 */
function extractTextContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((block): block is AnthropicContentBlock & { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('\n');
}

/**
 * Convert Anthropic messages to Ollama messages
 * Strips tool_use/tool_result blocks as Ollama doesn't support them
 */
function translateMessages(
  messages: readonly AnthropicMessage[],
  systemPrompt?: string
): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  // Add system prompt if present
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    const textContent = extractTextContent(msg.content);

    // Skip empty messages (e.g., tool-only messages)
    if (textContent.trim() === '') {
      continue;
    }

    result.push({
      role: msg.role,
      content: textContent,
    });
  }

  return result;
}

/**
 * Translate Anthropic request to Ollama request
 */
export function translateRequest(
  anthropicReq: AnthropicRequest,
  modelOverride?: string
): Result<OllamaRequest, ProxyError> {
  // Determine Ollama model
  const ollamaModel = modelOverride ?? MODEL_MAP[anthropicReq.model] ?? DEFAULT_OLLAMA_MODEL;

  // Translate messages
  const messages = translateMessages(anthropicReq.messages, anthropicReq.system);

  if (messages.length === 0) {
    return Err({
      type: 'invalid_request',
      message: 'No valid messages to send to Ollama',
    });
  }

  const ollamaReq: OllamaRequest = {
    model: ollamaModel,
    messages,
    stream: anthropicReq.stream ?? false,
    options: {
      temperature: anthropicReq.temperature,
      num_predict: anthropicReq.max_tokens,
      stop: anthropicReq.stop_sequences ? [...anthropicReq.stop_sequences] : undefined,
    },
  };

  return Ok(ollamaReq);
}

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Translate Ollama response to Anthropic response format
 */
export function translateResponse(
  ollamaResp: OllamaResponse,
  originalModel: string
): AnthropicResponse {
  const content = ollamaResp.message.content;

  return {
    id: generateMessageId(),
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: content }],
    model: originalModel,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: ollamaResp.prompt_eval_count ?? 0,
      output_tokens: ollamaResp.eval_count ?? 0,
    },
  };
}

/**
 * Streaming state for converting Ollama stream to Anthropic SSE
 */
export interface StreamState {
  messageId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  contentStarted: boolean;
}

export function createStreamState(model: string): StreamState {
  return {
    messageId: generateMessageId(),
    model,
    inputTokens: 0,
    outputTokens: 0,
    contentStarted: false,
  };
}

/**
 * Translate Ollama stream chunk to Anthropic stream events
 * May return multiple events for a single chunk
 */
export function translateStreamChunk(
  chunk: OllamaStreamChunk,
  state: StreamState
): { events: AnthropicStreamEvent[]; newState: StreamState } {
  const events: AnthropicStreamEvent[] = [];
  let newState = { ...state };

  // First chunk: send message_start
  if (!state.contentStarted) {
    events.push({
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    events.push({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });

    newState = { ...newState, contentStarted: true };
  }

  // Send content delta
  if (chunk.message.content) {
    events.push({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'text_delta',
        text: chunk.message.content,
      },
    });

    // Estimate tokens (rough: ~4 chars per token)
    newState = {
      ...newState,
      outputTokens: newState.outputTokens + Math.ceil(chunk.message.content.length / 4),
    };
  }

  // Final chunk: send stop events
  if (chunk.done) {
    events.push({
      type: 'content_block_stop',
      index: 0,
    });

    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      usage: { output_tokens: newState.outputTokens },
    });

    events.push({
      type: 'message_stop',
    });
  }

  return { events, newState };
}

/**
 * Format Anthropic stream event as SSE
 */
export function formatSSE(event: AnthropicStreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
