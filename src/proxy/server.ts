/**
 * Anthropic-to-Ollama Proxy Server
 *
 * ARCHITECTURE: Express server implementing Anthropic's /v1/messages API
 * Pattern: Dependency injection via config, streaming via async iterators
 *
 * This proxy allows Claude Code to work with local LLMs via Ollama
 * by translating Anthropic API calls to Ollama format.
 */

import express, { Request, Response, NextFunction } from 'express';
import { parseAnthropicRequest, createErrorResponse } from './anthropic-handler.js';
import { sendOllamaRequest, streamOllamaRequest, checkOllamaHealth } from './ollama-client.js';
import {
  translateRequest,
  translateResponse,
  translateStreamChunk,
  createStreamState,
  formatSSE,
} from './translator.js';
import type { OllamaClientConfig } from './ollama-client.js';

export interface ProxyConfig {
  readonly port: number;
  readonly ollamaBaseUrl: string;
  readonly ollamaModel: string;
  readonly timeout: number;
}

const DEFAULT_CONFIG: ProxyConfig = {
  port: 8082,
  ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
  ollamaModel: process.env['OLLAMA_MODEL'] ?? 'llama3.2',
  timeout: 120000,
};

/**
 * Create and configure the Express application
 */
export function createProxyApp(config: ProxyConfig = DEFAULT_CONFIG): express.Application {
  const app = express();

  // Middleware
  app.use(express.json({ limit: '50mb' }));

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.path}`);
    next();
  });

  // Health check endpoint
  app.get('/health', async (_req: Request, res: Response) => {
    const ollamaConfig: OllamaClientConfig = {
      baseUrl: config.ollamaBaseUrl,
      timeout: 5000,
    };

    const result = await checkOllamaHealth(config.ollamaModel, ollamaConfig);

    if (result.ok) {
      res.json({
        status: 'healthy',
        ollama: {
          url: config.ollamaBaseUrl,
          model: config.ollamaModel,
          available: true,
        },
      });
    } else {
      res.status(503).json({
        status: 'unhealthy',
        ollama: {
          url: config.ollamaBaseUrl,
          model: config.ollamaModel,
          available: false,
          error: result.error.message,
        },
      });
    }
  });

  // Main messages endpoint - Anthropic API compatible
  app.post('/v1/messages', async (req: Request, res: Response) => {
    // Parse and validate request
    const parseResult = parseAnthropicRequest(req.body);
    if (!parseResult.ok) {
      const { status, body } = createErrorResponse(parseResult.error, 400);
      res.status(status).json(body);
      return;
    }

    const anthropicReq = parseResult.value;

    // Translate to Ollama format
    const translateResult = translateRequest(anthropicReq, config.ollamaModel);
    if (!translateResult.ok) {
      const { status, body } = createErrorResponse(translateResult.error, 400);
      res.status(status).json(body);
      return;
    }

    const ollamaReq = translateResult.value;
    const ollamaConfig: OllamaClientConfig = {
      baseUrl: config.ollamaBaseUrl,
      timeout: config.timeout,
    };

    // Handle streaming vs non-streaming
    if (anthropicReq.stream) {
      await handleStreamingRequest(res, ollamaReq, anthropicReq.model, ollamaConfig);
    } else {
      await handleNonStreamingRequest(res, ollamaReq, anthropicReq.model, ollamaConfig);
    }
  });

  // Catch-all for unsupported endpoints
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      type: 'error',
      error: {
        type: 'not_found',
        message: 'Endpoint not found. This proxy only supports /v1/messages',
      },
    });
  });

  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
      type: 'error',
      error: {
        type: 'internal_error',
        message: 'An unexpected error occurred',
      },
    });
  });

  return app;
}

/**
 * Handle non-streaming request
 */
async function handleNonStreamingRequest(
  res: Response,
  ollamaReq: import('../types/index.js').OllamaRequest,
  originalModel: string,
  ollamaConfig: OllamaClientConfig
): Promise<void> {
  const result = await sendOllamaRequest(ollamaReq, ollamaConfig);

  if (!result.ok) {
    const status = result.error.type === 'connection_failed' ? 503 : 500;
    const { body } = createErrorResponse(result.error, status);
    res.status(status).json(body);
    return;
  }

  const anthropicResp = translateResponse(result.value, originalModel);
  res.json(anthropicResp);
}

/**
 * Handle streaming request
 */
async function handleStreamingRequest(
  res: Response,
  ollamaReq: import('../types/index.js').OllamaRequest,
  originalModel: string,
  ollamaConfig: OllamaClientConfig
): Promise<void> {
  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let state = createStreamState(originalModel);

  try {
    for await (const chunkResult of streamOllamaRequest(ollamaReq, ollamaConfig)) {
      if (!chunkResult.ok) {
        // Send error event
        const errorEvent = formatSSE({
          type: 'error',
          error: {
            type: chunkResult.error.type,
            message: chunkResult.error.message,
          },
        });
        res.write(errorEvent);
        res.end();
        return;
      }

      const { events, newState } = translateStreamChunk(chunkResult.value, state);
      state = newState;

      for (const event of events) {
        res.write(formatSSE(event));
      }
    }
  } catch (error) {
    console.error('Streaming error:', error);
    const errorEvent = formatSSE({
      type: 'error',
      error: {
        type: 'internal_error',
        message: 'Stream interrupted',
      },
    });
    res.write(errorEvent);
  }

  res.end();
}

/**
 * Start the proxy server
 */
export async function startProxy(config: ProxyConfig = DEFAULT_CONFIG): Promise<void> {
  const app = createProxyApp(config);

  // Check Ollama health on startup
  console.log(`Checking Ollama connection at ${config.ollamaBaseUrl}...`);
  const ollamaConfig: OllamaClientConfig = {
    baseUrl: config.ollamaBaseUrl,
    timeout: 5000,
  };

  const healthResult = await checkOllamaHealth(config.ollamaModel, ollamaConfig);
  if (!healthResult.ok) {
    console.warn(`Warning: ${healthResult.error.message}`);
    console.warn('The proxy will start but requests may fail until Ollama is available.');
  } else {
    console.log(`Ollama is available with model: ${config.ollamaModel}`);
  }

  // Start server
  app.listen(config.port, () => {
    console.log(`\nAnthropic-to-Ollama proxy running on http://localhost:${config.port}`);
    console.log(`Forwarding to Ollama at ${config.ollamaBaseUrl} using model ${config.ollamaModel}`);
    console.log('\nTo use with Claude Code:');
    console.log(`  ANTHROPIC_BASE_URL=http://localhost:${config.port} claude -p "your prompt"`);
    console.log('\nEndpoints:');
    console.log(`  POST /v1/messages  - Anthropic Messages API`);
    console.log(`  GET  /health       - Health check`);
  });
}

// Main entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const config: ProxyConfig = {
    port: parseInt(process.env['PROXY_PORT'] ?? '8082', 10),
    ollamaBaseUrl: process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    ollamaModel: process.env['OLLAMA_MODEL'] ?? 'llama3.2',
    timeout: parseInt(process.env['PROXY_TIMEOUT'] ?? '120000', 10),
  };

  startProxy(config).catch((error) => {
    console.error('Failed to start proxy:', error);
    process.exit(1);
  });
}
