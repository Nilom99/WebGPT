/**
 * SM GPT Dedicated Backend Inference Engine (Qwen3.5-0.8B Q8_0 via node-llama-cpp)
 *
 * Guarantees:
 * - One-time model initialization reused across all requests (never reloaded per prompt)
 * - Permanent SM GPT / Abdus Nilom system instruction injection
 * - Native Qwen3.5 ChatML template with controlled non-thinking direct response flow
 * - Per-conversation concurrency protection + serialized queue across conversations
 * - GenerationGuard (loop detection, token limits, timeouts, malformed stripping)
 * - Immediate AbortController cancellation & partial response preservation
 */

import { LlamaChatSession, QwenChatWrapper } from 'node-llama-cpp';
import {
  GenerationGuard,
  shouldAutoRetry,
} from '../lib/generation-guard.js';
import { BACKEND_CONFIG, MODEL_SPEC } from './config.js';
import { buildBackendContextWindow } from './context-manager.js';
import { initializeLlamaRuntime } from './llama-loader.js';
import { ensureModelFile } from './model-downloader.js';

const THINK_BLOCK_REGEX = /<think>[\s\S]*?<\/think>/gi;
const LEAKED_TAGS_REGEX = /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>|<\/?think>/gi;

export function sanitizeModelOutput(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(THINK_BLOCK_REGEX, '')
    .replace(LEAKED_TAGS_REGEX, '')
    .replace(/\uFFFD+/g, '')
    .trim();
}

export class InferenceEngine {
  constructor() {
    this.status = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
    this.error = null;
    this.llama = null;
    this.model = null;
    this.modelPath = null;
    this.initPromise = null;
    this.startedAt = Date.now();

    // Runtime performance metrics (real measurements only)
    this.metrics = {
      modelCachedOnBoot: null,
      modelBytes: 0,
      loadTimeMs: null,
      memoryAfterLoadMb: null,
      totalRequests: 0,
      completedRequests: 0,
      cancelledRequests: 0,
      failedRequests: 0,
      lastFirstTokenLatencyMs: null,
      lastTokensPerSec: null,
      lastGenerationMs: null,
    };

    // Active / queued jobs
    this.activeByConversation = new Map();
    this.activeJobsByRequestId = new Map();
    this.queueTail = Promise.resolve();
    this.queuedCount = 0;
  }

