import { readFileSync } from "../node/fs.js";

// Mirrors Bun's per-file default_concurrent decision before test collection.
let configuredPatterns;
const fileMatches = new Map();

function concurrentTestPatterns() {
  if (configuredPatterns !== undefined) return configuredPatterns;
  configuredPatterns = [];
  try {
    const cwd = String(globalThis.process?.cwd?.() ?? ".");
    const source = readFileSync(`${cwd}/bunfig.toml`, "utf8");
    const config = globalThis.Bun?.TOML?.parse?.(source);
    const value = config?.test?.concurrentTestGlob;
    if (typeof value === "string" && value.length > 0) configuredPatterns = [value];
    else if (Array.isArray(value)) {
      configuredPatterns = value.filter((pattern) => typeof pattern === "string" && pattern.length > 0);
    }
  } catch {}
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
