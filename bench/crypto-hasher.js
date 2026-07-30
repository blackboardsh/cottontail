// Focused ReleaseFast benchmark for Bun.CryptoHasher and the Bun SHA classes.
//
// Usage:
//   ./zig-out/bin/cottontail bench/crypto-hasher.js small-cryptohasher
//   ./zig-out/bin/cottontail bench/crypto-hasher.js small-sha256 --samples 7
//   CRYPTO_HASHER_BENCH_SAMPLES=7 ./zig-out/bin/cottontail \
//     bench/crypto-hasher.js large-stream
//
// Run memory-reuse and memory-fresh in separate processes. Their JSON includes
// sampled RSS, while an external process monitor can provide the OS peak RSS.

const KIB = 1_024;
const MIB = 1_024 * KIB;
const SMALL_CHUNK_BYTES = 64;
const SMALL_UPDATE_COUNT = 1_048_576;
const LARGE_CHUNK_BYTES = MIB;
const LARGE_UPDATE_COUNT = 512;
const STATIC_HASH_COUNT = 512;
const RSS_SAMPLE_INTERVAL = 4_096;

const EXPECTED = Object.freeze({
  smallSha256: "197db6e1396ba4f1cb23b29e3ab936ebe7a5ccb66c6597f8d3a93e78cd324bef",
  smallHmacSha256: "a7f63a96cc02ec591496816f0bc29152befcc95865195edc767772dc04f92f46",
  largeSha256: "46286a2917deab7807fc9e8986f7c80eec7d34a4b0e3c5a7cf22a26dae3aeb2c",
  oneShotSha256: "7aa0bcdf50b7d0fdf8ce0661d38d4b8e9916bf29c5d0ed5515891937d0df3656",
});

const TIMED_MODES = Object.freeze([
  "small-cryptohasher",
  "small-sha256",
  "small-hmac",
  "large-stream",
  "static-one-shot",
]);

const MODE_ALIASES = Object.freeze({
  "crypto-small": "small-cryptohasher",
  "cryptohasher-small": "small-cryptohasher",
  "small-crypto": "small-cryptohasher",
  sha256: "small-sha256",
  "sha256-small": "small-sha256",
  hmac: "small-hmac",
  "hmac-small": "small-hmac",
  "hmac-sha256": "small-hmac",
  large: "large-stream",
  "stream-large": "large-stream",
  oneshot: "static-one-shot",
  "one-shot": "static-one-shot",
  static: "static-one-shot",
  "rss-reuse": "memory-reuse",
  "rss-fresh": "memory-fresh",
});

function makePattern(length, seed) {
  const output = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = state >>> 24;
  }
  return output;
}

const SMALL_CHUNK = makePattern(SMALL_CHUNK_BYTES, 0xc07701);
const LARGE_CHUNK = makePattern(LARGE_CHUNK_BYTES, 0xc07702);
const HMAC_KEY = makePattern(32, 0xc07703);

function nowNs() {
  if (typeof globalThis.cottontail?.nanotime === "function") {
    return BigInt(globalThis.cottontail.nanotime());
  }
  if (typeof globalThis.process?.hrtime?.bigint === "function") {
    return globalThis.process.hrtime.bigint();
  }
  if (typeof globalThis.Bun?.nanoseconds === "function") {
    return BigInt(Math.floor(globalThis.Bun.nanoseconds()));
  }
  return BigInt(Date.now()) * 1_000_000n;
}

function forceFullGC() {
  try {
    if (typeof globalThis.Bun?.gc === "function") {
      globalThis.Bun.gc(true);
      return true;
    }
    if (typeof globalThis.cottontail?.gc === "function") {
      globalThis.cottontail.gc(true);
      return true;
    }
    if (typeof globalThis.gc === "function") {
      globalThis.gc();
      return true;
    }
  } catch {
    // RSS is still useful if an individual runtime does not expose explicit GC.
  }
  return false;
}

function currentRssBytes() {
  try {
    if (typeof globalThis.process?.memoryUsage?.rss === "function") {
      const rss = Number(globalThis.process.memoryUsage.rss());
      if (Number.isFinite(rss) && rss >= 0) return rss;
    }
    if (typeof globalThis.process?.memoryUsage === "function") {
      const rss = Number(globalThis.process.memoryUsage().rss);
      if (Number.isFinite(rss) && rss >= 0) return rss;
    }
    if (typeof globalThis.cottontail?.processInfo === "function") {
      const rss = Number(globalThis.cottontail.processInfo("memoryUsage")?.rss);
      if (Number.isFinite(rss) && rss >= 0) return rss;
    }
  } catch {
    // An unavailable RSS reading is represented by null in the JSON result.
  }
  return null;
}

