import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackendContextWindow,
  buildSystemPrompt,
  estimateTokens,
} from '../backend/context-manager.js';
import { PERMANENT_SYSTEM_INSTRUCTION } from '../backend/config.js';

test('buildSystemPrompt always injects permanent Abdus Nilom SM GPT identity', () => {
  const standard = buildSystemPrompt();
  assert.ok(standard.startsWith(PERMANENT_SYSTEM_INSTRUCTION));
  assert.ok(standard.includes('Abdus Nilom'));

  const withPrefs = buildSystemPrompt({
    verificationMode: 'strict',
    stylePreferences: 'Use concise bullet points.',
  });
  assert.ok(withPrefs.startsWith(PERMANENT_SYSTEM_INSTRUCTION));
  assert.ok(withPrefs.includes('Verification mode is active'));
  assert.ok(withPrefs.includes('Use concise bullet points.'));
});

test('buildBackendContextWindow keeps permanent system prompt and latest user turn within budget', () => {
  const history = [];
  for (let i = 1; i <= 18; i += 1) {
    history.push({ role: 'user', content: `Turn ${i}: ` + 'alpha '.repeat(50) });
    history.push({ role: 'assistant', content: `Reply ${i}: ` + 'beta '.repeat(50) });
  }
  history.push({ role: 'user', content: 'Latest priority question' });

  const result = buildBackendContextWindow(history, {
    contextSize: 1200,
    maxNewTokens: 400,
  });

  assert.ok(result.systemPrompt.includes('Abdus Nilom'));
  assert.equal(result.latestPrompt, 'Latest priority question');
  assert.ok(result.droppedCount > 0, 'Expected older turns to be dropped');
  assert.ok(result.estimatedPromptTokens <= result.promptBudgetTokens + 32);
});

test('buildBackendContextWindow truncates oversized latest message safely', () => {
  const hugePrompt = 'explain '.repeat(2500);
  const result = buildBackendContextWindow([{ role: 'user', content: hugePrompt }], {
    contextSize: 1200,
    maxNewTokens: 300,
  });

  assert.equal(result.truncatedLatest, true);
  assert.ok(result.latestPrompt.includes('[...truncated to fit context window]'));
  assert.ok(result.estimatedPromptTokens <= result.promptBudgetTokens + 32);
});

test('estimateTokens honors exactTokenizer callback', () => {
  const exact = (s) => s.split(' ').length;
  assert.equal(estimateTokens('one two three', exact) > 3, true);
});
