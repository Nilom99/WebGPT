# SM GPT

**SM GPT** is a full-stack AI chat assistant created by **Abdus Nilom**. All AI inference runs on a dedicated **Node.js + Express backend** powered by `node-llama-cpp` executing **`Qwen3.5-0.8B` (`Q8_0` GGUF)**, streaming responses in real time to the browser over Server-Sent Events (SSE) while keeping conversation history and preferences in IndexedDB.

The browser never loads, downloads, initializes, or executes any AI model weights.

---

## Project Directory Structure

```text
/
├── server.ts                      # Express + Vite (dev) / static dist/ (prod) entrypoint on port 3000
├── backend/
│   ├── app.js                     # Express API routes (/api/health, /api/model/status, /api/chat*)
│   ├── config.js                  # Permanent SM GPT identity prompt, Qwen3.5-0.8B Q8_0 spec & limits
│   ├── context-manager.js         # Backend token-budget context window & permanent prompt injector
│   ├── inference-engine.js        # Singleton model loader, QwenChatWrapper, queue, guards & stop control
│   ├── llama-loader.js            # Verified node-llama-cpp CPU runtime loader (with prebuilt fallback)
│   ├── model-downloader.js        # Atomic GGUF download & magic-byte integrity verification
│   └── validation.js              # Request/CORS validation, system-role rejection & error sanitization
├── index.html                     # Semantic HTML5 application shell
├── style.css                      # Responsive light/dark CSS3 stylesheet
├── app.js                         # Frontend UI controller (SSE streaming + IndexedDB state)
├── config/
│   └── app.config.js              # Frontend UI constants, default settings & starter prompts
├── lib/
│   ├── api-client.js              # SSE parser + /api/model/status, /api/chat/stream, /api/chat/stop client
│   ├── db.js                      # IndexedDB conversation & settings persistence + TXT/JSON exporters
│   ├── generation-guard.js        # Repetition-loop detector, malformed checks, limits & retry policy
│   ├── hallucination.js           # Grounding heuristic checks (unverified URLs & uncertainty framing)
│   └── markdown.js                # Zero-XSS DOM Markdown renderer & syntax highlighter
├── tests/
│   ├── backend-api.test.js        # Express endpoint tests (/api/health, /api/model/status, /api/chat*)
│   ├── backend-validation.test.js # Request validation, system-role blocking, CORS & error sanitization
│   ├── backend-engine-real.mjs    # Live Qwen3.5-0.8B Q8_0 load, identity, context, busy-lock & stop test
│   ├── context-manager.test.js    # Backend context window & permanent prompt preservation tests
│   ├── db.test.js                 # IndexedDB fallback & TXT/JSON export tests
│   ├── generation-guard.test.js   # Repetition-loop, malformed output, timeout & retry tests
│   ├── hallucination.test.js      # Grounding & uncertainty verification tests
│   └── markdown.test.js           # Zero-XSS DOM Markdown & code highlighting tests
├── docs/
│   ├── ARCHITECTURE.md            # Backend & frontend architecture, API schema & security flow
│   ├── MODEL_REPORT.md            # Qwen3.5-0.6B verification -> Qwen3.5-0.8B Q8_0 & measured metrics
│   ├── TEST_REPORT.md             # Executed unit, API, live-engine & Chromium E2E results
│   └── LIMITATIONS.md             # Operational constraints & scaling notes
├── .env.example                   # Backend configuration environment template
├── metadata.json                  # Application metadata
├── package.json                   # Dependencies and runtime scripts
├── tsconfig.json                  # TypeScript check configuration
└── vite.config.ts                 # Vite build & dev config
```

---

## Backend API Endpoints

| Method | Path | Purpose |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Returns backend readiness, uptime, active/queued counts, RSS memory, and latency/throughput metrics. |
| `GET` | `/api/model/status` | Returns user-safe readiness (`status`, `ready`, `message`, queue counts) without exposing technical model names or file paths. |
| `POST` | `/api/chat` | Executes a non-streaming completion for `{ conversationId, requestId, messages, options }`. |
| `POST` | `/api/chat/stream` | Streams tokens via Server-Sent Events (`ready`, `delta`, `done`, `error`), handles client disconnects, and preserves partial text on stop. |
| `POST` | `/api/chat/stop` | Immediately aborts an active generation by `requestId` and/or `conversationId`. |

---

## Setup & Development

### Prerequisites
- **Node.js 22+** (tested on Node `v22.23.2`)
- **~1.5 GB free RAM** and **~850 MB free disk space** for `Qwen3.5-0.8B-Q8_0.gguf` (`795.0 MB`)
- Outbound HTTPS access to Hugging Face on first boot (if `.cache/models/Qwen3.5-0.8B-Q8_0.gguf` is not yet cached)

### Configuration
Copy `.env.example` to `.env` if you need custom settings:
```bash
cp .env.example .env
```
Key environment variables:
- `PORT=3000` / `HOST=0.0.0.0`
- `CORS_ORIGIN=*` (set to your frontend origin in production, comma-separated for multiple origins)
- `MODEL_REPO=ggml-org/Qwen3.5-0.8B-GGUF`
- `MODEL_FILE=Qwen3.5-0.8B-Q8_0.gguf`
- `MODEL_CACHE_DIR=.cache/models`
- `MODEL_CONTEXT_SIZE=4096`
- `DEFAULT_MAX_TOKENS=2048`
- `GENERATION_TIMEOUT_MS=120000`, `FIRST_TOKEN_TIMEOUT_MS=45000`, `STALL_TIMEOUT_MS=25000`
- `THREADS=` (optional CPU thread override for `llama.cpp`)

### Install & Run in Development
```bash
npm install
npm run dev
```
This starts `tsx server.ts` on `http://localhost:3000`, mounts Vite dev middlewares for the frontend, and initializes `Qwen3.5-0.8B-Q8_0.gguf` once in the background.

### Production Build & Start
```bash
npm run build
NODE_ENV=production npm start
```
`npm run build` compiles the frontend into `dist/`. `npm start` runs `node server.ts`, serving both the static `dist/` bundle and the Express `/api/*` inference server on port `3000`.

### Run Automated Tests
```bash
# Unit & Express API tests (fast, no model load)
node --test tests/*.test.js

# Live backend inference integration test (runs real Qwen3.5-0.8B Q8_0)
node --test tests/backend-engine-real.mjs

# TypeScript check & production build
npm run lint
npm run build
```

---

## Deployment Notes

- Run behind a reverse proxy (Nginx, Caddy, Cloudflare, or Cloud Run) with **proxy buffering disabled** for `POST /api/chat/stream` (`X-Accel-Buffering: no` is already sent by Express).
- Set `CORS_ORIGIN` to the exact origin(s) hosting your frontend if frontend and backend are deployed separately.
- Pre-populate or mount a persistent volume at `MODEL_CACHE_DIR` (`.cache/models`) so container restarts reuse the cached `795 MB` GGUF file instead of re-downloading it.
