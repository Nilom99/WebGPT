/**
 * SM GPT Generation Guard
 * Detects repetition/infinite loops (without false positives on natural prose or code),
 * malformed/control-token leakage, token ceilings, timeouts, and retry limits.
 */

import { GENERATION_GUARD_CONFIG } from '../config/app.config.js';

const CONTROL_TOKEN_PATTERN = /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/g;

/**
 * Strips leaked ChatML control tokens and trailing incomplete fragments cleanly.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeGeneratedText(text) {
  if (typeof text !== 'string') return '';
  return text.replace(CONTROL_TOKEN_PATTERN, '').replace(/\uFFFD+/g, '').trimEnd();
}

/**
 * Checks whether generated text contains malformed output indicators:
 * - Raw ChatML control tokens leaked after prompt
 * - High density of Unicode replacement characters (\uFFFD)
 * - Non-printable binary control bytes (excluding \n, \r, \t)
 *
 * @param {string} text
 * @returns {{ malformed: boolean, reason: string | null }}
 */
export function detectMalformedOutput(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { malformed: false, reason: null };
  }

  // Allow <|im_end|> only if it were ever passed raw before stripping,
  // but <|im_start|> inside an assistant response indicates prompt boundary leak.
  if (text.includes('<|im_start|>')) {
    return { malformed: true, reason: 'Prompt boundary token leaked into output.' };
  }

  const replacementMatches = text.match(/\uFFFD/g);
  if (replacementMatches && replacementMatches.length >= 4) {
    return { malformed: true, reason: 'Corrupted character sequence detected.' };
  }

  // Control characters except tab (0x09), LF (0x0A), CR (0x0D)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    return { malformed: true, reason: 'Invalid control characters in output.' };
  }

  return { malformed: false, reason: null };
}

/**
 * Checks for genuine infinite repetition loops while avoiding false positives on:
 * - Short responses (< 48 chars)
 * - Normal repeated words ("that that is", "had had", bullet lists, markdown indentation)
 * - Code blocks with repeated structural keywords or closing braces
 *
 * @param {string} text
 * @param {object} [config]
 * @returns {{ isLoop: boolean, reason: string | null, trimIndex: number }}
 */
