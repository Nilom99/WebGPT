/**
 * Request Validation, CORS, and Public Error Sanitization for SM GPT Backend
 */

import crypto from 'node:crypto';
import { DEFAULT_GENERATION_OPTIONS, MODEL_SPEC } from './config.js';

const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 32000;
const MAX_EXTRA_INSTRUCTIONS_CHARS = 1200;

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function normalizeId(value, fallbackPrefix) {
  if (value === undefined || value === null || value === '') {
    return `${fallbackPrefix}_${crypto.randomUUID()}`;
  }
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    return null;
  }
  return value;
}

/**
 * Validates incoming POST /api/chat and POST /api/chat/stream request bodies.
 * Enforces user/assistant roles only so clients cannot override backend system identity.
 *
 * @param {unknown} body
 * @returns {{ valid: true, value: object } | { valid: false, status: number, code: string, message: string }}
 */
export function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_BODY',
      message: 'Request body must be a JSON object.',
    };
  }

  const conversationId =
    body.conversationId === undefined
      ? 'conv_default'
      : normalizeId(body.conversationId, 'conv');

  if (!conversationId) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_CONVERSATION_ID',
      message: 'conversationId must be an alphanumeric identifier (1-128 chars).',
    };
  }

  const requestId = normalizeId(body.requestId, 'req');
  if (!requestId) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_REQUEST_ID',
      message: 'requestId must be an alphanumeric identifier (1-128 chars).',
    };
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_MESSAGES',
      message: 'messages must be a non-empty array.',
    };
  }

  if (body.messages.length > MAX_MESSAGES) {
    return {
      valid: false,
      status: 400,
      code: 'TOO_MANY_MESSAGES',
      message: `messages cannot exceed ${MAX_MESSAGES} entries.`,
    };
  }

  const sanitizedMessages = [];
  for (let i = 0; i < body.messages.length; i += 1) {
    const item = body.messages[i];
    if (!item || typeof item !== 'object') {
      return {
        valid: false,
        status: 400,
        code: 'INVALID_MESSAGE_ITEM',
        message: `messages[${i}] must be an object.`,
      };
    }

    if (item.role !== 'user' && item.role !== 'assistant') {
      return {
        valid: false,
        status: 400,
        code: 'INVALID_MESSAGE_ROLE',
        message: `messages[${i}].role must be "user" or "assistant".`,
      };
    }

    if (typeof item.content !== 'string' || item.content.trim().length === 0) {
      return {
        valid: false,
        status: 400,
        code: 'EMPTY_MESSAGE_CONTENT',
        message: `messages[${i}].content must be a non-empty string.`,
      };
    }

    if (item.content.length > MAX_MESSAGE_CHARS) {
      return {
        valid: false,
        status: 400,
        code: 'MESSAGE_TOO_LONG',
        message: `messages[${i}].content exceeds ${MAX_MESSAGE_CHARS} characters.`,
      };
    }

    sanitizedMessages.push({
      role: item.role,
      content: item.content.trim(),
    });
  }

  if (sanitizedMessages[sanitizedMessages.length - 1].role !== 'user') {
    return {
      valid: false,
      status: 400,
      code: 'LAST_MESSAGE_MUST_BE_USER',
      message: 'The final message in messages must have role "user".',
    };
  }

  const rawOptions = body.options && typeof body.options === 'object' ? body.options : {};
  const verificationMode = rawOptions.verificationMode === 'strict' ? 'strict' : 'standard';

  let stylePreferences = '';
  if (typeof rawOptions.stylePreferences === 'string' && rawOptions.stylePreferences.trim()) {
    stylePreferences = rawOptions.stylePreferences.trim().slice(0, MAX_EXTRA_INSTRUCTIONS_CHARS);
  }

  const options = {
    maxNewTokens: Math.round(
      clampNumber(
        rawOptions.maxNewTokens,
        16,
        MODEL_SPEC.defaultMaxNewTokens,
        DEFAULT_GENERATION_OPTIONS.maxNewTokens
      )
    ),
    temperature: clampNumber(
      rawOptions.temperature,
      0.0,
      1.5,
      DEFAULT_GENERATION_OPTIONS.temperature
    ),
    topP: clampNumber(rawOptions.topP, 0.1, 1.0, DEFAULT_GENERATION_OPTIONS.topP),
    topK: Math.round(clampNumber(rawOptions.topK, 1, 100, DEFAULT_GENERATION_OPTIONS.topK)),
    repetitionPenalty: clampNumber(
      rawOptions.repetitionPenalty,
      1.0,
      1.5,
      DEFAULT_GENERATION_OPTIONS.repetitionPenalty
    ),
    verificationMode,
    stylePreferences,
  };

  return {
    valid: true,
    value: {
      conversationId,
      requestId,
      messages: sanitizedMessages,
      options,
    },
  };
}

/**
 * Validates incoming POST /api/chat/stop requests.
 *
 * @param {unknown} body
 */
export function validateStopRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      status: 400,
      code: 'INVALID_BODY',
      message: 'Request body must be a JSON object.',
    };
  }

  const requestId =
    typeof body.requestId === 'string' && ID_PATTERN.test(body.requestId)
      ? body.requestId
      : null;
  const conversationId =
    typeof body.conversationId === 'string' && ID_PATTERN.test(body.conversationId)
      ? body.conversationId
      : null;

  if (!requestId && !conversationId) {
    return {
      valid: false,
      status: 400,
      code: 'MISSING_STOP_TARGET',
      message: 'Provide a valid requestId or conversationId to stop.',
    };
  }

  return {
    valid: true,
    value: { requestId, conversationId },
  };
}

/**
 * Resolves CORS Access-Control-Allow-Origin header safely from configured origins.
 *
 * @param {string | undefined} requestOrigin
 * @param {string} configuredOrigin
 * @returns {string | null}
 */
export function resolveCorsOrigin(requestOrigin, configuredOrigin = '*') {
  const trimmed = (configuredOrigin || '*').trim();
  if (trimmed === '*') {
    return '*';
  }
  if (!requestOrigin) return null;
  const allowlist = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return allowlist.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * Maps internal errors to safe public messages without exposing file paths or model internals.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function sanitizePublicErrorMessage(err) {
  const raw = err instanceof Error ? err.message : String(err || '');
  if (/CONVERSATION_BUSY|already generating/i.test(raw)) {
    return 'Another response is currently generating for this conversation.';
  }
  if (/QUEUE_FULL|Server is busy/i.test(raw)) {
    return 'SM GPT is currently handling too many queued requests. Please try again in a moment.';
  }
  if (/MODEL_NOT_READY|initializing/i.test(raw)) {
    return 'SM GPT is still starting up. Please retry in a moment.';
  }
  if (/network|fetch|ECONN|ENOTFOUND/i.test(raw)) {
    return 'SM GPT backend could not reach required model resources. Check server connectivity.';
  }
  if (/memory|allocation|oom/i.test(raw)) {
    return 'SM GPT backend ran out of available memory for this request.';
  }
  return 'SM GPT encountered a backend processing issue. Please try again.';
}
