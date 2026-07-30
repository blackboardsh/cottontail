const rounds = Number(process.env.COTTONTAIL_ENCODING_BENCH_ROUNDS ?? 7);
const scale = Number(process.env.COTTONTAIL_ENCODING_BENCH_SCALE ?? 1);

const sizes = [16, 64, 128, 256, 1024, 4096, 1024 * 1024];

function makeUtf8(size) {
  const bytes = new Uint8Array(size);
  bytes.fill(0x61);
  for (let index = 8; index + 2 < size; index += 16) {
    bytes.set([0xe2, 0x98, 0x83], index);
  }
  return bytes;
}

function makeUtf16(size) {
  const bytes = new Uint8Array(size & ~1);
  for (let index = 0; index < bytes.length; index += 2) {
    bytes[index] = 0x61 + ((index >> 1) % 26);
  }
  return bytes;
}

function makeSingleByte(size) {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index & 0xff;
  return bytes;
}

function makeText(size) {
  const pattern = "cottontail \u2603 ";
  return pattern.repeat(Math.ceil(size / pattern.length)).slice(0, size);
}

const utf8Inputs = sizes.map(makeUtf8);
const utf16Inputs = sizes.map(makeUtf16);
const singleByteInputs = sizes.map(makeSingleByte);
const textInputs = sizes.map(makeText);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(name, iterations, operation) {
  let checksum = 0;
  for (let index = 0; index < Math.min(iterations, 10); index += 1) {
    checksum += operation();
  }

  const samplesMs = [];
  for (let round = 0; round < rounds; round += 1) {
    const started = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      checksum += operation();
    }
    samplesMs.push(performance.now() - started);
  }

  const medianMs = median(samplesMs);
  return {
    name,
    iterations,
    medianMs,
    microsecondsPerOperation: medianMs * 1_000 / iterations,
    checksum,
    samplesMs,
  };
}

function scaled(iterations) {
  return Math.max(1, Math.round(iterations * scale));
}

function iterationsFor(size) {
  if (size <= 64) return scaled(20_000);
  if (size <= 256) return scaled(5_000);
  if (size <= 1024) return scaled(1_200);
  if (size <= 4096) return scaled(300);
  return scaled(10);
}

const utf8 = new TextDecoder("utf-8");
const utf16 = new TextDecoder("utf-16le");
const singleByte = new TextDecoder("windows-1252");
const encoder = new TextEncoder();

const results = [
  measure("label-construction", scaled(30_000), () => new TextDecoder("  WiNdOwS-1252 ").encoding.length),
  ...sizes.map((size, index) =>
    measure(`decode-utf8-${size}`, iterationsFor(size), () => utf8.decode(utf8Inputs[index]).length)),
  ...sizes.map((size, index) =>
    measure(`decode-utf16-${size}`, iterationsFor(size), () => utf16.decode(utf16Inputs[index]).length)),
  ...sizes.map((size, index) =>
    measure(`decode-single-byte-${size}`, iterationsFor(size), () => singleByte.decode(singleByteInputs[index]).length)),
  ...sizes.map((size, index) =>
    measure(`encode-utf8-${size}`, iterationsFor(size), () => encoder.encode(textInputs[index]).length)),
];

console.log(JSON.stringify({ rounds, scale, results }, null, 2));
