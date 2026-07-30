import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { parseWebSocketFrames, websocketFrame } from "node:http";
import { performance } from "node:perf_hooks";

const lengths = [
  64,
  256,
  512,
  1024,
  1536,
  2048,
  4 * 1024,
  8 * 1024,
  16 * 1024,
  256 * 1024,
  1024 * 1024,
];
const samples = 9;

function deterministicBytes(length) {
  const bytes = Buffer.alloc(length);
  let state = (length ^ 0x7137a55) >>> 0;
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function iterationsFor(length) {
  return Math.max(12, Math.min(20_000, Math.floor((32 * 1024 * 1024) / Math.max(length, 64))));
}

function median(values) {
  values.sort((left, right) => left - right);
  return values[Math.floor(values.length / 2)];
}

function measure(operation, iterations) {
  for (let index = 0; index < Math.min(iterations, 100); index += 1) operation();
  const timings = [];
  let guard = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) {
      guard ^= operation();
    }
    timings.push((performance.now() - start) * 1e6 / iterations);
  }
  return { ns: median(timings), guard };
}

function jsWebSocketFrame(opcode, payload, masked) {
  const body = Buffer.from(payload);
  const header = [0x80 | (opcode & 0x0f)];
  if (body.byteLength < 126) {
    header.push((masked ? 0x80 : 0) | body.byteLength);
  } else if (body.byteLength <= 0xffff) {
    header.push((masked ? 0x80 : 0) | 126, body.byteLength >>> 8, body.byteLength & 0xff);
  } else {
    const length = BigInt(body.byteLength);
    header.push((masked ? 0x80 : 0) | 127);
    for (let shift = 56n; shift >= 0n; shift -= 8n) header.push(Number((length >> shift) & 0xffn));
  }
  if (!masked) return Buffer.concat([Buffer.from(header), body]);
  const mask = randomBytes(4);
  const output = Buffer.from(body);
  for (let index = 0; index < output.byteLength; index += 1) output[index] ^= mask[index & 3];
  return Buffer.concat([Buffer.from(header), mask, output]);
}

function jsParseMaskedFrame(frame) {
  let offset = 2;
  let length = frame[1] & 0x7f;
  if (length === 126) {
    length = frame[offset] * 0x100 + frame[offset + 1];
    offset += 2;
  } else if (length === 127) {
    let value = 0n;
    for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(frame[offset + index]);
    length = Number(value);
    offset += 8;
  }
  const mask = frame.subarray(offset, offset + 4);
  offset += 4;
  const payload = Buffer.from(frame.subarray(offset, offset + length));
  for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index & 3];
  return payload;
}

function comparison(baseline, native) {
  return {
    baselineNs: baseline.ns,
    nativeNs: native.ns,
    speedup: baseline.ns / native.ns,
    guard: baseline.guard ^ native.guard,
  };
}

const results = [];
for (const length of lengths) {
  const payload = deterministicBytes(length);
  const maskedFrame = websocketFrame(0x2, payload, true);
  const iterations = iterationsFor(length);

  const jsClient = measure(() => jsWebSocketFrame(0x2, payload, true).byteLength, iterations);
  const nativeClient = measure(() => websocketFrame(0x2, payload, true).byteLength, iterations);
  const jsServer = measure(() => jsWebSocketFrame(0x2, payload, false).byteLength, iterations);
  const nativeServer = measure(() => websocketFrame(0x2, payload, false).byteLength, iterations);
  const jsDecode = measure(() => jsParseMaskedFrame(maskedFrame)[0], iterations);
  const nativeDecode = measure(
    () => parseWebSocketFrames(maskedFrame, { expectMasked: true }).frames[0].payload[0],
    iterations,
  );
  results.push({
    length,
    iterations,
    clientMaskedEncode: comparison(jsClient, nativeClient),
    serverUnmaskedEncode: comparison(jsServer, nativeServer),
    maskedDecode: comparison(jsDecode, nativeDecode),
  });
}

console.log(JSON.stringify(results, null, 2));