export function detectRepetitionLoop(text, config = GENERATION_GUARD_CONFIG) {
  if (typeof text !== 'string' || text.length < config.minCharsForRepetitionCheck) {
    return { isLoop: false, reason: null, trimIndex: text ? text.length : 0 };
  }

  // 1. Extreme single-character run (e.g. "aaaaaaaaaaaaaaaaaa" or "..................")
  // Ignore markdown horizontal rules or code fence backticks/dashes if <= 12 chars.
  const charRunRegex = new RegExp(`([^\\s\\-=\`_*#])\\1{${config.charRepeatThreshold - 1},}`);
  const charMatch = charRunRegex.exec(text);
  if (charMatch) {
    return {
      isLoop: true,
      reason: 'Character repetition loop detected.',
      trimIndex: Math.max(0, charMatch.index + 1),
    };
  }

  // 2. Consecutive identical words (e.g. "word word word word word")
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  if (words.length >= config.maxConsecutiveIdenticalWords) {
    let run = 1;
    for (let i = 1; i < words.length; i += 1) {
      if (words[i] === words[i - 1]) {
        run += 1;
        if (run >= config.maxConsecutiveIdenticalWords) {
          return {
            isLoop: true,
            reason: 'Consecutive word repetition loop detected.',
            trimIndex: text.length,
          };
        }
      } else {
        run = 1;
      }
    }
  }

  // 3. Repeated trailing n-gram phrase loop (e.g. "and so on and so on and so on and so on")
  const n = config.ngramSize;
  if (words.length >= n * config.ngramRepeatThreshold) {
    const tailNgram = words.slice(words.length - n).join(' ');
    // Count how many consecutive times the tail n-gram repeats at the end
    let consecutiveRepeats = 0;
    for (let pos = words.length - n; pos >= 0; pos -= n) {
      const slice = words.slice(pos, pos + n).join(' ');
      if (slice === tailNgram) {
        consecutiveRepeats += 1;
      } else {
        break;
      }
    }
    if (consecutiveRepeats >= config.ngramRepeatThreshold) {
      return {
        isLoop: true,
        reason: 'Phrase repetition loop detected.',
        trimIndex: trimRepeatedTail(text, consecutiveRepeats),
      };
    }

    // Also check overlapping sliding window for high-frequency n-gram saturation in the tail
    const tailWindow = words.slice(-Math.min(words.length, n * 8));
    const counts = new Map();
    for (let i = 0; i <= tailWindow.length - n; i += 1) {
      const gram = tailWindow.slice(i, i + n).join(' ');
      const next = (counts.get(gram) ?? 0) + 1;
      counts.set(gram, next);
      if (next >= config.ngramRepeatThreshold + 1) {
        return {
          isLoop: true,
          reason: 'Cyclic phrase loop detected.',
          trimIndex: text.length,
        };
      }
    }
  }

  // 4. Repeated identical non-trivial lines or sentences (>= 20 chars)
  const lines = text
    .split(/\n+/)
    .map((l) => l.trim())
    .filter((l) => l.length >= 20 && !/^```/.test(l));

  if (lines.length >= config.sentenceRepeatThreshold) {
    const lastLine = lines[lines.length - 1];
    let matchingTail = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i] === lastLine) matchingTail += 1;
      else break;
    }
    if (matchingTail >= config.sentenceRepeatThreshold) {
      const firstOccurrence = text.indexOf(lastLine);
      return {
        isLoop: true,
        reason: 'Line repetition loop detected.',
        trimIndex: firstOccurrence >= 0 ? firstOccurrence + lastLine.length : text.length,
      };
    }
  }

  return { isLoop: false, reason: null, trimIndex: text.length };
}

function trimRepeatedTail(text, repeatCount) {
  if (repeatCount <= 1) return text.length;
  // Keep at most one clean sentence/clause boundary before the tail
  const lastPeriod = text.lastIndexOf('.');
  const lastNewline = text.lastIndexOf('\n');
  const boundary = Math.max(lastPeriod + 1, lastNewline);
  if (boundary > Math.floor(text.length * 0.35)) {
    return boundary;
  }
  return text.length;
}

/**
 * Stateful tracker for a single generation attempt.
 */
export class GenerationGuard {
  constructor({ maxNewTokens = 160, config = GENERATION_GUARD_CONFIG } = {}) {
    this.maxNewTokens = maxNewTokens;
    this.config = config;
    this.tokenCount = 0;
    this.text = '';
    this.startedAt = Date.now();
    this.firstTokenAt = null;
    this.lastTokenAt = null;
    this.tripped = false;
    this.tripReason = null;
    this.tripType = null; // 'loop' | 'malformed' | 'token_limit' | 'timeout'
  }

  recordTokens(count = 1) {
    const now = Date.now();
    if (this.firstTokenAt === null) {
      this.firstTokenAt = now;
    }
    this.lastTokenAt = now;
    this.tokenCount += count;
    if (this.tokenCount >= this.maxNewTokens) {
      this.tripped = true;
      this.tripType = 'token_limit';
      this.tripReason = `Reached maximum response length (${this.maxNewTokens} tokens).`;
    }
    return this.getStatus();
  }

  appendText(chunk) {
    if (typeof chunk !== 'string' || chunk.length === 0) return this.getStatus();
    this.text += chunk;

    const malformedCheck = detectMalformedOutput(this.text);
    if (malformedCheck.malformed) {
      this.tripped = true;
      this.tripType = 'malformed';
      this.tripReason = malformedCheck.reason;
      this.text = sanitizeGeneratedText(this.text);
      return this.getStatus();
    }

    const loopCheck = detectRepetitionLoop(this.text, this.config);
    if (loopCheck.isLoop) {
      this.tripped = true;
      this.tripType = 'loop';
      this.tripReason = loopCheck.reason;
      if (loopCheck.trimIndex > 0 && loopCheck.trimIndex < this.text.length) {
        this.text = this.text.slice(0, loopCheck.trimIndex).trimEnd();
      }
      return this.getStatus();
    }

    return this.getStatus();
  }

  checkTimeout(now = Date.now()) {
    if (this.firstTokenAt === null && now - this.startedAt > this.config.firstTokenTimeoutMs) {
      this.tripped = true;
      this.tripType = 'timeout';
      this.tripReason = 'Response initialization timed out.';
    } else if (
      this.lastTokenAt !== null &&
      this.config.stallTimeoutMs &&
      now - this.lastTokenAt > this.config.stallTimeoutMs
    ) {
      this.tripped = true;
      this.tripType = 'timeout';
      this.tripReason = 'Response generation stalled and was stopped safely.';
    } else if (now - this.startedAt > this.config.timeoutMs) {
      this.tripped = true;
      this.tripType = 'timeout';
      this.tripReason = 'Generation reached maximum time limit.';
    }
    return this.getStatus();
  }

  getPreservedText() {
    return sanitizeGeneratedText(this.text);
  }

  getStatus() {
    return {
      tripped: this.tripped,
      tripType: this.tripType,
      tripReason: this.tripReason,
      tokenCount: this.tokenCount,
    };
  }
}

/**
 * Decides whether a failed/tripped generation attempt can perform an automatic retry.
 * Respects strict maximum of 1 automatic retry.
 *
 * @param {number} attemptIndex Zero-based attempt index (0 = initial, 1 = retry)
 * @param {string | null} tripType
 * @returns {boolean}
 */
export function shouldAutoRetry(attemptIndex, tripType) {
  if (attemptIndex >= GENERATION_GUARD_CONFIG.maxAutoRetries) {
    return false;
  }
  return tripType === 'loop' || tripType === 'malformed' || tripType === 'empty';
}
