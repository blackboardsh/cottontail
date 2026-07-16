import * as zlib from "node:zlib";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

for (const [name, parentName] of [
  ["Deflate", "Zlib"],
  ["DeflateRaw", "Zlib"],
  ["Gzip", "Zlib"],
  ["Gunzip", "Zlib"],
  ["Inflate", "Zlib"],
  ["InflateRaw", "Zlib"],
  ["Unzip", "Zlib"],
  ["BrotliCompress", "Brotli"],
  ["BrotliDecompress", "Brotli"],
] as const) {
  const Constructor = zlib[name];
  assert(Constructor.name === name, `${name} function name mismatch`);
  assert(Constructor.prototype.constructor === Constructor, `${name} prototype constructor mismatch`);
  assert(Constructor.prototype instanceof Object.getPrototypeOf(Constructor), `${name} prototype hierarchy mismatch`);
  assert(Object.getPrototypeOf(Constructor.prototype).constructor.name === parentName, `${name} parent name mismatch`);
  assert(Constructor() instanceof Constructor, `${name} should be callable without new`);
  assert(new Constructor() instanceof Constructor, `${name} should be constructable`);
}

for (const Constructor of [zlib.Deflate, zlib.DeflateRaw, zlib.Gzip]) {
  for (const option of ["chunkSize", "level", "windowBits", "memLevel", "strategy", "maxOutputLength"] as const) {
    for (const value of ["test", Symbol("cottontail"), 2n, {}, true]) {
      let threw = false;
      try {
        new Constructor({ [option]: value });
      } catch (error) {
        threw = error instanceof TypeError;
      }
      assert(threw, `${Constructor.name} ${option} should reject ${typeof value}`);
    }
    for (const value of [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, -2]) {
      let threw = false;
      try {
        new Constructor({ [option]: value });
      } catch (error) {
        threw = error instanceof RangeError;
      }
      assert(threw, `${Constructor.name} ${option} should reject ${value}`);
    }
    new Constructor({ [option]: undefined });
  }
}

const input = Buffer.alloc(2 * 1024 * 1024);
for (let index = 0; index < input.length; index += 1) input[index] = index & 0xff;

for (const [name, create] of [
  ["brotli", zlib.createBrotliCompress],
  ["zstd", zlib.createZstdCompress],
] as const) {
  const compressor = create();
  const chunks: Uint8Array[] = [];
  compressor.on("data", chunk => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    compressor.on("end", resolve);
    compressor.on("error", reject);
  });
  compressor.end(input);
  await ended;
  assert(chunks.length > 0, `${name} stream produced no output`);
}

console.log("node zlib compatibility passed");
