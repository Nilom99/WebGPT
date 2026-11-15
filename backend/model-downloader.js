/**
 * Integrity-verified GGUF Model Artifact Downloader & Cache Validator
 * Verifies file existence, minimum byte length, and GGUF magic header ('GGUF').
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { BACKEND_CONFIG, MODEL_SPEC } from './config.js';

let pendingEnsurePromise = null;

export function isValidGgufFile(filePath, minBytes = MODEL_SPEC.minBytes) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < minBytes) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(4);
      const bytesRead = fs.readSync(fd, header, 0, 4, 0);
      return bytesRead === 4 && header.toString('ascii') === 'GGUF';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export async function ensureModelFile() {
  if (pendingEnsurePromise) return pendingEnsurePromise;

  pendingEnsurePromise = (async () => {
    fs.mkdirSync(BACKEND_CONFIG.modelCacheDir, { recursive: true });
    const targetPath = path.join(BACKEND_CONFIG.modelCacheDir, MODEL_SPEC.filename);

    if (isValidGgufFile(targetPath, MODEL_SPEC.minBytes)) {
      return {
        modelPath: targetPath,
        bytes: fs.statSync(targetPath).size,
        cached: true,
      };
    }

    const tmpPath = `${targetPath}.tmp`;
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }

      const res = await fetch(MODEL_SPEC.downloadUrl);
      if (!res.ok || !res.body) {
        throw new Error(`Failed to fetch model artifact (HTTP ${res.status}).`);
      }

      const fileStream = fs.createWriteStream(tmpPath);
      await finished(Readable.fromWeb(res.body).pipe(fileStream));

      if (!isValidGgufFile(tmpPath, MODEL_SPEC.minBytes)) {
        throw new Error('Downloaded model artifact failed GGUF integrity verification.');
      }

      fs.renameSync(tmpPath, targetPath);
      return {
        modelPath: targetPath,
        bytes: fs.statSync(targetPath).size,
        cached: false,
      };
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    } finally {
      pendingEnsurePromise = null;
    }
  })();

  return pendingEnsurePromise;
}
