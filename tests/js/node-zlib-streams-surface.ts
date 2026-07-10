import {
  BrotliCompress,
  BrotliDecompress,
  Deflate,
  DeflateRaw,
  Gunzip,
  Gzip,
  Inflate,
  InflateRaw,
  Unzip,
  ZstdCompress,
  ZstdDecompress,
  crc32,
  brotliCompress,
  brotliCompressSync,
  brotliDecompressSync,
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createDeflateRaw,
  createGunzip,
  createGzip,
  createInflate,
  createInflateRaw,
  createUnzip,
  createZstdCompress,
  createZstdDecompress,
  deflateRawSync,
  deflateSync,
  gzipSync,
  gunzipSync,
  inflateSync,
  zstdCompress,
  zstdCompressSync,
  zstdDecompressSync,
} from "node:zlib";
import { createRequire } from "node:module";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function collectStream(stream, input): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => chunks.push(chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk))));
    stream.on("error", reject);
    stream.on("end", () => {
      const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const out = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(out);
    });
    stream.end(input);
  });
}

const require = createRequire(import.meta.url);
assert(require("node:zlib").createGzip === createGzip, "require node:zlib createGzip mismatch");
assert(require("node:zlib").createBrotliCompress === createBrotliCompress, "require node:zlib createBrotliCompress mismatch");

assert(createDeflate() instanceof Deflate, "createDeflate class mismatch");
assert(createDeflateRaw() instanceof DeflateRaw, "createDeflateRaw class mismatch");
assert(createGzip() instanceof Gzip, "createGzip class mismatch");
assert(createGunzip() instanceof Gunzip, "createGunzip class mismatch");
assert(createInflate() instanceof Inflate, "createInflate class mismatch");
assert(createInflateRaw() instanceof InflateRaw, "createInflateRaw class mismatch");
assert(createUnzip() instanceof Unzip, "createUnzip class mismatch");
assert(createBrotliCompress() instanceof BrotliCompress, "createBrotliCompress class mismatch");
assert(createBrotliDecompress() instanceof BrotliDecompress, "createBrotliDecompress class mismatch");
assert(createZstdCompress() instanceof ZstdCompress, "createZstdCompress class mismatch");
assert(createZstdDecompress() instanceof ZstdDecompress, "createZstdDecompress class mismatch");

const gzipCompressed = await collectStream(createGzip(), "hello zlib streams");
const gzipRoundTrip = await collectStream(createGunzip(), gzipCompressed);
assert(new TextDecoder().decode(gzipRoundTrip) === "hello zlib streams", "gzip/gunzip stream round trip mismatch");

const flushedGzipChunks: Uint8Array[] = [];
const flushedGzip = createGzip();
flushedGzip.on("data", (chunk) => flushedGzipChunks.push(chunk));
flushedGzip.write("flush-");
await new Promise<void>((resolve, reject) => {
  flushedGzip.flush((error) => error ? reject(error) : resolve());
});
assert(flushedGzipChunks.length > 0, "gzip flush should emit buffered output");
const flushedBeforeEnd = flushedGzipChunks.length;
assert(new TextDecoder().decode(gunzipSync(Buffer.concat(flushedGzipChunks))) === "flush-", "gzip flushed chunk round trip mismatch");
await new Promise<void>((resolve, reject) => {
  flushedGzip.once("error", reject);
  flushedGzip.once("end", () => resolve());
  flushedGzip.end("end");
});
assert(flushedGzipChunks.length > flushedBeforeEnd, "gzip end should emit remaining output after flush");
assert(new TextDecoder().decode(gunzipSync(Buffer.concat(flushedGzipChunks.slice(flushedBeforeEnd)))) === "end", "gzip post-flush end round trip mismatch");

const deflated = await collectStream(createDeflate(), "deflate stream");
const inflated = await collectStream(createInflate(), deflated);
assert(new TextDecoder().decode(inflated) === "deflate stream", "deflate/inflate stream round trip mismatch");

const rawDeflated = await collectStream(createDeflateRaw(), "raw stream");
const rawInflated = await collectStream(createInflateRaw(), rawDeflated);
assert(new TextDecoder().decode(rawInflated) === "raw stream", "deflateRaw/inflateRaw stream round trip mismatch");

const unzipped = await collectStream(createUnzip(), gzipSync("unzip stream"));
assert(new TextDecoder().decode(unzipped) === "unzip stream", "unzip stream mismatch");

const brotliCompressed = await collectStream(createBrotliCompress(), "brotli streams");
const brotliRoundTrip = await collectStream(createBrotliDecompress(), brotliCompressed);
assert(new TextDecoder().decode(brotliRoundTrip) === "brotli streams", "brotli stream round trip mismatch");

assert(deflateSync("sync").byteLength > 0, "deflateSync baseline mismatch");
assert(deflateRawSync("sync").byteLength > 0, "deflateRawSync baseline mismatch");
const dictionary = new TextEncoder().encode("common-prefix-");
const dictionaryCompressed = deflateSync("common-prefix-value", { dictionary, level: 9, windowBits: 15, memLevel: 8, strategy: 0 });
assert(new TextDecoder().decode(inflateSync(dictionaryCompressed, { dictionary })) === "common-prefix-value", "zlib dictionary round trip mismatch");
let missingDictionaryFailed = false;
try {
  inflateSync(dictionaryCompressed);
} catch {
  missingDictionaryFailed = true;
}
assert(missingDictionaryFailed, "inflateSync should require the dictionary");
assert(new TextDecoder().decode(brotliDecompressSync(brotliCompressSync("brotli sync"))) === "brotli sync", "brotli sync round trip mismatch");
assert(crc32("hello") === 907060870, "crc32 mismatch");

await new Promise<void>((resolve, reject) => {
  brotliCompress("brotli callback", (error, compressed) => {
    if (error) {
      reject(error);
      return;
    }
    try {
      assert(new TextDecoder().decode(brotliDecompressSync(compressed)) === "brotli callback", "brotli callback round trip mismatch");
      resolve();
    } catch (roundtripError) {
      reject(roundtripError);
    }
  });
});

try {
  assert(new TextDecoder().decode(zstdDecompressSync(zstdCompressSync("zstd sync"))) === "zstd sync", "zstd sync round trip mismatch");

  const zstdCompressed = await collectStream(createZstdCompress(), "zstd streams");
  const zstdRoundTrip = await collectStream(createZstdDecompress(), zstdCompressed);
  assert(new TextDecoder().decode(zstdRoundTrip) === "zstd streams", "zstd stream round trip mismatch");

  await new Promise<void>((resolve, reject) => {
    zstdCompress("zstd callback", (error, compressed) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        assert(new TextDecoder().decode(zstdDecompressSync(compressed)) === "zstd callback", "zstd callback round trip mismatch");
        resolve();
      } catch (roundtripError) {
        reject(roundtripError);
      }
    });
  });
} catch (error) {
  assert(String((error as Error).message).includes("native Zstd support is unavailable"), "unexpected zstd failure");
}

console.log("node zlib streams surface passed");
