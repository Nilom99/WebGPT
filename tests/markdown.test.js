import test from 'node:test';
import assert from 'node:assert/strict';
import {
  highlightCodeTokens,
  parseInlineTokens,
  parseMarkdownToAst,
  sanitizeHref,
} from '../lib/markdown.js';

test('sanitizeHref blocks javascript: and data: XSS URLs', () => {
  assert.equal(sanitizeHref('javascript:alert(1)'), null);
  assert.equal(sanitizeHref('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeHref('https://example.com/path'), 'https://example.com/path');
});

test('parseInlineTokens neutralizes unsafe links while preserving safe formatting', () => {
  const tokens = parseInlineTokens('Click [bad](javascript:alert(1)) and **bold** `code`');
  const linkTokens = tokens.filter((t) => t.type === 'link');
  assert.equal(linkTokens.length, 0);
  assert.ok(tokens.some((t) => t.type === 'bold' && t.text === 'bold'));
  assert.ok(tokens.some((t) => t.type === 'code' && t.text === 'code'));
});

test('parseMarkdownToAst parses headings, lists, tables, and streaming code fences', () => {
  const md = [
    '# Title',
    '',
    '- One',
    '- Two',
    '',
    '| Col A | Col B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '```javascript',
    'const x = 42;',
  ].join('\n');

  const ast = parseMarkdownToAst(md);
  assert.equal(ast[0].type, 'heading');
  assert.equal(ast[1].type, 'ul');
  assert.equal(ast[2].type, 'table');
  assert.equal(ast[3].type, 'code');
  assert.equal(ast[3].lang, 'javascript');
  assert.equal(ast[3].closed, false);
});

test('highlightCodeTokens classifies keywords, strings, numbers, and comments', () => {
  const tokens = highlightCodeTokens('const count = 3; // note\nconst s = "ok";', 'js');
  assert.ok(tokens.some((t) => t.type === 'keyword' && t.text === 'const'));
  assert.ok(tokens.some((t) => t.type === 'number' && t.text === '3'));
  assert.ok(tokens.some((t) => t.type === 'comment' && t.text.startsWith('//')));
  assert.ok(tokens.some((t) => t.type === 'string' && t.text === '"ok"'));
});
