/**
 * Node-llama-cpp Runtime Initializer
 * Uses prebuilt platform binaries directly without source compilation.
 * Falls back cleanly to direct prebuilt Llama._create() if child_process.fork
 * preflight fails in restricted sandboxed kernels (e.g. gVisor).
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { LlamaLogLevel, getLlama } from 'node-llama-cpp';

const require = createRequire(import.meta.url);

function resolvePrebuiltAddonDirs() {
  const platformKey = `${process.platform}-${process.arch}`;
  const candidates = [
    path.resolve('node_modules', '@node-llama-cpp', platformKey, 'bins', platformKey),
  ];
  return candidates.filter((dir) =>
    fs.existsSync(path.join(dir, 'llama-addon.node'))
  );
}

export async function initializeLlamaRuntime({ maxThreads } = {}) {
  try {
    return await getLlama({
      build: 'never',
      gpu: false,
      logLevel: LlamaLogLevel.warn,
      maxThreads,
    });
  } catch (err) {
    // Fallback for sandboxed environments where testBindingBinary child_process.fork IPC is blocked
    const binDirs = resolvePrebuiltAddonDirs();
    for (const binDir of binDirs) {
      const bindingPath = path.join(binDir, 'llama-addon.node');
      const metadataPath = path.join(binDir, '_nlcBuildMetadata.json');
      try {
        const { Llama } = await import(
          '../node_modules/node-llama-cpp/dist/bindings/Llama.js'
        );
        const bindings = require(bindingPath);
        const buildMetadata = fs.existsSync(metadataPath)
          ? JSON.parse(fs.readFileSync(metadataPath, 'utf8'))
          : { buildOptions: { gpu: false, platform: process.platform, arch: process.arch } };

        return await Llama._create({
          bindings,
          bindingPath,
          extBackendsPath: binDir,
          buildType: 'prebuilt',
          buildMetadata,
          logLevel: LlamaLogLevel.warn,
          maxThreads,
        });
      } catch {
        // Try next candidate
      }
    }
    throw err;
  }
}