function maxNullable(left, right) {
  if (left == null) return right;
  if (right == null) return left;
  return Math.max(left, right);
}

function subtractNullable(left, right) {
  return left == null || right == null ? null : left - right;
}

function toHex(value) {
  if (typeof value === "string") return value;
  let bytes;
  if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value);
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  } else {
    throw new TypeError(`Expected a digest byte array, received ${typeof value}`);
  }
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    output += bytes[index].toString(16).padStart(2, "0");
  }
  return output;
}

function verifyDigest(mode, actual, expected) {
  const actualHex = toHex(actual);
  if (actualHex !== expected) {
    throw new Error(`${mode} correctness failure: expected ${expected}, received ${actualHex}`);
  }
  return actualHex;
}

let checksum = 0;

function consumeDigest(hexDigest) {
  checksum = (checksum ^ hexDigest.charCodeAt(0) ^ hexDigest.charCodeAt(hexDigest.length - 1)) >>> 0;
}

function smallCryptoHasher() {
  const hasher = new Bun.CryptoHasher("sha256");
  for (let index = 0; index < SMALL_UPDATE_COUNT; index += 1) {
    hasher.update(SMALL_CHUNK);
  }
  return hasher.digest("hex");
}

function smallSha256() {
  const hasher = new Bun.SHA256();
  for (let index = 0; index < SMALL_UPDATE_COUNT; index += 1) {
    hasher.update(SMALL_CHUNK);
  }
  return hasher.digest("hex");
}

function smallHmac() {
  const hasher = new Bun.CryptoHasher("sha256", HMAC_KEY);
  for (let index = 0; index < SMALL_UPDATE_COUNT; index += 1) {
    hasher.update(SMALL_CHUNK);
  }
  return hasher.digest("hex");
}

function largeStream() {
  const hasher = new Bun.CryptoHasher("sha256");
  for (let index = 0; index < LARGE_UPDATE_COUNT; index += 1) {
    hasher.update(LARGE_CHUNK);
  }
  return hasher.digest("hex");
}

function staticOneShot() {
  let digest;
  let byteChecksum = 0;
  for (let index = 0; index < STATIC_HASH_COUNT; index += 1) {
    digest = Bun.SHA256.hash(LARGE_CHUNK);
    const bytes = digest instanceof ArrayBuffer
      ? new Uint8Array(digest)
      : new Uint8Array(digest.buffer, digest.byteOffset, digest.byteLength);
    byteChecksum ^= bytes[index % bytes.length];
  }
  checksum = (checksum ^ byteChecksum) >>> 0;
  return digest;
}

const DEFINITIONS = Object.freeze({
  "small-cryptohasher": {
    api: 'new Bun.CryptoHasher("sha256")',
    chunkBytes: SMALL_CHUNK_BYTES,
    operations: SMALL_UPDATE_COUNT,
    totalBytes: SMALL_CHUNK_BYTES * SMALL_UPDATE_COUNT,
    expected: EXPECTED.smallSha256,
    run: smallCryptoHasher,
  },
  "small-sha256": {
    api: "new Bun.SHA256()",
    chunkBytes: SMALL_CHUNK_BYTES,
    operations: SMALL_UPDATE_COUNT,
    totalBytes: SMALL_CHUNK_BYTES * SMALL_UPDATE_COUNT,
    expected: EXPECTED.smallSha256,
    run: smallSha256,
  },
  "small-hmac": {
    api: 'new Bun.CryptoHasher("sha256", key)',
    chunkBytes: SMALL_CHUNK_BYTES,
    operations: SMALL_UPDATE_COUNT,
    totalBytes: SMALL_CHUNK_BYTES * SMALL_UPDATE_COUNT,
    expected: EXPECTED.smallHmacSha256,
    run: smallHmac,
  },
  "large-stream": {
    api: 'new Bun.CryptoHasher("sha256")',
    chunkBytes: LARGE_CHUNK_BYTES,
    operations: LARGE_UPDATE_COUNT,
    totalBytes: LARGE_CHUNK_BYTES * LARGE_UPDATE_COUNT,
    expected: EXPECTED.largeSha256,
    run: largeStream,
  },
  "static-one-shot": {
    api: "Bun.SHA256.hash(data)",
    chunkBytes: LARGE_CHUNK_BYTES,
    operations: STATIC_HASH_COUNT,
    totalBytes: LARGE_CHUNK_BYTES * STATIC_HASH_COUNT,
    expected: EXPECTED.oneShotSha256,
    run: staticOneShot,
  },
});

