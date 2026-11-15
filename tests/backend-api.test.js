import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBackendApp } from '../backend/app.js';
import { parseSseBuffer } from '../lib/api-client.js';

function createStubEngine() {
  const active = new Map();
  return {
    getPublicStatus() {
      return {
        status: 'ready',
        ready: true,
        message: 'Ready',
        activeRequests: active.size,
        queuedRequests: 0,
        uptimeSec: 12,
      };
    },
    getHealthReport() {
      return {
        ok: true,
        status: 'ready',
        ready: true,
        uptimeSec: 12,
        activeGenerations: active.size,
        queuedGenerations: 0,
        memoryRssMb: 120,
        metrics: { loadTimeMs: 1200 },
      };
    },
    stopGeneration({ requestId, conversationId }) {
      for (const [key, job] of active.entries()) {
        if ((requestId && job.requestId === requestId) || (conversationId && job.conversationId === conversationId)) {
          job.cancelled = true;
          job.abort.abort();
          active.delete(key);
          return { stopped: true, requestId: job.requestId, conversationId: job.conversationId };
        }
      }
      return { stopped: false, requestId, conversationId };
    },
    async runGeneration({ conversationId, requestId, messages }, { onTokenChunk, externalAbortSignal }) {
      if (active.has(conversationId)) {
        const err = new Error('CONVERSATION_BUSY');
        err.code = 'CONVERSATION_BUSY';
        throw err;
      }
      const abort = new AbortController();
      const job = { requestId, conversationId, cancelled: false, abort };
      active.set(conversationId, job);

      const onExternal = () => abort.abort();
      externalAbortSignal?.addEventListener('abort', onExternal, { once: true });

      try {
        const chunks = ['I am ', 'SM GPT, ', 'created by Abdus Nilom.'];
        let built = '';
        for (const chunk of chunks) {
          if (abort.signal.aborted) {
            return {
              status: 'cancelled',
              text: built,
              tokenCount: 2,
              finishReason: 'cancelled',
              guardNotice: null,
              durationMs: 25,
              firstTokenLatencyMs: 5,
              tokensPerSec: 40,
            };
          }
          built += chunk;
          onTokenChunk?.(chunk);
          await new Promise((r) => setTimeout(r, messages[0].content === 'SLOW' ? 80 : 5));
        }
        return {
          status: 'completed',
          text: built,
          tokenCount: 8,
          finishReason: 'stop',
          guardNotice: null,
          durationMs: 30,
          firstTokenLatencyMs: 5,
          tokensPerSec: 60,
        };
      } finally {
        externalAbortSignal?.removeEventListener('abort', onExternal);
        active.delete(conversationId);
      }
    },
  };
}

async function withServer(fn) {
  const app = createBackendApp({ engine: createStubEngine() });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('API health, model status, sync chat, SSE streaming, and stop endpoints work cleanly', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);
    assert.equal(health.ready, true);

    const status = await fetch(`${baseUrl}/api/model/status`).then((r) => r.json());
    assert.equal(status.message, 'Ready');
    assert.equal(/Qwen|GGUF|Q8/i.test(JSON.stringify(status)), false);

    // Sync chat
    const chatRes = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'c1',
        requestId: 'r1',
        messages: [{ role: 'user', content: 'Who created you?' }],
      }),
    });
    assert.equal(chatRes.status, 200);
    const chatJson = await chatRes.json();
    assert.equal(chatJson.text, 'I am SM GPT, created by Abdus Nilom.');

    // Streaming SSE chat
    const streamRes = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'c2',
        requestId: 'r2',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });
    assert.equal(streamRes.status, 200);
    const rawSse = await streamRes.text();
    const parsed = parseSseBuffer(`${rawSse}\n\n`);
    const tokens = parsed.events.filter((e) => e.event === 'token').map((e) => e.data.chunk);
    const complete = parsed.events.find((e) => e.event === 'complete');
    assert.equal(tokens.join(''), 'I am SM GPT, created by Abdus Nilom.');
    assert.equal(complete.data.status, undefined);
    assert.equal(complete.data.text, 'I am SM GPT, created by Abdus Nilom.');

    // Stop active stream mid-flight
    const slowStreamPromise = fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'c3',
        requestId: 'r3',
        messages: [{ role: 'user', content: 'SLOW' }],
      }),
    });
    await new Promise((r) => setTimeout(r, 35));
    const stopRes = await fetch(`${baseUrl}/api/chat/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'r3', conversationId: 'c3' }),
    }).then((r) => r.json());
    assert.equal(stopRes.stopped, true);

    const slowText = await (await slowStreamPromise).text();
    const slowEvents = parseSseBuffer(`${slowText}\n\n`).events;
    const cancelledEvt = slowEvents.find((e) => e.event === 'cancelled');
    assert.ok(cancelledEvt, 'Expected cancelled SSE event after /api/chat/stop');
    assert.ok(cancelledEvt.data.partialText.length > 0, 'Expected partial text preservation');
  });
});
