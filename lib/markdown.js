/**
 * Safe Zero-XSS Markdown Parser, Syntax Highlighter, and DOM Renderer for SM GPT.
 * Parses Markdown into a structured AST and builds DOM nodes exclusively via
 * `document.createElement` and `textContent` (never raw HTML injection).
 */

const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

export function sanitizeHref(rawHref) {
  if (typeof rawHref !== 'string') return null;
  const trimmed = rawHref.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed, 'https://smgpt.local');
    // Reject protocol-relative or disallowed schemes (javascript:, data:, vbscript:)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
      return SAFE_URL_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
    }
    return trimmed.startsWith('/') || trimmed.startsWith('#') ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * Tokenizes inline markdown spans: `code`, **bold**, *italic*, ~~strike~~, [label](url).
 * @param {string} text
 * @returns {Array<{ type: string, text?: string, label?: string, href?: string }>}
 */
export function parseInlineTokens(text) {
  const tokens = [];
  if (!text) return tokens;

  const pattern =
    /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*\n]+\*|_[^_\n]+_|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'text', text: text.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      tokens.push({ type: 'code', text: token.slice(1, -1) });
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      tokens.push({ type: 'bold', text: token.slice(2, -2) });
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      tokens.push({ type: 'strike', text: token.slice(2, -2) });
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      tokens.push({ type: 'italic', text: token.slice(1, -1) });
    } else if (token.startsWith('[')) {
      const label = match[2] ?? '';
      const safeUrl = sanitizeHref(match[3] ?? '');
      if (safeUrl) {
        tokens.push({ type: 'link', label, href: safeUrl });
      } else {
        tokens.push({ type: 'text', text: label });
      }
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return tokens;
}

/**
 * Parses Markdown string into block AST nodes. Handles unclosed code fences gracefully
 * during live token streaming.
 *
 * @param {string} markdown
 * @returns {Array<object>}
 */
export function parseMarkdownToAst(markdown) {
  if (typeof markdown !== 'string' || markdown.length === 0) return [];

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (```lang ... ```)
    const fenceMatch = /^```([a-zA-Z0-9_+-]*)\s*$/.exec(line.trim());
    if (fenceMatch) {
      const lang = (fenceMatch[1] || 'text').toLowerCase();
      const codeLines = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (/^```\s*$/.test(lines[i].trim())) {
          closed = true;
          i += 1;
          break;
        }
        codeLines.push(lines[i]);
        i += 1;
      }
      blocks.push({
        type: 'code',
        lang,
        code: codeLines.join('\n'),
        closed,
      });
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i += 1;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // Heading (# to ####)
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(line);
    if (headingMatch) {
      blocks.push({
        type: 'heading',
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
      });
      i += 1;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Markdown table (header | separator | rows)
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[i + 1])
    ) {
      const parseRow = (rowLine) =>
        rowLine
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((cell) => cell.trim());

      const headers = parseRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(parseRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Paragraph (accumulate until next block starter or blank line)
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paraLines.join('\n') });
  }

  return blocks;
}

const KEYWORD_SET = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
  'switch', 'case', 'break', 'continue', 'default', 'try', 'catch', 'finally', 'throw',
  'async', 'await', 'import', 'export', 'from', 'class', 'extends', 'new', 'this',
  'super', 'true', 'false', 'null', 'undefined', 'typeof', 'instanceof', 'in', 'of',
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'as', 'yield', 'None', 'True', 'False',
  'and', 'or', 'not', 'is', 'struct', 'impl', 'fn', 'pub', 'mut', 'match', 'enum', 'type',
  'interface', 'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'TABLE',
]);

/**
 * Lightweight deterministic syntax tokenizer for code highlighting.
 * @param {string} code
 * @param {string} [lang]
 * @returns {Array<{ type: 'plain'|'comment'|'string'|'keyword'|'number'|'function', text: string }>}
 */
