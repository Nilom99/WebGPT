import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerationGuard,
  detectMalformedOutput,
  detectRepetitionLoop,
  sanitizeGeneratedText,
  shouldAutoRetry,
} from '../lib/generation-guard.js';

test('detectRepetitionLoop catches consecutive identical words', () => {
  const loopText = 'Here is a sentence that repeats word word word word word word';
  const res = detectRepetitionLoop(loopText);
  assert.equal(res.isLoop, true);
});

test('detectRepetitionLoop catches repeating 4-gram phrase loops', () => {
  const loopText =
    'Sure, I can help with that. ' +
    'and then we go and then we go and then we go and then we go and then we go';
  const res = detectRepetitionLoop(loopText);
  assert.equal(res.isLoop, true);
});

test('detectRepetitionLoop catches repeated identical lines', () => {
  const line = 'This exact explanatory sentence keeps repeating forever.';
  const res = detectRepetitionLoop(`${line}\n${line}\n${line}`);
  assert.equal(res.isLoop, true);
});

test('detectRepetitionLoop avoids false positives on normal repeated words and code', () => {
  const prose =
    'I know that that method works well, and had had good results in tests.\n' +
    '```js\nfunction sum(arr) {\n  let total = 0;\n  for (const item of arr) {\n    total += item;\n  }\n  return total;\n}\n```';
  const res = detectRepetitionLoop(prose);
  assert.equal(res.isLoop, false);
});

test('detectMalformedOutput catches leaked ChatML tokens and replacement chars', () => {
  assert.equal(detectMalformedOutput('Hello <|im_start|>user').malformed, true);
  assert.equal(detectMalformedOutput('Bad \uFFFD\uFFFD\uFFFD\uFFFD chars').malformed, true);
  assert.equal(detectMalformedOutput('Normal clean markdown response.').malformed, false);
  assert.equal(sanitizeGeneratedText('Clean text<|im_end|>'), 'Clean text');
});

test('GenerationGuard enforces maxNewTokens and preserves partial text', () => {
  const guard = new GenerationGuard({ maxNewTokens: 5 });
  guard.appendText('Hello world, ');
  const status = guard.recordTokens(5);
  assert.equal(status.tripped, true);
  assert.equal(status.tripType, 'token_limit');
  assert.equal(guard.getPreservedText(), 'Hello world,');
});

test('shouldAutoRetry respects maximum of 1 automatic retry', () => {
  assert.equal(shouldAutoRetry(0, 'loop'), true);
  assert.equal(shouldAutoRetry(0, 'malformed'), true);
  assert.equal(shouldAutoRetry(1, 'loop'), false);
  assert.equal(shouldAutoRetry(0, 'token_limit'), false);
});