function numericMedian(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function timingSummary(samplesNs, definition) {
  const medianNs = numericMedian(samplesNs);
  const elapsedSeconds = medianNs / 1_000_000_000;
  return {
    samplesNs,
    medianNs,
    minNs: Math.min(...samplesNs),
    maxNs: Math.max(...samplesNs),
    medianMs: medianNs / 1_000_000,
    medianUpdatesPerSecond: definition.operations / elapsedSeconds,
    medianMiBPerSecond: definition.totalBytes / MIB / elapsedSeconds,
  };
}

function runTimedMode(mode, samples, warmup) {
  const definition = DEFINITIONS[mode];
  for (let index = 0; index < warmup; index += 1) {
    const digest = verifyDigest(mode, definition.run(), definition.expected);
    consumeDigest(digest);
    forceFullGC();
  }

  const samplesNs = [];
  let actualHex = "";
  for (let index = 0; index < samples; index += 1) {
    forceFullGC();
    const startedAt = nowNs();
    const digest = definition.run();
    const elapsedNs = nowNs() - startedAt;
    actualHex = verifyDigest(mode, digest, definition.expected);
    consumeDigest(actualHex);
    samplesNs.push(Number(elapsedNs));
  }

  return {
    mode,
    api: definition.api,
    workload: {
      chunkBytes: definition.chunkBytes,
      operationsPerSample: definition.operations,
      bytesPerSample: definition.totalBytes,
    },
    samples,
    warmup,
    correctness: {
      expectedHex: definition.expected,
      actualHex,
      passed: true,
    },
    timing: timingSummary(samplesNs, definition),
  };
}

function runMemorySample(freshAllocation) {
  const gcAvailable = forceFullGC();
  const beforeRssBytes = currentRssBytes();
  let peakSampledRssBytes = beforeRssBytes;
  let hasher = new Bun.CryptoHasher("sha256");

  const startedAt = nowNs();
  for (let index = 0; index < SMALL_UPDATE_COUNT; index += 1) {
    hasher.update(freshAllocation ? new Uint8Array(SMALL_CHUNK) : SMALL_CHUNK);
    if ((index + 1) % RSS_SAMPLE_INTERVAL === 0) {
      peakSampledRssBytes = maxNullable(peakSampledRssBytes, currentRssBytes());
    }
  }
  const afterUpdatesRssBytes = currentRssBytes();
  peakSampledRssBytes = maxNullable(peakSampledRssBytes, afterUpdatesRssBytes);

  const digest = hasher.digest("hex");
  const elapsedNs = Number(nowNs() - startedAt);
  const actualHex = verifyDigest(
    freshAllocation ? "memory-fresh" : "memory-reuse",
    digest,
    EXPECTED.smallSha256,
  );
  consumeDigest(actualHex);

  const afterDigestRssBytes = currentRssBytes();
  peakSampledRssBytes = maxNullable(peakSampledRssBytes, afterDigestRssBytes);
  hasher = null;
  forceFullGC();
  const afterGcRssBytes = currentRssBytes();

  return {
    elapsedNs,
    beforeRssBytes,
    afterUpdatesRssBytes,
    afterDigestRssBytes,
    afterGcRssBytes,
    peakSampledRssBytes,
    peakDeltaBytes: subtractNullable(peakSampledRssBytes, beforeRssBytes),
    retainedAfterGcBytes: subtractNullable(afterGcRssBytes, beforeRssBytes),
    gcAvailable,
  };
}

function runMemoryMode(mode, samples) {
  const freshAllocation = mode === "memory-fresh";
  const observations = [];
  for (let index = 0; index < samples; index += 1) {
    observations.push(runMemorySample(freshAllocation));
  }

  const elapsedSamplesNs = observations.map(observation => observation.elapsedNs);
  const peakDeltas = observations
    .map(observation => observation.peakDeltaBytes)
    .filter(value => value != null);
  const retainedDeltas = observations
    .map(observation => observation.retainedAfterGcBytes)
    .filter(value => value != null);

  return {
    mode,
    api: 'new Bun.CryptoHasher("sha256")',
    allocation: freshAllocation ? "new 64-byte Uint8Array per update" : "one reused 64-byte Uint8Array",
    workload: {
      chunkBytes: SMALL_CHUNK_BYTES,
      operationsPerSample: SMALL_UPDATE_COUNT,
      bytesPerSample: SMALL_CHUNK_BYTES * SMALL_UPDATE_COUNT,
    },
    samples,
    correctness: {
      expectedHex: EXPECTED.smallSha256,
      passed: true,
    },
    timing: timingSummary(elapsedSamplesNs, DEFINITIONS["small-cryptohasher"]),
    rss: {
      source: "process.memoryUsage().rss",
      samplingEveryUpdates: RSS_SAMPLE_INTERVAL,
      observations,
      medianPeakDeltaBytes: peakDeltas.length > 0 ? numericMedian(peakDeltas) : null,
      medianRetainedAfterGcBytes: retainedDeltas.length > 0 ? numericMedian(retainedDeltas) : null,
    },
  };
}

function parseInteger(value, name, minimum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
}

function usage() {
  return [
    "Usage: cottontail bench/crypto-hasher.js [mode] [--samples N] [--warmup N] [--pretty]",
    "",
    `Modes: ${[...TIMED_MODES, "memory-reuse", "memory-fresh", "all"].join(", ")}`,
    "Default mode: all (timing modes only; run each RSS mode in a fresh process)",
    "",
    "Environment:",
    "  CRYPTO_HASHER_BENCH_MODE",
    "  CRYPTO_HASHER_BENCH_SAMPLES (or BENCH_SAMPLES)",
    "  CRYPTO_HASHER_BENCH_WARMUP",
  ].join("\n");
}

function parseArguments() {
  const args = Array.from(globalThis.process?.argv ?? []).slice(2);
  let mode = globalThis.process?.env?.CRYPTO_HASHER_BENCH_MODE;
  let samplesValue =
    globalThis.process?.env?.CRYPTO_HASHER_BENCH_SAMPLES ??
    globalThis.process?.env?.BENCH_SAMPLES ??
    "5";
  let warmupValue = globalThis.process?.env?.CRYPTO_HASHER_BENCH_WARMUP ?? "1";
  let pretty = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      globalThis.process.exit(0);
    } else if (argument === "--pretty") {
      pretty = true;
    } else if (argument === "--mode") {
      if (++index >= args.length) throw new TypeError("--mode requires a value");
      mode = String(args[index]);
    } else if (argument.startsWith("--mode=")) {
      mode = argument.slice("--mode=".length);
    } else if (argument === "--samples") {
      if (++index >= args.length) throw new TypeError("--samples requires a value");
      samplesValue = args[index];
    } else if (argument.startsWith("--samples=")) {
      samplesValue = argument.slice("--samples=".length);
    } else if (argument === "--warmup") {
      if (++index >= args.length) throw new TypeError("--warmup requires a value");
      warmupValue = args[index];
    } else if (argument.startsWith("--warmup=")) {
      warmupValue = argument.slice("--warmup=".length);
    } else if (argument.startsWith("-")) {
      throw new TypeError(`Unknown option: ${argument}`);
    } else if (mode == null) {
      mode = argument;
    } else {
      throw new TypeError(`Unexpected argument: ${argument}`);
    }
  }

  mode = String(mode ?? "all").toLowerCase();
  mode = MODE_ALIASES[mode] ?? mode;
  if (![...TIMED_MODES, "memory-reuse", "memory-fresh", "all"].includes(mode)) {
    throw new TypeError(`Unknown mode: ${mode}\n${usage()}`);
  }

  return {
    mode,
    samples: parseInteger(samplesValue, "samples", 1),
    warmup: parseInteger(warmupValue, "warmup", 0),
    pretty,
  };
}

const options = parseArguments();
const selectedModes = options.mode === "all" ? TIMED_MODES : [options.mode];
const results = selectedModes.map(mode =>
  mode === "memory-reuse" || mode === "memory-fresh"
    ? runMemoryMode(mode, options.samples)
    : runTimedMode(mode, options.samples, options.warmup),
);

const report = {
  benchmark: "bun-crypto-hasher",
  formatVersion: 1,
  runtime: {
    execPath: globalThis.process?.execPath ?? null,
    bunVersion: globalThis.Bun?.version ?? globalThis.process?.versions?.bun ?? null,
    cottontailVersion: globalThis.process?.versions?.cottontail ?? null,
    platform: globalThis.process?.platform ?? null,
    arch: globalThis.process?.arch ?? null,
  },
  requestedMode: options.mode,
  results,
  checksum,
};

console.log(JSON.stringify(report, null, options.pretty ? 2 : 0));
