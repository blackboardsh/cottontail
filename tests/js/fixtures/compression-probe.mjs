import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync, deflateSync, inflateSync, brotliCompressSync, brotliDecompressSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { equal, probeHTTPCompression } from "./compression-http-probe.mjs";

async function probeCompression(config) {
  const { content } = config;
  const knownZstd = Buffer.from('KLUv/SAmMQEAaGVsbG8gY290dG9udGFpbCB6c3RkIHJlZ3Jlc3Npb24gcHJvYmU=', 'base64');
  equal(zstdDecompressSync(knownZstd).toString(), 'hello cottontail zstd regression probe');
  const codecs = { gzip: [gzipSync, gunzipSync], deflate: [deflateSync, inflateSync], br: [brotliCompressSync, brotliDecompressSync], zstd: [zstdCompressSync, zstdDecompressSync] };
  for (const [compress, decompress] of Object.values(codecs)) {
    equal(decompress(compress(Buffer.from(content))).toString(), content);
  }
  return probeHTTPCompression(config);
}

if (import.meta.main) {
  const config = JSON.parse(process.argv[2]);
  const main = await probeCompression(config);
  const worker = new Worker(fileURLToPath(new URL('./compression-worker.mjs', import.meta.url)), { type: 'module' });
  try {
    const threaded = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Compression worker probe timed out')), 30000);
      worker.onmessage = event => { clearTimeout(timeout); resolve(event.data); };
      worker.onerror = event => { clearTimeout(timeout); reject(new Error(event.message)); };
      worker.postMessage(config);
    });
    console.log(JSON.stringify({ main, worker: threaded }));
  } finally {
    worker.terminate();
  }
}
