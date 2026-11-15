/**
 * SM GPT Express Application Router & Middleware
 * Endpoints:
 *   GET  /api/health
 *   GET  /api/model/status
 *   POST /api/chat
 *   POST /api/chat/stream
 *   POST /api/chat/stop
 */

import express from 'express';
import { BACKEND_CONFIG } from './config.js';
import {
  resolveCorsOrigin,
  sanitizePublicErrorMessage,
  validateChatRequest,
  validateStopRequest,
} from './validation.js';

function writeSseEvent(res, eventName, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createBackendApp({ engine }) {
  const app = express();

  app.disable('x-powered-by');

  // Security & CORS headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    const allowedOrigin = resolveCorsOrigin(req.headers.origin, BACKEND_CONFIG.corsOrigin);
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }

    if (req.method === 'OPTIONS') {
      res.status(allowedOrigin ? 204 : 403).end();
      return;
    }
    next();
  });

  app.use(
    express.json({
      limit: BACKEND_CONFIG.maxRequestBodyBytes,
      strict: true,
    })
  );

  // Handle malformed JSON bodies cleanly without leaking internals
  app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({
        error: {
          code: 'INVALID_JSON',
          message: 'Request body must be valid JSON.',
        },
      });
      return;
    }
    if (err && err.type === 'entity.too.large') {
      res.status(413).json({
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request payload exceeds maximum allowed size.',
        },
      });
      return;
    }
    next(err);
  });

  app.get('/api/health', (_req, res) => {
    const health = engine.getHealthReport();
    res.status(health.ok ? 200 : 503).json(health);
  });

  app.get('/api/model/status', (_req, res) => {
    const status = engine.getPublicStatus();
    res.json(status);
  });

  app.post('/api/chat', async (req, res) => {
    const validation = validateChatRequest(req.body);
    if (!validation.valid) {
      res.status(validation.status).json({
        error: {
          code: validation.code,
          message: validation.message,
        },
      });
      return;
    }

    const { conversationId, requestId, messages, options } = validation.value;
    const disconnectAbort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) {
        disconnectAbort.abort();
      }
    };
    res.on('close', onClose);

    try {
      const result = await engine.runGeneration(
        { conversationId, requestId, messages, options },
        { externalAbortSignal: disconnectAbort.signal }
      );

      if (res.writableEnded || res.destroyed) return;
      res.json({
        requestId,
        conversationId,
        status: result.status,
        text: result.text,
        tokenCount: result.tokenCount,
        finishReason: result.finishReason,
        guardNotice: result.guardNotice,
        durationMs: result.durationMs,
        firstTokenLatencyMs: result.firstTokenLatencyMs,
        tokensPerSec: result.tokensPerSec,
      });
    } catch (err) {
      if (res.writableEnded || res.destroyed) return;
      const code = err?.code || 'GENERATION_FAILED';
      const status =
        code === 'CONVERSATION_BUSY'
          ? 409
          : code === 'QUEUE_FULL'
            ? 429
            : code === 'MODEL_NOT_READY'
              ? 503
              : 500;
      res.status(status).json({
        error: {
          code,
          message: sanitizePublicErrorMessage(err),
        },
      });
    } finally {
      res.off('close', onClose);
    }
  });

  app.post('/api/chat/stream', async (req, res) => {
    const validation = validateChatRequest(req.body);
    if (!validation.valid) {
      res.status(validation.status).json({
        error: {
          code: validation.code,
          message: validation.message,
        },
      });
      return;
    }

    const { conversationId, requestId, messages, options } = validation.value;
    const disconnectAbort = new AbortController();

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const onClose = () => {
      if (!res.writableEnded) {
        disconnectAbort.abort();
      }
    };
    res.on('close', onClose);

    writeSseEvent(res, 'start', { requestId, conversationId });

    try {
      const result = await engine.runGeneration(
        { conversationId, requestId, messages, options },
        {
          externalAbortSignal: disconnectAbort.signal,
          onTokenChunk: (chunk) => {
            writeSseEvent(res, 'token', { requestId, chunk });
          },
        }
      );

      if (res.writableEnded || res.destroyed) return;

      if (result.status === 'cancelled') {
        writeSseEvent(res, 'cancelled', {
          requestId,
          conversationId,
          partialText: result.text,
          tokenCount: result.tokenCount,
          reason: result.finishReason,
        });
      } else {
        writeSseEvent(res, 'complete', {
          requestId,
          conversationId,
          text: result.text,
          tokenCount: result.tokenCount,
          finishReason: result.finishReason,
          guardNotice: result.guardNotice,
          durationMs: result.durationMs,
          firstTokenLatencyMs: result.firstTokenLatencyMs,
          tokensPerSec: result.tokensPerSec,
        });
      }
      res.end();
    } catch (err) {
      if (!res.writableEnded && !res.destroyed) {
        writeSseEvent(res, 'error', {
          requestId,
          code: err?.code || 'GENERATION_FAILED',
          message: sanitizePublicErrorMessage(err),
          recoverable: true,
        });
        res.end();
      }
    } finally {
      res.off('close', onClose);
    }
  });

  app.post('/api/chat/stop', (req, res) => {
    const validation = validateStopRequest(req.body);
    if (!validation.valid) {
      res.status(validation.status).json({
        error: {
          code: validation.code,
          message: validation.message,
        },
      });
      return;
    }

    const result = engine.stopGeneration(validation.value);
    res.json(result);
  });

  return app;
}
