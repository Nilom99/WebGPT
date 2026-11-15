/**
 * Hallucination Management & Honest Verification Helpers for SM GPT
 * - Distinguishes user-provided context from unverified model links/identifiers
 * - Surfaces honest uncertainty advisories without claiming perfect detection
 */

const URL_REGEX = /https?:\/\/[^\s)>"'`]+/gi;
const FABRICATED_DOI_OR_ISBN_REGEX = /\b(?:doi:\s*10\.\d{4,9}\/[-._;()/:A-Z0-9]+|ISBN(?:-1[03])?:?\s*[0-9-]{10,17})\b/gi;

/**
 * Extracts normalized URLs from text.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  if (typeof text !== 'string') return [];
  const matches = text.match(URL_REGEX) ?? [];
  return Array.from(new Set(matches.map((u) => u.replace(/[.,;:!?]+$/, ''))));
}

/**
 * Analyzes an assistant response against user-provided conversation context
 * to surface an honest advisory when unverified external links or identifiers appear.
 * Never claims perfect hallucination detection.
 *
 * @param {string} responseText
 * @param {Array<{ role: string, content: string }>} contextMessages
 * @param {'standard'|'strict'} [verificationMode]
 */
export function assessResponseGrounding(responseText, contextMessages = [], verificationMode = 'standard') {
  if (typeof responseText !== 'string' || responseText.trim().length === 0) {
    return { status: 'standard', label: null, details: null, unverifiedUrls: [] };
  }

  const userCorpus = contextMessages
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content)
    .join('\n');

  const userUrls = new Set(extractUrls(userCorpus));
  const responseUrls = extractUrls(responseText);
  const unverifiedUrls = responseUrls.filter((url) => !userUrls.has(url));
  const hasNewIdentifiers =
    FABRICATED_DOI_OR_ISBN_REGEX.test(responseText) &&
    !FABRICATED_DOI_OR_ISBN_REGEX.test(userCorpus);

  if (unverifiedUrls.length > 0 || hasNewIdentifiers) {
    return {
      status: 'unverified_claims',
      label: 'Unverified reference',
      details:
        'Contains links or identifiers not present in your prompt. SM GPT cannot browse live sources here; verify external references independently.',
      unverifiedUrls,
    };
  }

  const uncertaintyPhrases = [
    'i am not sure',
    "i'm not sure",
    'i cannot verify',
    "i can't verify",
    'uncertain',
    'do not have access',
    "don't have access",
    'cannot confirm',
  ];
  const lower = responseText.toLowerCase();
  if (uncertaintyPhrases.some((phrase) => lower.includes(phrase))) {
    return {
      status: 'uncertainty_expressed',
      label: 'Uncertainty noted',
      details: 'SM GPT explicitly noted limits on what can be verified from context.',
      unverifiedUrls: [],
    };
  }

  if (verificationMode === 'strict') {
    return {
      status: 'verified_context',
      label: 'Verification mode',
      details:
        'Generated with strict verification guidance active. Confidence does not guarantee factual accuracy.',
      unverifiedUrls: [],
    };
  }

  return { status: 'standard', label: null, details: null, unverifiedUrls: [] };
}
