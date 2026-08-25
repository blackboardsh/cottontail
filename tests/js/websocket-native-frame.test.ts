import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { parseWebSocketFrames, websocketFrame } from "node:http";

type NativeHost = {
  websocketFrameEncode(
    payload: ArrayBufferView | ArrayBuffer,
    opcode: number,
    masked: boolean,
    rsv1: boolean,
    mask?: ArrayBufferView | ArrayBuffer,
  ): ArrayBuffer;
  websocketUnmaskCopy(
    payload: ArrayBufferView | ArrayBuffer,
    mask: ArrayBufferView | ArrayBuffer,
  ): ArrayBuffer;
};

// Native frame operations belong to the optional websocket capability, not
// the core host. Activate it before inspecting its private test bindings.
void Cottontail.websocket;
const host = globalThis.cottontail as NativeHost;

function referenceFrame(
  payload: Uint8Array,
  opcode: number,
  masked: boolean,
  rsv1: boolean,
  mask = new Uint8Array([0x37, 0xfa, 0x21, 0x3d]),
): Buffer {
  const headerLength = payload.byteLength < 126 ? 2 : payload.byteLength <= 0xffff ? 4 : 10;
  const output = Buffer.alloc(headerLength + (masked ? 4 : 0) + payload.byteLength);
  output[0] = 0x80 | (rsv1 ? 0x40 : 0) | (opcode & 0x0f);
  if (payload.byteLength < 126) {
    output[1] = (masked ? 0x80 : 0) | payload.byteLength;
  } else if (payload.byteLength <= 0xffff) {
    output[1] = (masked ? 0x80 : 0) | 126;
    output[2] = payload.byteLength >>> 8;
    output[3] = payload.byteLength;
  } else {
    output[1] = (masked ? 0x80 : 0) | 127;
    let length = BigInt(payload.byteLength);
    for (let index = 0; index < 8; index += 1) {
      output[9 - index] = Number(length & 0xffn);
      length >>= 8n;
    }
  }

  let offset = headerLength;
  if (masked) {
    output.set(mask, offset);
    offset += 4;
    for (let index = 0; index < payload.byteLength; index += 1) {
      output[offset + index] = payload[index] ^ mask[index & 3];
    }
  } else {
    output.set(payload, offset);
  }
  return output;
}

function deterministicBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

