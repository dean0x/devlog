/**
 * Ollama API Client
 *
 * ARCHITECTURE: HTTP client for Ollama's /api/chat endpoint
 * Pattern: Returns Result types, streams via async iterators
 */

import type {
  OllamaRequest,
  OllamaResponse,
  OllamaStreamChunk,
  Result,
  ProxyError,
} from '../types/index.js';
import { Ok, Err } from '../types/index.js';

export interface OllamaClientConfig {
  readonly baseUrl: string;
  readonly timeout: number;
}

const DEFAULT_CONFIG: OllamaClientConfig = {
  baseUrl: 'http://localhost:11434',
  timeout: 120000,
};

/**
 * Send a non-streaming request to Ollama
 */
export async function sendOllamaRequest(
  request: OllamaRequest,
  config: OllamaClientConfig = DEFAULT_CONFIG
): Promise<Result<OllamaResponse, ProxyError>> {
  const url = `${config.baseUrl}/api/chat`;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: false }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      return Err({
        type: 'ollama_error',
        message: `Ollama returned ${response.status}: ${errorText}`,
        status: response.status,
      });
    }

    const data = (await response.json()) as OllamaResponse;
    return Ok(data);
  } catch (error) {
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return Err({
          type: 'connection_failed',
          message: `Request timed out after ${config.timeout}ms`,
        });
      }
      return Err({
        type: 'connection_failed',
        message: `Failed to connect to Ollama: ${error.message}`,
      });
    }
    return Err({
      type: 'connection_failed',
      message: 'Unknown connection error',
    });
  }
}

/**
 * Send a streaming request to Ollama
 * Returns an async iterator that yields chunks
 */
export async function* streamOllamaRequest(
  request: OllamaRequest,
  config: OllamaClientConfig = DEFAULT_CONFIG
): AsyncGenerator<Result<OllamaStreamChunk, ProxyError>, void, unknown> {
  const url = `${config.baseUrl}/api/chat`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      yield Err({
        type: 'ollama_error',
        message: `Ollama returned ${response.status}: ${errorText}`,
        status: response.status,
      });
      return;
    }
  } catch (error) {
    if (error instanceof Error) {
      yield Err({
        type: 'connection_failed',
        message: `Failed to connect to Ollama: ${error.message}`,
      });
    } else {
      yield Err({
        type: 'connection_failed',
        message: 'Unknown connection error',
      });
    }
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield Err({
      type: 'ollama_error',
      message: 'No response body from Ollama',
    });
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Ollama sends newline-delimited JSON
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') continue;

        try {
          const chunk = JSON.parse(trimmed) as OllamaStreamChunk;
          yield Ok(chunk);
        } catch {
          yield Err({
            type: 'translation_error',
            message: `Failed to parse Ollama chunk: ${trimmed}`,
          });
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim() !== '') {
      try {
        const chunk = JSON.parse(buffer) as OllamaStreamChunk;
        yield Ok(chunk);
      } catch {
        // Ignore incomplete final chunk
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Check if Ollama is available and the model exists
 */
export async function checkOllamaHealth(
  model: string,
  config: OllamaClientConfig = DEFAULT_CONFIG
): Promise<Result<boolean, ProxyError>> {
  try {
    const response = await fetch(`${config.baseUrl}/api/tags`);
    if (!response.ok) {
      return Err({
        type: 'connection_failed',
        message: `Ollama health check failed: ${response.status}`,
      });
    }

    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    const modelExists = models.some(
      (m) => m.name === model || m.name.startsWith(`${model}:`)
    );

    if (!modelExists) {
      return Err({
        type: 'ollama_error',
        message: `Model '${model}' not found. Available: ${models.map((m) => m.name).join(', ')}`,
      });
    }

    return Ok(true);
  } catch (error) {
    return Err({
      type: 'connection_failed',
      message: `Cannot connect to Ollama at ${config.baseUrl}`,
    });
  }
}
