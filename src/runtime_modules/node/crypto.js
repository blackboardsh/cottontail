export function randomBytes(size) {
  const length = Number(size) || 0;
  if (length < 0 || !Number.isFinite(length)) {
    throw new RangeError("randomBytes size must be a non-negative finite number");
  }
  if (typeof cottontail.randomBytes !== "function") {
    throw new Error("native randomBytes is unavailable");
  }
  return globalThis.Buffer?.from
    ? globalThis.Buffer.from(cottontail.randomBytes(length))
    : new Uint8Array(cottontail.randomBytes(length));
}

export function randomUUID() {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

function shellEscape(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function bytesFromData(data) {
  if (data == null) return new Uint8Array(0);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function tmpRoot(kind) {
  const explicit = cottontail.env("COTTONTAIL_TMP_DIR");
  const base = explicit || cottontail.env("TMPDIR") || cottontail.env("TEMP") || cottontail.env("TMP") || "/tmp";
  return pathJoin(base, "cottontail", kind);
}

function runSha256(bytes) {
  const tmpDir = tmpRoot("hash");
  cottontail.mkdirSync(tmpDir, true);
  const tmpPath = `${tmpDir}/${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  cottontail.writeFile(tmpPath, bytes);
  try {
    const result = cottontail.spawnSync("sh", ["-c", `shasum -a 256 ${shellEscape(tmpPath)} | awk '{print $1}'`], { stdio: "pipe" });
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || "sha256 failed");
    return result.stdout.trim();
  } finally {
    cottontail.rmSync(tmpPath, false, true);
  }
}

export function createHash(algorithm) {
  const normalized = String(algorithm).toLowerCase().replace(/-/g, "");
  if (normalized !== "sha256") {
    throw new Error(`createHash only supports sha256 in Cottontail right now: ${algorithm}`);
  }
  const chunks = [];
  return {
    update(data) {
      chunks.push(bytesFromData(data));
      return this;
    },
    digest(encoding = undefined) {
      const hex = runSha256(concatBytes(chunks));
      if (encoding == null || encoding === "hex") return hex;
      if (encoding === "base64" && globalThis.Buffer?.from) {
        return globalThis.Buffer.from(hex, "hex").toString("base64");
      }
      if (encoding === "buffer" && globalThis.Buffer?.from) {
        return globalThis.Buffer.from(hex, "hex");
      }
      return hex;
    },
  };
}

export default { createHash, randomBytes, randomUUID };
