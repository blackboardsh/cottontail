import { Buffer } from "node:buffer";

const targetSampleNs = 40_000_000n;
const sampleCount = 7;
let checksum = 0;
const nanotime = globalThis.cottontail?.nanotime ?? process.hrtime.bigint;

function elapsed(iterations, operation) {
  const start = nanotime();
  for (let index = 0; index < iterations; index += 1) {
    checksum ^= Number(operation(index)) | 0;
  }
  return nanotime() - start;
}

function benchmark(name, operation) {
  for (let index = 0; index < 2_000; index += 1) operation(index);

  let iterations = 1;
  while (elapsed(iterations, operation) < targetSampleNs && iterations < 16_777_216) {
    iterations *= 2;
  }

  const samples = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const duration = elapsed(iterations, operation);
    samples.push(Number(duration) / iterations);
  }
  samples.sort((left, right) => left - right);
  const medianNs = samples[Math.floor(samples.length / 2)];
  console.log(`${name}: ${medianNs.toFixed(1)} ns/op (${iterations} iterations)`);
}

function makeBytes(length, seed) {
  const output = Buffer.allocUnsafe(length);
  let value = seed >>> 0;
  for (let index = 0; index < output.length; index += 1) {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    output[index] = value >>> 24;
  }
  return output;
}

for (const length of [32, 64, 128, 256, 512, 1_024, 2_048, 4_096, 65_536]) {
  const left = makeBytes(length, 1);
  const equal = Buffer.from(left);
  const different = Buffer.from(left);
  different[length - 1] ^= 0xff;

  benchmark(`compare/equal/${length}`, () => Buffer.compare(left, equal));
  benchmark(`compare/mismatch-tail/${length}`, () => Buffer.compare(left, different));
  benchmark(`equals/${length}`, () => left.equals(equal));
}

for (const length of [32, 64, 128, 256, 4_096, 65_536]) {
  const haystack = makeBytes(length, 7);
  const needle = Buffer.from("cottontail-buffer-needle");
  needle.copy(haystack, length - needle.length - 3);

  benchmark(`indexOf/${length}`, () => haystack.indexOf(needle));
  benchmark(`lastIndexOf/${length}`, () => haystack.lastIndexOf(needle));
  benchmark(`includes/${length}`, () => haystack.includes(needle));
}

for (const length of [32, 64, 128, 256, 4_096, 65_536]) {
  const haystack = makeBytes(length, 9);
  const needle = Buffer.from("cottontail", "utf16le");
  const insertion = Math.floor((length - needle.length - 2) / 2) * 2;
  needle.copy(haystack, insertion);

  benchmark(`indexOf-utf16/${length}`, () => haystack.indexOf(needle, 0, "utf16le"));
  benchmark(`lastIndexOf-utf16/${length}`, () => haystack.lastIndexOf(needle, length, "utf16le"));
}

for (const length of [16, 32, 64, 128, 256, 4_096, 65_536]) {
  const target = Buffer.allocUnsafe(length);
  const pattern = Buffer.from("cottontail");
  benchmark(`fill-pattern/${length}`, () => {
    target.fill(pattern);
    return target[length - 1];
  });
}

for (const length of [256, 4_096, 65_536]) {
  const source = makeBytes(length, 11);
  const target = Buffer.allocUnsafe(length);
  benchmark(`copy/${length}`, () => source.copy(target));
}

const concatPieces = Array.from({ length: 64 }, (_, index) => makeBytes(1_024, index + 31));
benchmark("concat/64x1024", () => Buffer.concat(concatPieces)[65_535]);

if (checksum === 0x7fffffff) console.log("unreachable checksum", checksum);
