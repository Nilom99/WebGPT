/**
 * SM GPT — Shared Frontend Configuration
 * Created by Abdus Nilom
 * Note: Model selection, system identity, and inference execute strictly on the backend.
 */

export const APP_IDENTITY = Object.freeze({
  name: 'SM GPT',
  creator: 'Abdus Nilom',
  connectingText: 'Connecting...',
  loadingText: 'Loading SM GPT...',
  readyText: 'Ready',
  generatingText: 'Generating...',
  connectionErrorText: 'Connection error',
  storageNotice:
    'Conversations and settings are stored locally in your browser (IndexedDB). All AI responses are generated on the SM GPT backend.',
});

export const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  maxNewTokens: 2048,
  temperature: 0.25,
  topP: 0.9,
  topK: 40,
  repetitionPenalty: 1.1,
  verificationMode: 'standard', // 'standard' | 'strict'
  stylePreferences: '',
});

export const SETTINGS_LIMITS = Object.freeze({
  maxNewTokens: { min: 64, max: 2048, step: 64 },
  temperature: { min: 0.0, max: 1.2, step: 0.05 },
  topP: { min: 0.5, max: 1.0, step: 0.05 },
  repetitionPenalty: { min: 1.0, max: 1.5, step: 0.02 },
});

export const CONTEXT_BUDGET = Object.freeze({
  maxModelTokens: 4096,
  maxPromptTokens: 1984,
  reservedOutputTokens: 2048,
  charsPerTokenEstimate: 3.5,
  perMessageOverheadTokens: 10,
});

export const GENERATION_GUARD_CONFIG = Object.freeze({
  timeoutMs: 120000,
  firstTokenTimeoutMs: 45000,
  stallTimeoutMs: 25000,
  maxAutoRetries: 1,
  maxConsecutiveIdenticalWords: 5,
  ngramSize: 4,
  ngramRepeatThreshold: 4,
  sentenceRepeatThreshold: 3,
  charRepeatThreshold: 18,
  minCharsForRepetitionCheck: 48,
});

export const STARTER_PROMPTS = Object.freeze([
  {
    title: 'Meet SM GPT',
    prompt: 'Who are you and who created you?',
  },
  {
    title: 'Explain a concept simply',
    prompt: 'Explain how Server-Sent Events stream AI responses in real time.',
  },
  {
    title: 'Write clean JavaScript',
    prompt: 'Write a concise JavaScript function that debounces search input events with comments.',
  },
  {
    title: 'Draft a structured note',
    prompt: 'Help me outline a short, friendly project update email with three clear bullet points.',
  },
]);
