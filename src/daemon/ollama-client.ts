/**
 * Ollama Client
 *
 * ARCHITECTURE: Direct ollama-js wrapper with Result types
 * Pattern: Simple, focused client for extraction - no proxy, no translation
 *
 * Benefits over proxy approach:
 * - No subprocess spawning (faster)
 * - No HTTP translation layer (simpler)
 * - Direct API calls (debuggable)
 * - All in one process (traceable)
 */

import { Ollama } from 'ollama';
import type { Result, DaemonError } from '../types/index.js';
import { Ok, Err } from '../types/index.js';

// ============================================================================
// Types
// ============================================================================

export interface OllamaClientConfig {
  readonly host: string;
  readonly model: string;
  readonly timeout?: number;
}

export interface GenerateResult {
  readonly response: string;
  readonly totalDuration?: number;
  readonly evalCount?: number;
}

// ============================================================================
// Debug Logging
// ============================================================================

function debugLog(msg: string, data?: Record<string, unknown>): void {
  if (process.env['DEVLOG_DEBUG'] !== '1') return;

  const timestamp = new Date().toTimeString().slice(0, 8);
  let dataStr = '';
  if (data) {
    const pairs = Object.entries(data).map(([k, v]) => {
      const str = typeof v === 'string' ? v : JSON.stringify(v);
      return `${k}=${str.length > 100 ? str.slice(0, 97) + '...' : str}`;
    });
    dataStr = pairs.length > 0 ? ` (${pairs.join(', ')})` : '';
  }
  console.log(`[${timestamp}] [DEBUG] [ollama-client] ${msg}${dataStr}`);
}

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Create an Ollama client instance
 *
 * ARCHITECTURE: Factory function for dependency injection
 */
export function createOllamaClient(config: OllamaClientConfig): Ollama {
  debugLog('Creating Ollama client', { host: config.host, model: config.model });
  return new Ollama({ host: config.host });
}

// ============================================================================
// Health Check
// ============================================================================

/**
 * Check if Ollama is available and the model exists
 */
export async function checkOllamaHealth(
  client: Ollama,
  model: string
): Promise<Result<{ available: boolean; modelLoaded: boolean }, DaemonError>> {
  debugLog('Checking Ollama health', { model });

  try {
    // List available models
    const models = await client.list();
    const modelNames = models.models.map((m) => m.name);

    debugLog('Found models', { count: modelNames.length, models: modelNames.slice(0, 5) });

    // Check if our model is available (handle both with and without :latest suffix)
    const modelLoaded = modelNames.some(
      (name) => name === model || name === `${model}:latest` || name.startsWith(`${model}:`)
    );

    if (!modelLoaded) {
      debugLog('Model not found', { model, available: modelNames });
    }

    return Ok({ available: true, modelLoaded });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    debugLog('Health check failed', { error: message });

    return Err({
      type: 'extraction_error',
      message: `Ollama connection failed: ${message}`,
    });
  }
}

// ============================================================================
// Generate
// ============================================================================

/**
 * Generate a response from Ollama
 *
 * ARCHITECTURE: Simple prompt-in, text-out for extraction
 * Pattern: No streaming needed for memo extraction
 */
export async function generate(
  client: Ollama,
  config: OllamaClientConfig,
  prompt: string
): Promise<Result<GenerateResult, DaemonError>> {
  debugLog('Starting generation', { model: config.model, prompt_length: prompt.length });

  try {
    const response = await client.generate({
      model: config.model,
      prompt,
      stream: false,
      options: {
        temperature: 0.3, // Low temperature for consistent JSON output
        // No num_predict limit - local Ollama has no cost, let model complete naturally
      },
    });

    debugLog('Generation completed', {
      response_length: response.response.length,
      eval_count: response.eval_count,
      total_duration_ms: response.total_duration ? Math.round(response.total_duration / 1_000_000) : undefined,
    });

    return Ok({
      response: response.response,
      totalDuration: response.total_duration,
      evalCount: response.eval_count,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    debugLog('Generation failed', { error: message });

    return Err({
      type: 'extraction_error',
      message: `Ollama generation failed: ${message}`,
    });
  }
}
