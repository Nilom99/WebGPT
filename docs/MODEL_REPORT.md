# SM GPT Model Verification, Compatibility & Performance Report

## 1. Pre-Implementation Model Verification (`Qwen3.5 0.6B` Check)

Before writing backend code, the requested `Qwen3.5 0.6B` (`Q8`) model was checked directly against Hugging Face and ModelScope registries:

1. `https://huggingface.co/api/models/Qwen/Qwen3.5-0.6B` returned `401` (non-existent / private non-published repository).
2. Querying `https://huggingface.co/api/models?author=Qwen&search=Qwen3.5` confirmed the official `Qwen3.5` family starts at **`Qwen/Qwen3.5-0.8B`** (`0.8B`, `2B`, `4B`, `9B`, `27B`, `35B-A3B`, etc.); no `0.6B` variant exists in `Qwen3.5` (only the older `Qwen3` line has `Qwen/Qwen3-0.6B`).
3. Per the project's strict no-silent-substitution policy, this discrepancy was reported before implementation and the user explicitly selected **`Qwen3.5-0.8B (Q8_0)`**.

---

## 2. Verified Target Artifact & Runtime Compatibility

- **Selected Model**: `Qwen3.5-0.8B` (`Q8_0` 8-bit GGUF)
- **Official GGUF Repository**: `ggml-org/Qwen3.5-0.8B-GGUF`
- **Artifact File**: `Qwen3.5-0.8B-Q8_0.gguf` (`795.0 MB` / `833,572,960` bytes verified on disk)
- **GGUF Architecture**: `qwen35` (supports `Qwen3.5` hybrid linear-attention / attention blocks; verified in `node-llama-cpp` `3.22.3` with `llama.cpp` `b*` prebuilt `@node-llama-cpp/linux-x64` shared libraries)
- **Chat Template & Thinking Control**:
  - `Qwen3.5-0.8B` natively uses ChatML boundaries (`<|im_start|>role\ncontent<|im_end|>`) and defaults to emitting `<think>...</think>` blocks unless suppressed.
  - Using plain default `resolveChatWrapper` leaves thinking active, which can consume small `max_tokens` budgets inside hidden thought tokens before emitting visible text.
  - SM GPT configures `new QwenChatWrapper({ thoughts: 'discourage' })` (which seeds empty `<think></think>` suppression) plus `sanitizeModelOutput()` tag cleanup so visible user-facing tokens stream cleanly from the start of each response.

---

## 3. Decoding & Context Configuration

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `contextSize` | `4096` tokens | Balances multi-turn history capacity and server RAM (~1.1–1.4 GB RSS). |
| `defaultMaxNewTokens` | `2048` tokens (range `64–2048`) | Allows full-length answers while respecting context budget dynamically. |
| `temperature` | `0.25` (range `0.0–1.5`) | Keeps identity, technical coding, and factual answers grounded and concise. |
| `topP` / `topK` | `0.90` / `40` | Constrains sampling tail noise. |
| `repetitionPenalty` | `1.10` (`lastTokens: 64`) | Prevents phrasing loops without harming normal syntax/code. |

---

## 4. Real Measured Benchmark & API Observations

All measurements below were observed directly in this Linux container (CPU-only `node-llama-cpp`, `Qwen3.5-0.8B-Q8_0.gguf` cached locally):

### A. Standalone Engine Integration Run (`node --test tests/backend-engine-real.mjs`)
- **Cold Model Load Time (cached GGUF → ready)**: `3,503 ms`
- **Process Memory (RSS) After Model Load**: `1,117 MB`
- **First-Token Latency (Identity Turn)**: `2,637 ms`
- **Sustained Generation Throughput**: `5.74 tokens/sec` (`13,540 ms` total for full identity answer)
- **Identity Verification**: Responded `"I am **SM GPT**, developed by **Abdus Nilom**..."` without claiming to be human or inventing personal history.
- **Multi-Turn Context Recall**: Accurately recalled `"SILVER-42"` from prior assistant/user turns.
- **Duplicate Turn Rejection & Stop**: Concurrently submitted second turn on the same `conversationId` threw `CONVERSATION_BUSY`; stopping mid-stream preserved `20` partial characters cleanly.

### B. Full-Stack Express Server (`tsx server.ts` on port `3000`)
- **Background Startup Model Load**: `4,678 ms` (`1,408 MB` RSS peak during load, `1,381 MB` steady idle RSS)
- **`POST /api/chat` Short Turn (`"2+2"`)**: `8` tokens, `3,314 ms` first-token latency, `5,887 ms` total HTTP 200.
- **Live Browser SSE Streaming (`POST /api/chat/stream`)**:
  - Identity prompt streamed `"I am SM GPT, created by Abdus Nilom..."` cleanly (`70 tokens · 26.9s`).
  - Manual **Stop** mid-stream (`POST /api/chat/stop`) halted generation immediately and preserved `36 tokens · 14.9s` in the UI and IndexedDB.
