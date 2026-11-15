import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../backend/context-manager.js';
import { assessResponseGrounding, extractUrls } from '../lib/hallucination.js';

test('backend system prompt preserves Abdus Nilom identity and adds strict rules in strict mode', () => {
  const standard = buildSystemPrompt({ verificationMode: 'standard' });
  const strict = buildSystemPrompt({ verificationMode: 'strict' });
  assert.ok(standard.includes('SM GPT'));
  assert.ok(standard.includes('Abdus Nilom'));
  assert.ok(strict.length > standard.length);
  assert.ok(strict.includes('Verification mode is active'));
});

test('assessResponseGrounding flags unverified fabricated URLs not in user prompt', () => {
  const result = assessResponseGrounding(
    'You can read more at https://invented-source.example.com/study.',
    [{ role: 'user', content: 'Summarize photosynthesis.' }],
    'standard'
  );
  assert.equal(result.status, 'unverified_claims');
  assert.deepEqual(result.unverifiedUrls, ['https://invented-source.example.com/study']);
});

test('assessResponseGrounding allows URLs provided directly by the user', () => {
  const result = assessResponseGrounding(
    'Based on https://example.org/docs, here is the summary.',
    [{ role: 'user', content: 'Explain https://example.org/docs' }],
    'standard'
  );
  assert.equal(result.status, 'standard');
  assert.equal(extractUrls('See https://a.com/test.').length, 1);
});

test('assessResponseGrounding recognizes honest uncertainty expressions', () => {
  const result = assessResponseGrounding(
    'I cannot verify the exact release date from available context.',
    [{ role: 'user', content: 'When did X release?' }],
    'strict'
  );
  assert.equal(result.status, 'uncertainty_expressed');
});