describe("native WebSocket frame byte operations", () => {
  test("matches exact RFC wire bytes at all length boundaries", () => {
    const lengths = [0, 1, 2, 124, 125, 126, 127, 255, 256, 65534, 65535, 65536, 131071];
    const opcodes = [0x0, 0x1, 0x2, 0x8, 0x9, 0xa];
    let assertions = 0;
    for (const length of lengths) {
      for (const masked of [false, true]) {
        for (const rsv1 of [false, true]) {
          for (const opcode of opcodes) {
            if ((opcode & 0x08) !== 0 && length > 125) continue;
            const storage = deterministicBytes(length + 19, length ^ opcode ^ 0x5a17);
            const payload = storage.subarray(7, 7 + length);
            const maskStorage = new Uint8Array([9, 8, 0x37, 0xfa, 0x21, 0x3d, 7]);
            const mask = new DataView(maskStorage.buffer, 2, 4);
            const before = Buffer.from(payload);
            const actual = Buffer.from(host.websocketFrameEncode(payload, opcode, masked, rsv1, mask));
            expect(actual).toEqual(referenceFrame(payload, opcode, masked, rsv1));
            expect(Buffer.from(payload)).toEqual(before);
            assertions += 2;
          }
        }
      }
    }
    expect(assertions).toBeGreaterThan(250);
  });

  test("randomized native encode and unmask match the JS reference", () => {
    const boundaryLengths = [0, 1, 124, 125, 126, 127, 255, 256, 257, 4095, 4096, 65535, 65536];
    let state = 0xc0110a11;
    for (let iteration = 0; iteration < 400; iteration += 1) {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      const length = iteration < boundaryLengths.length
        ? boundaryLengths[iteration]
        : state % 150_000;
      const opcode = [0x0, 0x1, 0x2][state % 3];
      const masked = (state & 1) !== 0;
      const rsv1 = (state & 2) !== 0;
      const payloadStorage = deterministicBytes(length + 31, state ^ 0x9172);
      const payload = new Uint8Array(payloadStorage.buffer, 13, length);
      const maskStorage = deterministicBytes(12, state ^ 0xa5a5);
      const mask = new Uint8Array(maskStorage.buffer, 5, 4);

      const actual = Buffer.from(host.websocketFrameEncode(payload, opcode, masked, rsv1, mask));
      expect(actual).toEqual(referenceFrame(payload, opcode, masked, rsv1, mask));

      const maskedPayloadOffset = actual.byteLength - length;
      const encodedPayload = new DataView(actual.buffer, actual.byteOffset + maskedPayloadOffset, length);
      if (masked) {
        const encodedBefore = Buffer.from(
          new Uint8Array(encodedPayload.buffer, encodedPayload.byteOffset, encodedPayload.byteLength),
        );
        const decoded = Buffer.from(host.websocketUnmaskCopy(encodedPayload, mask));
        expect(decoded).toEqual(Buffer.from(payload));
        expect(Buffer.from(
          new Uint8Array(encodedPayload.buffer, encodedPayload.byteOffset, encodedPayload.byteLength),
        )).toEqual(encodedBefore);
      }
    }
  });

  test("public paths preserve source bytes, offsets, aliases, and partial frames", () => {
    for (const length of [255, 256, 4095, 4096, 65536]) {
      const storage = deterministicBytes(length + 64, length);
      const input = new Uint8Array(storage.buffer, 23, length);
      const inputBefore = Buffer.from(input);
      const frame = websocketFrame(0x2, input, true, false);
      expect(Buffer.from(input)).toEqual(inputBefore);
      expect((frame[1] & 0x80) !== 0).toBe(true);

      const frameBefore = Buffer.from(frame);
      const parsed = parseWebSocketFrames(frame, { expectMasked: true });
      expect(parsed.frames).toHaveLength(1);
      expect(parsed.frames[0].payload).toEqual(inputBefore);
      expect(frame).toEqual(frameBefore);
      expect(parsed.remaining.byteLength).toBe(0);

      const nextFrame = websocketFrame(0x1, "next", false);
      const combined = Buffer.concat([frame, nextFrame]);
      const combinedBefore = Buffer.from(combined);
      const split = combined.subarray(0, frame.byteLength - 1);
      const partial = parseWebSocketFrames(split, { expectMasked: true });
      expect(partial.frames).toHaveLength(0);
      expect(partial.remaining.buffer).toBe(split.buffer);
      expect(combined).toEqual(combinedBefore);
    }

    for (const length of [255, 256, 1536, 2048, 4096]) {
      const storage = deterministicBytes(length + 47, length ^ 0x5511);
      const input = new DataView(storage.buffer, 17, length);
      const frame = websocketFrame(0x2, input, false, true);
      expect(frame).toEqual(referenceFrame(
        new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
        0x2,
        false,
        true,
      ));
      const parsed = parseWebSocketFrames(frame, { expectMasked: false, allowCompression: true });
      expect(parsed.frames).toHaveLength(1);
      expect(parsed.frames[0].payload).toEqual(
        Buffer.from(input.buffer, input.byteOffset, input.byteLength),
      );
    }
  });

  test("retains control-frame and parser protocol errors", () => {
    expect(() => websocketFrame(0x8, Buffer.alloc(126), true)).toThrow(RangeError);
    expect(() => host.websocketFrameEncode(Buffer.alloc(126), 0x8, true, false)).toThrow();
    expect(() => host.websocketUnmaskCopy(Buffer.alloc(256), Buffer.alloc(3))).toThrow(TypeError);
    expect(() => parseWebSocketFrames(
      Buffer.from([0x81, 0x80, 0, 0, 0, 0]),
      { expectMasked: false },
    )).toThrow();
    expect(() => parseWebSocketFrames(
      Buffer.from([0x81, 0]),
      { expectMasked: true },
    )).toThrow();
    expect(() => parseWebSocketFrames(
      Buffer.from([0x82, 126, 0, 1, 0]),
      { expectMasked: false },
    )).toThrow();
  });
});
