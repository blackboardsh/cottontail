const minimumCacheSize = 50 * 1024;
const cacheVersion = 1;

function cacheDirectory() {
  const env = globalThis.process?.env ?? cottontail.env?.() ?? {};
  const value = env.BUN_RUNTIME_TRANSPILER_CACHE_PATH;
  if (value == null || value === "" || value === "0") return null;
  return String(value);
}

function cachePath(directory, digest) {
  const separator = directory.endsWith("/") || directory.endsWith("\\")
    ? ""
    : globalThis.process?.platform === "win32" ? "\\" : "/";
  return `${directory}${separator}${digest}.pile`;
}

function hex(bytes) {
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function sourceDigest(bytes) {
  if (typeof cottontail.cryptoHashSync !== "function") return null;
  try {
    return hex(new Uint8Array(cottontail.cryptoHashSync("sha256", bytes)));
  } catch {
    return null;
  }
}

export function openRuntimeTranspilerCache(source, features) {
  const directory = cacheDirectory();
  if (directory == null) return null;

  let bytes;
  try {
    bytes = new TextEncoder().encode(String(source));
  } catch {
    return null;
  }
  if (bytes.byteLength < minimumCacheSize) return null;

  const digest = sourceDigest(bytes);
  if (digest == null) return null;
  const path = cachePath(directory, digest);
  const featureKey = String(features);

  try {
    const entry = JSON.parse(String(cottontail.readFile(path)));
    if (
      entry?.version === cacheVersion &&
      entry?.features === featureKey &&
      entry?.sourceLength === bytes.byteLength &&
      typeof entry?.output === "string"
    ) {
      return { hit: true, output: entry.output, store() {} };
    }
  } catch {}

  return {
    hit: false,
    output: undefined,
    store(output) {
      const temporaryPath = `${path}.${globalThis.process?.pid ?? 0}.${Date.now()}.tmp`;
      try {
        cottontail.mkdirSync(directory, true);
        cottontail.writeFile(temporaryPath, JSON.stringify({
          version: cacheVersion,
          features: featureKey,
          sourceLength: bytes.byteLength,
          output: String(output),
        }));
        cottontail.renameSync(temporaryPath, path);
      } catch {} finally {
        try {
          cottontail.unlinkSync(temporaryPath);
        } catch {}
      }
    },
  };
}
