import test from 'node:test';
import assert from 'node:assert/strict';
import { InferenceEngine } from '../backend/inference-engine.js';

test('Backend InferenceEngine runs Qwen3.5-0.8B Q8_0 once, streams tokens, preserves context, enforces Abdus Nilom identity, and stops cleanly', async () => {
  const engine = new InferenceEngine();
  await engine.init();

  const health = engine.getHealthReport();
  assert.equal(health.ready, true);
  assert.ok(health.metrics.loadTimeMs > 0);
  console.log('[Benchmark] Model load ms:', health.metrics.loadTimeMs, 'RSS MB:', health.metrics.memoryAfterLoadMb);

  // 1. Identity verification
  const streamedChunks = [];
  const idRes = await engine.runGeneration(
    {
      conversationId: 'real_conv_1',
      requestId: 'real_req_1',
      messages: [{ role: 'user', content: 'Who are you and who created you?' }],
      options: {
        maxNewTokens: 120,
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        repetitionPenalty: 1.1,
        verificationMode: 'standard',
      },
    },
    {
      onTokenChunk: (chunk) => streamedChunks.push(chunk),
    }
  );

  console.log('[Identity Response]:', idRes.text);
  console.log('[Benchmark] First-token ms:', idRes.firstTokenLatencyMs, 'Tokens/sec:', idRes.tokensPerSec, 'Duration ms:', idRes.durationMs);
  assert.equal(idRes.status, 'completed');
  assert.ok(streamedChunks.length > 0, 'Expected live streamed chunks');
  assert.ok(idRes.text.includes('SM GPT'), 'Expected SM GPT self-identification');
  assert.ok(idRes.text.includes('Abdus Nilom'), 'Expected Abdus Nilom creator attribution');
  assert.equal(/i am human|i am a human/i.test(idRes.text), false);

  // 2. Multi-turn context retention
  const ctxRes = await engine.runGeneration({
    conversationId: 'real_conv_2',
    requestId: 'real_req_2',
    messages: [
      { role: 'user', content: 'The project code for this chat is SILVER-42.' },
      { role: 'assistant', content: 'Understood. The project code for this chat is SILVER-42.' },
      { role: 'user', content: 'What is the project code I just mentioned in this chat?' },
    ],
    options: {
      maxNewTokens: 80,
      temperature: 0.1,
      topP: 0.9,
      topK: 40,
      repetitionPenalty: 1.1,
      verificationMode: 'standard',
    },
  });
  console.log('[Context Response]:', ctxRes.text);
  assert.ok(ctxRes.text.includes('SILVER-42'), 'Expected context memory retention');

  // 3. Cancellation mid-generation preserves partial text
  const stopChunks = [];
  const stopPromise = engine.runGeneration(
    {
      conversationId: 'real_conv_3',
      requestId: 'real_req_stop',
      messages: [{ role: 'user', content: 'Write a detailed 10-point guide on learning JavaScript step by step.' }],
      options: {
        maxNewTokens: 400,
        temperature: 0.25,
        topP: 0.9,
        topK: 40,
        repetitionPenalty: 1.1,
        verificationMode: 'standard',
      },
    },
    {
      onTokenChunk: (chunk) => {
        stopChunks.push(chunk);
        if (stopChunks.length === 8) {
          engine.stopGeneration({ requestId: 'real_req_stop', conversationId: 'real_conv_3' });
        }
      },
    }
  );

  // 4. Duplicate request on same conversation rejects cleanly while active
  await assert.rejects(
    engine.runGeneration({
      conversationId: 'real_conv_3',
      requestId: 'real_req_dup',
      messages: [{ role: 'user', content: 'Duplicate turn' }],
      options: { maxNewTokens: 64, temperature: 0.2, topP: 0.9, topK: 40, repetitionPenalty: 1.1 },
    }),
    (err) => err?.code === 'CONVERSATION_BUSY'
  );

  const stopResult = await stopPromise;
  console.log('[Stop Response]:', stopResult.status, 'partial chars:', stopResult.text.length);
  assert.equal(stopResult.status, 'cancelled');
  assert.ok(stopResult.text.length > 0, 'Expected partial text preserved after stop');

  // Dispose cleanly so node:test exits promptly
  await engine.model?.dispose?.();
  await engine.llama?.dispose?.();
});
