# SM GPT Architecture Documentation

## 1. High-Level Architecture

SM GPT uses a clean full-stack architecture where the browser handles only UI presentation, IndexedDB conversation history, and SSE consumption, while a singleton Node.js + Express backend server performs all tokenization, chat-template formatting, system-prompt enforcement, and neural inference.

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Browser Frontend (index.html + style.css + app.js)                      │
│  ├── IndexedDB Persistence & TXT/JSON Export (lib/db.js)                │
│  ├── Backend SSE Client & Abort Control (lib/api-client.js)             │
│  ├── Safe Zero-XSS DOM Markdown Renderer (lib/markdown.js)              │
│  └── Heuristic Grounding Indicators (lib/hallucination.js)              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ HTTP / Server-Sent Events (/api/*)
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Express API Server (server.ts + backend/app.js)                         │
│  ├── Request Validation & System-Role Blocking (backend/validation.js)  │
│  ├── CORS Allowlist & Sanitized Public Errors                           │
│  └── Client Disconnect Abort Propagation (res.on('close'))              │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────┐
│ Singleton Backend Inference Engine (backend/inference-engine.js)        │
│  ├── One-Time Model Loader & Magic-Byte Verifier (model-downloader.js)  │
│  ├── Permanent SM GPT System Prompt & Context Trim (context-manager.js) │
│  ├── QwenChatWrapper({ thoughts: 'discourage' }) ChatML Formatter       │
│  ├── Per-Conversation Busy Lock + Serialized Request Queue              │
│  ├── GenerationGuard (Loops, Malformed Tags, Timeouts, Max 1 Retry)     │
│  └── node-llama-cpp CPU Runtime -> Qwen3.5-0.8B-Q8_0.gguf (795 MB)      │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Lifecycle & One-Time Model Reuse

1. On boot (`server.ts`), Express starts listening immediately on `PORT` (`3000`) and invokes `inferenceEngine.init()` in the background.
2. `ensureModelFile()` (`backend/model-downloader.js`) checks `.cache/models/Qwen3.5-0.8B-Q8_0.gguf` for size (`>= 750 MB`) and `GGUF` magic bytes (`0x47 0x47 0x55 0x46`). If missing or invalid, it downloads atomically via a `.tmp` file and renames on completion.
3. `initializeLlamaRuntime()` (`backend/llama-loader.js`) initializes `node-llama-cpp` (`getLlama({ build: 'never', gpu: false })`), with a verified prebuilt `@node-llama-cpp/linux-x64` binary fallback when container IPC limits block subprocess self-testing.
4. The model (`LlamaModel`) is loaded **once** into RAM (`~1.1–1.4 GB` RSS) and reused across all requests. Per request, a fresh `LlamaContext` / sequence (`contextSize = 4096`) is allocated, evaluated, and disposed deterministically in `finally` so no state leaks across conversations.

---

## 3. Permanent SM GPT Identity & Context Security

- `validateChatRequest()` (`backend/validation.js`) strictly rejects any client message where `role === 'system'` (`400 INVALID_MESSAGE_ROLE`), preventing prompt-injection replacement of system instructions.
- `buildBackendContextWindow()` (`backend/context-manager.js`) always constructs the system prompt server-side via `buildSystemPrompt()`, anchoring `PERMANENT_SYSTEM_INSTRUCTION` (SM GPT created by **Abdus Nilom**) at the top, followed optionally by `STRICT_VERIFICATION_ADDENDUM` and sanitized `stylePreferences`.
- Conversation turns are pruned oldest-first using exact `model.tokenize()` counts so `systemPrompt + selectedPrior + latestPrompt + maxNewTokens + safetyMargin` always fit within `4096` tokens.

---

## 4. Streaming, Concurrency & Cancellation

- **SSE Streaming (`POST /api/chat/stream`)**: Emits structured `event: ready`, `event: delta`, `event: done`, and `event: error` frames with `Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no`.
- **Disconnect Handling**: `res.on('close', () => { if (!res.writableEnded) ... })` aborts inference if the client drops mid-stream before completion.
- **Duplicate Request Prevention**: `activeByConversation` enforces at most one active or queued generation per `conversationId`, returning HTTP `409 CONVERSATION_BUSY` if duplicated.
- **Cross-Conversation Queue**: Different conversations serialize cleanly through a FIFO promise chain (`queueTail`, max `8` queued) to avoid CPU/memory thrashing.
- **Cancellation (`POST /api/chat/stop`)**: Triggers `AbortController.abort()`, halts `llama.cpp` decoding immediately via `stopOnAbortSignal: true`, and preserves whatever clean partial tokens were already generated.
- **GenerationGuard (`lib/generation-guard.js`)**: Intercepts runaway repetition loops (consecutive identical words, 4-gram phrase loops, repeated lines, character runs), strips leaked `<think>` / `<|im_*|>` tags, enforces first-token (`45s`), stall (`25s`), and total (`120s`) watchdogs, and allows at most **1** silent automatic retry with tightened sampling parameters if the first attempt fails empty or malformed.

---

## 5. Sanitized Public Status & Error Handling

- `GET /api/model/status` returns only `{ status, ready, message, activeRequests, queuedRequests, uptimeSec }` where `message` is `"Loading SM GPT..."`, `"Ready"`, `"Generating..."`, or `"Service temporarily unavailable"`.
- `sanitizePublicErrorMessage()` strips file paths, repository IDs, quantization tags, and model names from any client-facing error payload.
