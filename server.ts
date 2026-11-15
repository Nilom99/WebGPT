/**
 * SM GPT Full-Stack Entry Server
 * Serves the Express AI Inference API and mounts Vite (dev) or static dist/ (production).
 */

import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackendApp } from './backend/app.js';
import { BACKEND_CONFIG } from './backend/config.js';
import { inferenceEngine } from './backend/inference-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = createBackendApp({ engine: inferenceEngine });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.join(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build first.');
      }
    });
  }

  const server = app.listen(BACKEND_CONFIG.port, BACKEND_CONFIG.host, () => {
    console.log(
      `[SM GPT] Server listening on http://${BACKEND_CONFIG.host}:${BACKEND_CONFIG.port} (${isProduction ? 'production' : 'development'})`
    );
  });

  // Load model once in background on startup and reuse across all requests
  inferenceEngine.init().catch((err) => {
    console.error('[SM GPT] Background model initialization error:', err instanceof Error ? err.message : err);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

startServer().catch((err) => {
  console.error('[SM GPT] Fatal startup failure:', err);
  process.exit(1);
});
