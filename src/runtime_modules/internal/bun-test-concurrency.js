import { bunTestRuntimeOptions } from "./bun-test-config.js";

// Mirrors Bun's per-file default_concurrent decision before test collection.
let configuredPatterns;
const fileMatches = new Map();

function concurrentTestPatterns() {
  if (configuredPatterns !== undefined) return configuredPatterns;
  configuredPatterns = bunTestRuntimeOptions().concurrentTestGlob;
  return configuredPatterns;
}

function currentTestFile() {
  return String(
    globalThis.__cottontailRegisteringTestFile ??
    globalThis.__filename ??
    globalThis.process?.argv?.[1] ??
    "",
  ).replaceAll("\\", "/");
}

export function bunTestFileRunsConcurrently() {
  const file = currentTestFile();
  if (!file) return false;
  const cached = fileMatches.get(file);
  if (cached !== undefined) return cached;

  const matches = concurrentTestPatterns().some((pattern) => {
    try {
      return new globalThis.Bun.Glob(pattern).match(file);
    } catch {
      return false;
    }
  });
  fileMatches.set(file, matches);
  return matches;
}

export function applyBunFileConcurrency(options) {
  if (options.concurrent || options.serial || !bunTestFileRunsConcurrently()) return options;
  return { ...options, concurrent: true };
}