  async init() {
    if (this.status === 'ready' && this.model) return;
    if (this.initPromise) return this.initPromise;

    this.status = 'loading';
    this.error = null;

    this.initPromise = (async () => {
      const t0 = performance.now();
      try {
        const artifact = await ensureModelFile();
        this.modelPath = artifact.modelPath;
        this.metrics.modelCachedOnBoot = artifact.cached;
        this.metrics.modelBytes = artifact.bytes;

        this.llama = await initializeLlamaRuntime({
          maxThreads: BACKEND_CONFIG.threads,
        });
        this.model = await this.llama.loadModel({
          modelPath: this.modelPath,
        });

        const loadTimeMs = Math.round(performance.now() - t0);
        this.metrics.loadTimeMs = loadTimeMs;
        this.metrics.memoryAfterLoadMb = Math.round(
          process.memoryUsage().rss / (1024 * 1024)
        );
        this.status = 'ready';
      } catch (err) {
        this.status = 'error';
        this.error = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  getPublicStatus() {
    let message = 'Loading SM GPT...';
    if (this.status === 'ready') {
      message = this.activeJobsByRequestId.size > 0 ? 'Generating...' : 'Ready';
    } else if (this.status === 'error') {
      message = 'Service temporarily unavailable';
    }

    return {
      status: this.status === 'idle' ? 'loading' : this.status,
      ready: this.status === 'ready',
      message,
      activeRequests: this.activeJobsByRequestId.size,
      queuedRequests: this.queuedCount,
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
    };
  }

  getHealthReport() {
    const rssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
    return {
      ok: this.status !== 'error',
      status: this.status,
      ready: this.status === 'ready',
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      activeGenerations: this.activeJobsByRequestId.size,
      queuedGenerations: this.queuedCount,
      memoryRssMb: rssMb,
      metrics: {
        loadTimeMs: this.metrics.loadTimeMs,
        memoryAfterLoadMb: this.metrics.memoryAfterLoadMb,
        lastFirstTokenLatencyMs: this.metrics.lastFirstTokenLatencyMs,
        lastTokensPerSec: this.metrics.lastTokensPerSec,
        totalRequests: this.metrics.totalRequests,
        completedRequests: this.metrics.completedRequests,
        cancelledRequests: this.metrics.cancelledRequests,
      },
    };
  }

  /**
   * Cancels an active or queued generation by requestId and/or conversationId.
   */
  stopGeneration({ requestId = null, conversationId = null } = {}) {
    let stopped = false;
    let targetRequestId = requestId;
    let targetConversationId = conversationId;

    for (const job of this.activeJobsByRequestId.values()) {
      const matchReq = requestId && job.requestId === requestId;
      const matchConv = conversationId && job.conversationId === conversationId;
      if (matchReq || matchConv) {
        job.userCancelled = true;
        job.cancelReason = 'Cancelled by user request';
        job.abortController.abort(new Error('USER_CANCELLED'));
        stopped = true;
        targetRequestId = job.requestId;
        targetConversationId = job.conversationId;
      }
    }

    return {
      stopped,
      requestId: targetRequestId,
      conversationId: targetConversationId,
    };
  }

  /**
   * Executes a chat generation request with optional live token callback.
   * Rejects duplicate concurrent requests for the same conversationId.
   */
  async runGeneration(
    { conversationId, requestId, messages, options },
    { onTokenChunk = null, externalAbortSignal = null } = {}
  ) {
    if (this.status !== 'ready' || !this.model) {
      if (this.status === 'idle' || this.status === 'loading') {
        await this.init();
      } else {
        const err = new Error('MODEL_NOT_READY');
        err.code = 'MODEL_NOT_READY';
        throw err;
      }
    }

    if (this.activeByConversation.has(conversationId)) {
      const err = new Error('CONVERSATION_BUSY');
      err.code = 'CONVERSATION_BUSY';
      throw err;
    }

    if (this.queuedCount >= BACKEND_CONFIG.maxConcurrentQueued) {
      const err = new Error('QUEUE_FULL');
      err.code = 'QUEUE_FULL';
      throw err;
    }

    const job = {
      requestId,
      conversationId,
      abortController: new AbortController(),
      userCancelled: false,
      clientDisconnected: false,
      cancelReason: null,
    };

    const onExternalAbort = () => {
      if (!job.userCancelled) {
        job.clientDisconnected = true;
        job.cancelReason = 'Client disconnected';
      }
      job.abortController.abort(new Error('CLIENT_ABORTED'));
    };

    if (externalAbortSignal) {
      if (externalAbortSignal.aborted) {
        onExternalAbort();
      } else {
        externalAbortSignal.addEventListener('abort', onExternalAbort, { once: true });
      }
    }

    this.activeByConversation.set(conversationId, job);
    this.activeJobsByRequestId.set(requestId, job);
    this.metrics.totalRequests += 1;
    this.queuedCount += 1;

    const executeTask = async () => {
      this.queuedCount = Math.max(0, this.queuedCount - 1);
      if (job.abortController.signal.aborted) {
        return {
          status: 'cancelled',
          text: '',
          tokenCount: 0,
          finishReason: 'cancelled',
          guardNotice: null,
          durationMs: 0,
          firstTokenLatencyMs: null,
          tokensPerSec: 0,
        };
      }
      return this.#executeSingleJob(job, messages, options, onTokenChunk);
    };

    const queuedPromise = this.queueTail.then(executeTask, executeTask);
    this.queueTail = queuedPromise.then(
      () => undefined,
      () => undefined
    );

    try {
      return await queuedPromise;
    } finally {
      if (externalAbortSignal) {
        externalAbortSignal.removeEventListener('abort', onExternalAbort);
      }
      if (this.activeByConversation.get(conversationId)?.requestId === requestId) {
        this.activeByConversation.delete(conversationId);
      }
      this.activeJobsByRequestId.delete(requestId);
    }
  }

  async #executeSingleJob(job, messages, options, onTokenChunk) {
    const exactTokenizer = (text) => this.model.tokenize(text, false, 'trimLeadingSpace').length;
    const contextWindow = buildBackendContextWindow(messages, {
      contextSize: MODEL_SPEC.contextSize,
      maxNewTokens: options.maxNewTokens,
      verificationMode: options.verificationMode,
      stylePreferences: options.stylePreferences,
      exactTokenizer,
    });

    const guardConfig = {
      timeoutMs: BACKEND_CONFIG.generationTimeoutMs,
      firstTokenTimeoutMs: BACKEND_CONFIG.firstTokenTimeoutMs,
      stallTimeoutMs: BACKEND_CONFIG.stallTimeoutMs,
      maxAutoRetries: 1,
      maxConsecutiveIdenticalWords: 5,
      ngramSize: 4,
      ngramRepeatThreshold: 4,
      sentenceRepeatThreshold: 3,
      charRepeatThreshold: 18,
      minCharsForRepetitionCheck: 48,
    };

    const startedAt = performance.now();
    let attemptIndex = 0;
    let finalAttempt = null;

    while (attemptIndex <= guardConfig.maxAutoRetries) {
      const attempt = await this.#runSingleAttempt({
        job,
        contextWindow,
        options,
        guardConfig,
        attemptIndex,
        onTokenChunk: attemptIndex === 0 ? onTokenChunk : null,
      });

      if (job.userCancelled || job.clientDisconnected) {
        this.metrics.cancelledRequests += 1;
        return {
          status: 'cancelled',
          text: sanitizeModelOutput(attempt.text),
          tokenCount: attempt.tokenCount,
          finishReason: job.clientDisconnected ? 'client_disconnected' : 'cancelled',
          guardNotice: null,
          durationMs: Math.round(performance.now() - startedAt),
          firstTokenLatencyMs: attempt.firstTokenLatencyMs,
          tokensPerSec: attempt.tokensPerSec,
        };
      }

      const cleanAttemptText = sanitizeModelOutput(attempt.text);
      const isEmpty = cleanAttemptText.length === 0;
      const effectiveTripType = isEmpty ? 'empty' : attempt.tripType;

      const needsRetry =
        (isEmpty ||
          (attempt.tripped &&
            (attempt.tripType === 'malformed' ||
              (attempt.tripType === 'loop' && cleanAttemptText.length < 32)))) &&
        shouldAutoRetry(attemptIndex, effectiveTripType);

      if (needsRetry) {
        attemptIndex += 1;
        continue;
      }

      finalAttempt = { ...attempt, text: cleanAttemptText };
      break;
    }

    const totalMs = Math.round(performance.now() - startedAt);
    if (!finalAttempt || !finalAttempt.text) {
      this.metrics.failedRequests += 1;
      const err = new Error('EMPTY_GENERATION');
      err.code = 'EMPTY_GENERATION';
      throw err;
    }

    // If retried silently after initial attempt failed early, stream final text in one chunk if needed
    if (attemptIndex > 0 && typeof onTokenChunk === 'function') {
      onTokenChunk(finalAttempt.text);
    }

    this.metrics.completedRequests += 1;
    this.metrics.lastFirstTokenLatencyMs = finalAttempt.firstTokenLatencyMs;
    this.metrics.lastTokensPerSec = finalAttempt.tokensPerSec;
    this.metrics.lastGenerationMs = totalMs;

    return {
      status: 'completed',
      text: finalAttempt.text,
      tokenCount: finalAttempt.tokenCount,
      finishReason: finalAttempt.tripped ? finalAttempt.tripType : 'stop',
      guardNotice: finalAttempt.tripped ? finalAttempt.tripReason : null,
      durationMs: totalMs,
      firstTokenLatencyMs: finalAttempt.firstTokenLatencyMs,
      tokensPerSec: finalAttempt.tokensPerSec,
    };
  }

  async #runSingleAttempt({
    job,
    contextWindow,
    options,
    guardConfig,
    attemptIndex,
    onTokenChunk,
  }) {
    const attemptAbortController = new AbortController();
    const forwardParentAbort = () => attemptAbortController.abort(job.abortController.signal.reason);
    if (job.abortController.signal.aborted) {
      forwardParentAbort();
    } else {
      job.abortController.signal.addEventListener('abort', forwardParentAbort, { once: true });
    }

    const context = await this.model.createContext({
      contextSize: MODEL_SPEC.contextSize,
    });
    const sequence = context.getSequence();
    const chatWrapper = new QwenChatWrapper({ thoughts: 'discourage' });
    const session = new LlamaChatSession({
      contextSequence: sequence,
      chatWrapper,
      systemPrompt: contextWindow.systemPrompt,
      autoDisposeSequence: false,
    });

    if (contextWindow.priorHistory.length > 0) {
      const historyItems = [
        { type: 'system', text: contextWindow.systemPrompt },
        ...contextWindow.priorHistory.map((m) =>
          m.role === 'user'
            ? { type: 'user', text: m.content }
            : { type: 'model', response: [m.content] }
        ),
      ];
      session.setChatHistory(historyItems);
    }

    const guard = new GenerationGuard({
      maxNewTokens: options.maxNewTokens,
      config: guardConfig,
    });

    const attemptStart = performance.now();
    let firstTokenLatencyMs = null;
    let watchdog = null;

    // Slight parameter tightening on retry
    const temperature =
      attemptIndex === 0 ? options.temperature : Math.max(0.1, options.temperature - 0.1);
    const repeatPenaltyValue =
      attemptIndex === 0
        ? options.repetitionPenalty
        : Math.min(1.28, options.repetitionPenalty + 0.08);

    try {
      watchdog = setInterval(() => {
        const timeoutStatus = guard.checkTimeout();
        if (timeoutStatus.tripped && !attemptAbortController.signal.aborted) {
          attemptAbortController.abort(new Error('GENERATION_TIMEOUT'));
        }
      }, 250);

      await session.promptWithMeta(contextWindow.latestPrompt, {
        maxTokens: options.maxNewTokens,
        temperature,
        topP: options.topP,
        topK: options.topK,
        repeatPenalty: {
          penalty: repeatPenaltyValue,
          lastTokens: 64,
        },
        trimWhitespaceSuffix: true,
        signal: attemptAbortController.signal,
        stopOnAbortSignal: true,
        onToken: (tokens) => {
          if (firstTokenLatencyMs === null) {
            firstTokenLatencyMs = Math.round(performance.now() - attemptStart);
          }
          const status = guard.recordTokens(tokens?.length || 1);
          if (status.tripped && !attemptAbortController.signal.aborted) {
            attemptAbortController.abort(new Error('GUARD_TRIPPED'));
          }
        },
        onTextChunk: (chunk) => {
          if (!chunk || job.userCancelled || job.clientDisconnected || guard.tripped) return;
          const prevLen = guard.text.length;
          const status = guard.appendText(chunk);

          if (!status.tripped) {
            if (typeof onTokenChunk === 'function') {
              onTokenChunk(chunk);
            }
          } else {
            const preserved = guard.getPreservedText();
            if (preserved.length > prevLen && typeof onTokenChunk === 'function') {
              onTokenChunk(preserved.slice(prevLen));
            }
            if (!attemptAbortController.signal.aborted) {
              attemptAbortController.abort(new Error('GUARD_TRIPPED'));
            }
          }
        },
      });
    } catch (err) {
      if (!job.userCancelled && !job.clientDisconnected && !guard.tripped) {
        throw err;
      }
    } finally {
      if (watchdog !== null) clearInterval(watchdog);
      job.abortController.signal.removeEventListener('abort', forwardParentAbort);
      try {
        session.dispose?.();
      } catch {
        // Ignore session dispose error
      }
      try {
        sequence.dispose();
      } catch {
        // Ignore sequence dispose error
      }
      try {
        await context.dispose();
      } catch {
        // Ignore context dispose error
      }
    }

    const elapsedSec = Math.max(0.01, (performance.now() - attemptStart) / 1000);
    const status = guard.getStatus();
    const preserved = guard.getPreservedText();
    const tokensPerSec =
      status.tokenCount > 0 ? Number((status.tokenCount / elapsedSec).toFixed(2)) : 0;

    return {
      text: preserved,
      tripped: status.tripped,
      tripType: status.tripType,
      tripReason: status.tripReason,
      tokenCount: status.tokenCount,
      firstTokenLatencyMs,
      tokensPerSec,
    };
  }
}

export const inferenceEngine = new InferenceEngine();
