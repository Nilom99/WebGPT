# Known Limitations & Operational Notes

1. **Model Availability Note (`Qwen3.5 0.6B` vs `Qwen3.5-0.8B Q8_0`)**:
   - No official `Qwen3.5 0.6B` release exists on Hugging Face or ModelScope (the `Qwen3.5` series begins at `0.8B`). Per the user's explicit confirmation, SM GPT runs the official `ggml-org/Qwen3.5-0.8B-GGUF` (`Qwen3.5-0.8B-Q8_0.gguf`, `795.0 MB`) artifact.
2. **CPU Inference Throughput & Request Queue Serialization**:
   - In CPU-only environments (like this container), `Qwen3.5-0.8B-Q8_0` generates at ~`5.7 tokens/sec` with ~`2.6–3.3s` time-to-first-token.
   - To keep server memory predictable (~`1.1–1.4 GB` RSS) and prevent CPU thrashing, `InferenceEngine` serializes generation requests across conversations (queue capacity `8`) and allows at most one active request per `conversationId`. Multi-worker horizontal scaling or GPU offloading (`gpu: 'auto'`) is recommended for high concurrency.
3. **0.8B Reasoning & Context Interpretation Ceiling**:
   - At `0.8B` parameters, `Qwen3.5-0.8B` is fast and well-suited for concise explanations, coding assistance, and chat, but can occasionally over-index on strong identity phrasing (for example, adding a brief identity reminder on certain turns or phrasing "remember" prompts cautiously unless framed around the current conversation).
4. **Client-Side Chat History (IndexedDB)**:
   - Conversations and UI settings continue to be stored locally in the user's browser (`IndexedDB`) while all inference runs on the backend. Clearing browser site data removes local chat history unless exported first via `Export TXT` / `Export JSON`.
5. **Container Sandbox Subprocess Restriction**:
   - Some hardened container runtimes (such as gVisor) restrict Node `child_process.fork()` IPC used by `node-llama-cpp`'s default binding probe. `backend/llama-loader.js` handles this automatically by loading the verified prebuilt `@node-llama-cpp/linux-x64` native addon directly after `getLlama({ build: 'never' })`.
