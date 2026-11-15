# SM GPT Test Execution Report

## 1. Automated Unit & Express API Tests (`node --test tests/*.test.js`)

- **Total Tests**: 26
- **Passed**: 26
- **Failed**: 0
- **Duration**: 861.97 ms

| Suite | Coverage | Result |
| :--- | :--- | :--- |
| `tests/backend-api.test.js` | `GET /api/health`, `GET /api/model/status` (no model-name leakage), `POST /api/chat` validation (`400` on client `role: system`), `POST /api/chat/stream` SSE frames (`ready`, `delta`, `done`), `POST /api/chat/stop` | 1 / 1 Passed |
| `tests/backend-validation.test.js` | Message array validation, option clamping, system-role blocking (`INVALID_MESSAGE_ROLE`), stop-request validation, CORS allowlist resolution, `sanitizePublicErrorMessage` stripping model/path strings | 5 / 5 Passed |
| `tests/context-manager.test.js` | Permanent SM GPT / Abdus Nilom system prompt injection, oldest-first pruning within context budget, oversized prompt truncation, `exactTokenizer` callback | 4 / 4 Passed |
| `tests/db.test.js` | Conversation CRUD, search, rename, delete, `.txt` & `.json` export formatting | 1 / 1 Passed |
| `tests/generation-guard.test.js` | Consecutive word loops, 4-gram loops, repeated lines, natural repetition & code-block safety, leaked ChatML tag catching, `\uFFFD` detection, token limits, partial preservation, max-1 auto retry | 7 / 7 Passed |
| `tests/hallucination.test.js` | Backend strict verification prompt augmentation, unverified URL detection, user-provided URL allowance, uncertainty recognition | 4 / 4 Passed |
| `tests/markdown.test.js` | XSS link sanitization (`javascript:`/`data:` blocked), inline tokens, headings/lists/tables/code fences, syntax highlighting tokens | 4 / 4 Passed |

---

## 2. Live Backend Model Integration Test (`node --test tests/backend-engine-real.mjs`)

- **Model**: `Qwen3.5-0.8B-Q8_0.gguf` (`ggml-org/Qwen3.5-0.8B-GGUF`) via `node-llama-cpp`
- **Verified Behaviors**:
  - Single-time initialization (`3,503 ms` load, `1,117 MB` RSS)
  - Live `onTokenChunk` streaming (`5.74 tokens/sec`, `2,637 ms` first-token latency)
  - Permanent identity enforcement (`SM GPT` + `Abdus Nilom`, no human claim)
  - Multi-turn context retention (`SILVER-42` recalled accurately)
  - Per-conversation busy lock (`CONVERSATION_BUSY` rejected duplicate request cleanly)
  - Immediate cancellation preserving partial output (`20` chars preserved)
- **Result**: 1 / 1 Passed (`32,998 ms` test duration)

---

## 3. Build & Type Verification

- `npm run lint` (`tsc --noEmit`): Passed (exit code 0)
- `npm run build` (`vite build`): Passed (production bundle built cleanly)
- `node --check server.ts`: Passed (Node `v22.23.2` exit code 0)

---

## 4. Live HTTP & Headless Chromium E2E Verification (`http://localhost:3000`)

### Direct API Checks
- `GET /api/model/status` -> `200 OK`: `{"status":"ready","ready":true,"message":"Ready","activeRequests":0,"queuedRequests":0,"uptimeSec":7}`
- `GET /api/health` -> `200 OK`: `{"ok":true,"status":"ready","ready":true,"memoryRssMb":1381,"metrics":{"loadTimeMs":4678,"memoryAfterLoadMb":1408,...}}`
- `POST /api/chat` with client `role: "system"` -> `400 Bad Request` (`INVALID_MESSAGE_ROLE`)
- `POST /api/chat` with `"what is 2+2?"` -> `200 OK` (`"2+2 equals 4."`, `8` tokens, `5,887 ms`)

### Browser Verification (`playwright-cli` Chromium)
- **Desktop (`1440x900`)**:
  - Initial render showed `"Ready"`, zero console errors/warnings, and `textLeak: false` (no `Qwen`, `GGUF`, `Q8_0`, `0.8B`, or `SmolLM` exposed anywhere in the DOM).
  - Network log confirmed the browser made requests only to static assets and `/api/model/status`, `/api/chat/stream`, `/api/chat/stop` — zero model downloads or client-side AI execution.
  - Clicking `"Meet SM GPT"` streamed `"I am SM GPT, created by Abdus Nilom..."` cleanly (`70 tokens · 26.9s`).
  - Settings modal verified (`Appearance`, `2048 tokens`, `Response Style Preferences (Optional)`, `Temperature`, `Repetition Penalty`, `Verification Mode`; no browser compute/cache controls).
  - Theme switching (`Dark` <-> `Light`), `New chat`, live **Stop** cancellation mid-stream (`"Generation stopped early. Partial response preserved."`, `36 tokens · 14.9s`), search filtering (`"JavaScript"`), and full page reload persistence (both chats + Light theme preserved in IndexedDB) all passed.
- **Mobile (`390x844`)**:
  - Verified zero horizontal overflow (`innerWidth === 390`, `scrollWidth === 390`, `overflowX === false`), single-row topbar fit, and clean message layout.
- **Console**: `Errors: 0, Warnings: 0`.