export function highlightCodeTokens(code, lang = 'text') {
  if (typeof code !== 'string' || code.length === 0) return [];
  const tokens = [];
  const isHashCommentLang = ['python', 'py', 'bash', 'sh', 'yaml', 'yml', 'toml', 'ruby'].includes(lang);

  const regex = isHashCommentLang
    ? /(#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*\b)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b(?=\s*\()|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;

  let lastIndex = 0;
  let match;

  while ((match = regex.exec(code)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ type: 'plain', text: code.slice(lastIndex, match.index) });
    }
    const word = match[0];
    if (word.startsWith('//') || word.startsWith('/*') || (isHashCommentLang && word.startsWith('#'))) {
      tokens.push({ type: 'comment', text: word });
    } else if (word.startsWith('"') || word.startsWith("'") || word.startsWith('`')) {
      tokens.push({ type: 'string', text: word });
    } else if (/^\d/.test(word)) {
      tokens.push({ type: 'number', text: word });
    } else if (KEYWORD_SET.has(word)) {
      tokens.push({ type: 'keyword', text: word });
    } else {
      // Check if lookahead matched function call
      const after = code[regex.lastIndex];
      if (after === '(') {
        tokens.push({ type: 'function', text: word });
      } else {
        tokens.push({ type: 'plain', text: word });
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < code.length) {
    tokens.push({ type: 'plain', text: code.slice(lastIndex) });
  }

  return tokens;
}

function appendInlineNodes(parent, text, doc) {
  const lines = text.split('\n');
  lines.forEach((line, lineIdx) => {
    const spans = parseInlineTokens(line);
    for (const span of spans) {
      if (span.type === 'text') {
        parent.appendChild(doc.createTextNode(span.text));
      } else if (span.type === 'code') {
        const codeEl = doc.createElement('code');
        codeEl.className = 'md-inline-code';
        codeEl.textContent = span.text;
        parent.appendChild(codeEl);
      } else if (span.type === 'bold') {
        const strong = doc.createElement('strong');
        strong.textContent = span.text;
        parent.appendChild(strong);
      } else if (span.type === 'italic') {
        const em = doc.createElement('em');
        em.textContent = span.text;
        parent.appendChild(em);
      } else if (span.type === 'strike') {
        const del = doc.createElement('del');
        del.textContent = span.text;
        parent.appendChild(del);
      } else if (span.type === 'link') {
        const a = doc.createElement('a');
        a.href = span.href;
        a.textContent = span.label;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        parent.appendChild(a);
      }
    }
    if (lineIdx < lines.length - 1) {
      parent.appendChild(doc.createElement('br'));
    }
  });
}

/**
 * Safely renders Markdown into a target DOM element.
 * @param {string} markdown
 * @param {HTMLElement} container
 * @param {{ onCopyCode?: (code: string, btn: HTMLButtonElement) => void }} [hooks]
 */
export function renderMarkdownToElement(markdown, container, hooks = {}) {
  const doc = container.ownerDocument;
  const fragment = doc.createDocumentFragment();
  const blocks = parseMarkdownToAst(markdown);

  if (blocks.length === 0 && markdown.trim().length === 0) {
    container.replaceChildren();
    return;
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const tag = `h${Math.min(4, Math.max(1, block.level))}`;
        const h = doc.createElement(tag);
        appendInlineNodes(h, block.text, doc);
        fragment.appendChild(h);
        break;
      }

      case 'paragraph': {
        const p = doc.createElement('p');
        appendInlineNodes(p, block.text, doc);
        fragment.appendChild(p);
        break;
      }

      case 'blockquote': {
        const bq = doc.createElement('blockquote');
        appendInlineNodes(bq, block.text, doc);
        fragment.appendChild(bq);
        break;
      }

      case 'hr': {
        fragment.appendChild(doc.createElement('hr'));
        break;
      }

      case 'ul':
      case 'ol': {
        const list = doc.createElement(block.type);
        for (const item of block.items) {
          const li = doc.createElement('li');
          appendInlineNodes(li, item, doc);
          list.appendChild(li);
        }
        fragment.appendChild(list);
        break;
      }

      case 'table': {
        const wrap = doc.createElement('div');
        wrap.className = 'md-table-wrap';
        const table = doc.createElement('table');
        const thead = doc.createElement('thead');
        const headRow = doc.createElement('tr');
        for (const cell of block.headers) {
          const th = doc.createElement('th');
          appendInlineNodes(th, cell, doc);
          headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = doc.createElement('tbody');
        for (const row of block.rows) {
          const tr = doc.createElement('tr');
          for (const cell of row) {
            const td = doc.createElement('td');
            appendInlineNodes(td, cell, doc);
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        wrap.appendChild(table);
        fragment.appendChild(wrap);
        break;
      }

      case 'code': {
        const wrapper = doc.createElement('div');
        wrapper.className = 'md-code-block';

        const header = doc.createElement('div');
        header.className = 'md-code-header';

        const langLabel = doc.createElement('span');
        langLabel.className = 'md-code-lang';
        langLabel.textContent = block.lang || 'text';

        const copyBtn = doc.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'md-code-copy';
        copyBtn.textContent = 'Copy code';
        copyBtn.setAttribute('aria-label', `Copy ${block.lang || 'code'} snippet`);
        copyBtn.addEventListener('click', () => {
          if (typeof hooks.onCopyCode === 'function') {
            hooks.onCopyCode(block.code, copyBtn);
          }
        });

        header.appendChild(langLabel);
        header.appendChild(copyBtn);

        const pre = doc.createElement('pre');
        const codeEl = doc.createElement('code');
        const syntaxTokens = highlightCodeTokens(block.code, block.lang);
        for (const tok of syntaxTokens) {
          if (tok.type === 'plain') {
            codeEl.appendChild(doc.createTextNode(tok.text));
          } else {
            const span = doc.createElement('span');
            span.className = `tok-${tok.type}`;
            span.textContent = tok.text;
            codeEl.appendChild(span);
          }
        }
        pre.appendChild(codeEl);

        wrapper.appendChild(header);
        wrapper.appendChild(pre);
        fragment.appendChild(wrapper);
        break;
      }

      default:
        break;
    }
  }

  container.replaceChildren(fragment);
}
