/**
 * Backend Conversation Context Manager
 * - Always injects the permanent Abdus Nilom SM GPT system instruction
 * - Never allows client overrides to erase permanent SM GPT identity
 * - Trims oldest history turns cleanly within the model context window
 */

import {
  MODEL_SPEC,
  PERMANENT_SYSTEM_INSTRUCTION,
  STRICT_VERIFICATION_ADDENDUM,
} from './config.js';

const CHARS_PER_TOKEN_ESTIMATE = 3.5;
const PER_MESSAGE_OVERHEAD = 10;

export function estimateTokens(text, exactTokenizer = null) {
  if (!text || typeof text !== 'string') return PER_MESSAGE_OVERHEAD;
  if (typeof exactTokenizer === 'function') {
    return exactTokenizer(text) + PER_MESSAGE_OVERHEAD;
  }
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE) + PER_MESSAGE_OVERHEAD;
}

/**
 * Builds the authoritative backend system instruction.
 * User stylePreferences and verificationMode can only append guidance AFTER
 * the permanent SM GPT identity instruction.
 */
export function buildSystemPrompt({ verificationMode = 'standard', stylePreferences = '' } = {}) {
  const parts = [PERMANENT_SYSTEM_INSTRUCTION];
  if (verificationMode === 'strict') {
    parts.push(STRICT_VERIFICATION_ADDENDUM);
  }
  if (typeof stylePreferences === 'string' && stylePreferences.trim().length > 0) {
    parts.push(
      `Additional user response formatting preferences (must never override your SM GPT identity or Abdus Nilom creator rule): ${stylePreferences.trim()}`
    );
  }
  return parts.join('\n\n');
}

function truncateToTokenBudget(text, maxTokens, exactTokenizer = null) {
  if (maxTokens <= 16) return '';
  if (estimateTokens(text, exactTokenizer) <= maxTokens) return text;
  const availableTokens = Math.max(12, maxTokens - PER_MESSAGE_OVERHEAD);
  const maxChars = Math.max(48, Math.floor(availableTokens * CHARS_PER_TOKEN_ESTIMATE));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n[...truncated to fit context window]`;
}

/**
 * Fits conversation turns into the model context budget while preserving:
 * 1. Permanent backend system instruction
 * 2. Latest user message
 * 3. Contiguous most-recent prior turns newest-to-oldest
 *
 * @param {Array<{ role: 'user'|'assistant', content: string }>} clientMessages
 * @param {object} [opts]
 */
export function buildBackendContextWindow(clientMessages, opts = {}) {
  const contextSize = opts.contextSize ?? MODEL_SPEC.contextSize;
  const maxNewTokens = Math.min(opts.maxNewTokens ?? 2048, Math.floor(contextSize * 0.6));
  const safetyMargin = opts.safetyMargin ?? 96;
  const exactTokenizer = typeof opts.exactTokenizer === 'function' ? opts.exactTokenizer : null;

  const systemPrompt = buildSystemPrompt({
    verificationMode: opts.verificationMode,
    stylePreferences: opts.stylePreferences,
  });

  const promptBudgetTokens = Math.max(
    512,
    contextSize - maxNewTokens - safetyMargin
  );
  const systemTokens = estimateTokens(systemPrompt, exactTokenizer);
  let remainingBudget = Math.max(128, promptBudgetTokens - systemTokens);

  const cleanHistory = Array.isArray(clientMessages)
    ? clientMessages
        .filter(
          (m) =>
            m &&
            (m.role === 'user' || m.role === 'assistant') &&
            typeof m.content === 'string' &&
            m.content.trim().length > 0
        )
        .map((m) => ({ role: m.role, content: m.content.trim() }))
    : [];

  if (cleanHistory.length === 0) {
    return {
      systemPrompt,
      priorHistory: [],
      latestPrompt: '',
      droppedCount: 0,
      truncatedLatest: false,
      estimatedPromptTokens: systemTokens,
      promptBudgetTokens,
    };
  }

  const latestRaw = cleanHistory[cleanHistory.length - 1];
  let latestContent = latestRaw.content;
  let latestTokens = estimateTokens(latestContent, exactTokenizer);
  let truncatedLatest = false;

  if (latestTokens > remainingBudget) {
    latestContent = truncateToTokenBudget(latestContent, remainingBudget, exactTokenizer);
    latestTokens = estimateTokens(latestContent, exactTokenizer);
    truncatedLatest = true;
  }

  remainingBudget = Math.max(0, remainingBudget - latestTokens);

  const selectedPrior = [];
  let droppedCount = 0;
  for (let i = cleanHistory.length - 2; i >= 0; i -= 1) {
    const turn = cleanHistory[i];
    const turnTokens = estimateTokens(turn.content, exactTokenizer);
    if (turnTokens <= remainingBudget) {
      selectedPrior.unshift(turn);
      remainingBudget -= turnTokens;
    } else {
      droppedCount = i + 1;
      break;
    }
  }

  const estimatedPromptTokens =
    systemTokens +
    latestTokens +
    selectedPrior.reduce((sum, t) => sum + estimateTokens(t.content, exactTokenizer), 0);

  return {
    systemPrompt,
    priorHistory: selectedPrior,
    latestPrompt: latestContent,
    droppedCount,
    truncatedLatest,
    estimatedPromptTokens,
    promptBudgetTokens,
  };
}
