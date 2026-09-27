import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";

// Streams the same bytes through each hasher in small reused chunks, the way
// file verification does, and reports hex digests for the host to check.
export function probeHashing({ algorithms, hmacAlgorithms, key, length }) {
  const input = new Uint8Array(length);
  for (let index = 0; index < length; index++) input[index] = (index * 31 + 7) & 0xff;
  const chunk = new Uint8Array(4099);
  const stream = (hasher) => {
    for (let offset = 0; offset < length; offset += chunk.length) {
      const bytes = input.subarray(offset, offset + chunk.length);
      chunk.set(bytes);
      hasher.update(chunk.subarray(0, bytes.length));
      chunk.fill(0xa5);
    }
    return hasher;
  };
  const keyBytes = new TextEncoder().encode(key);
  const result = { cryptoHasher: {}, cryptoHasherCopy: {}, hmac: {}, nodeHash: {}, nodeHmac: {}, unsupported: "" };
  for (const algorithm of algorithms) {
    const hasher = stream(new Bun.CryptoHasher(algorithm));
    result.cryptoHasherCopy[algorithm] = hasher.copy().digest("hex");
    result.cryptoHasher[algorithm] = hasher.digest("hex");
    result.nodeHash[algorithm] = stream(createHash(algorithm)).digest("hex");
  }
  for (const algorithm of hmacAlgorithms) {
    result.hmac[algorithm] = stream(new Bun.CryptoHasher(algorithm, keyBytes)).digest("hex");
    result.nodeHmac[algorithm] = stream(createHmac(algorithm, keyBytes)).digest("hex");
  }
  try { new Bun.CryptoHasher("not-a-digest"); } catch (error) { result.unsupported = String(error.message); }
  return result;
}

if (import.meta.main) {
  const config = JSON.parse(process.argv[2]);
  const main = probeHashing(config);
  const worker = new Worker(fileURLToPath(new URL("./hashing-worker.mjs", import.meta.url)), { type: "module" });
  try {
    const threaded = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Hashing worker probe timed out")), 30000);
      worker.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage(config);
    });
    console.log(JSON.stringify({ main, worker: threaded }));
  } finally {
    worker.terminate();
  }
}
