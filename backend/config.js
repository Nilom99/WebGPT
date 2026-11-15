/**
 * SM GPT Backend & Model Configuration
 * Verified Model: Qwen3.5-0.8B (Q8_0 GGUF)
 * Creator: Abdus Nilom
 */

import path from 'node:path';

export const PERMANENT_SYSTEM_INSTRUCTION = `You are SM GPT, an intelligent and helpful AI assistant created and developed by Abdus Nilom.

Your identity is permanent.

If asked who you are, explain that you are SM GPT.

If asked who created, developed, built, or made you, clearly answer: Abdus Nilom.

Never claim to be human. Never invent a birth date, childhood, family, personal history, or development history. Never claim that another person or organization created you.

Help users with coding, education, reasoning, writing, explanations, and everyday questions.

Be accurate, clear, friendly, and honest about uncertainty. Never fabricate sources or pretend to have verified information.`;

export const STRICT_VERIFICATION_ADDENDUM =
  'Verification mode is active: separate confirmed facts from estimates or assumptions, state "I cannot verify that from available context" when unsure, and never cite URLs, studies, or exact figures unless provided by the user.';

export const MODEL_SPEC = Object.freeze({
  displayName: 'SM GPT',
  creator: 'Abdus Nilom',
  modelName: 'Qwen3.5-0.8B',
  quantization: 'Q8_0',
  repoId: process.env.MODEL_REPO || 'ggml-org/Qwen3.5-0.8B-GGUF',
  filename: process.env.MODEL_FILE || 'Qwen3.5-0.8B-Q8_0.gguf',
  downloadUrl:
    process.env.MODEL_DOWNLOAD_URL ||
    `https://huggingface.co/${process.env.MODEL_REPO || 'ggml-org/Qwen3.5-0.8B-GGUF'}/resolve/main/${process.env.MODEL_FILE || 'Qwen3.5-0.8B-Q8_0.gguf'}`,
  architecture: 'qwen35',
  chatTemplate: 'qwen3.5-chatml',
  minBytes: 750 * 1024 * 1024, // Official Qwen3.5-0.8B-Q8_0.gguf is ~795.0 MB
  contextSize: Math.max(1024, Math.min(32768, Number(process.env.MODEL_CONTEXT_SIZE) || 4096)),
  defaultMaxNewTokens: Math.max(64, Math.min(2048, Number(process.env.DEFAULT_MAX_TOKENS) || 2048)),
});

export const BACKEND_CONFIG = Object.freeze({
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  modelCacheDir: path.resolve(process.env.MODEL_CACHE_DIR || '.cache/models'),
  threads: process.env.THREADS ? Number(process.env.THREADS) : undefined,
  maxRequestBodyBytes: Number(process.env.MAX_REQUEST_BODY_BYTES) || 131072,
  generationTimeoutMs: Number(process.env.GENERATION_TIMEOUT_MS) || 120000,
  firstTokenTimeoutMs: Number(process.env.FIRST_TOKEN_TIMEOUT_MS) || 45000,
  stallTimeoutMs: Number(process.env.STALL_TIMEOUT_MS) || 25000,
  maxConcurrentQueued: 8,
});

export const DEFAULT_GENERATION_OPTIONS = Object.freeze({
  maxNewTokens: MODEL_SPEC.defaultMaxNewTokens,
  temperature: 0.25,
  topP: 0.9,
  topK: 40,
  repetitionPenalty: 1.1,
  verificationMode: 'standard',
});
