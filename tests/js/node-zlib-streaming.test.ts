import { Readable } from "node:stream";
import {
  createBrotliCompress,
  createInflate,
  createZstdCompress,
  deflateSync,
  zstdDecompressSync,
} from "node:zlib";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const compressed = deflateSync("0123456789".repeat(4));
const trailing = Buffer.from("not valid compressed data");
for (const write of [
  stream => {
    stream.write(compressed);
    stream.write(trailing);
  },
  stream => {
    stream.write(Buffer.concat([compressed, trailing]));
  },
]) {
  const stream = createInflate();
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => {
    output += chunk;
  });
  const ended = new Promise<void>((resolve, reject) => {
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  write(stream);
  await ended;
  assert(output === "0123456789".repeat(4), "inflate should finish at the compressed stream boundary");
  assert(stream.bytesWritten === compressed.length, "inflate bytesWritten should exclude trailing data");
}

let state = 1;
const randomInput = Buffer.alloc(8 * 1024 * 1024);
for (let index = 0; index < randomInput.length; index += 1) {
  state = (Math.imul(state, 1103515245) + 12345) | 0;
  randomInput[index] = state >>> 24;
}

for (const [name, create] of [
  ["brotli", createBrotliCompress],
  ["zstd", createZstdCompress],
] as const) {
  const input = new Readable();
  const compressor = create();
  const chunks: Uint8Array[] = [];
  compressor.on("data", chunk => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    compressor.on("end", resolve);
    compressor.on("error", reject);
  });
  for (let offset = 0; offset < randomInput.length; offset += 1024 * 1024) {
    input.push(randomInput.subarray(offset, offset + 1024 * 1024));
  }
  input.push(null);
  input.pipe(compressor);
  await ended;
  assert(chunks.length >= 7, `${name} should emit multiple output chunks, received ${chunks.length}`);
  if (name === "zstd") {
    const roundtrip = zstdDecompressSync(Buffer.concat(chunks));
    assert(Buffer.compare(roundtrip, randomInput) === 0, "concatenated zstd frames should round trip");
  }
}

console.log("node zlib streaming passed");
