import { describe, expect, test } from "bun:test";

describe("native text encoding fast paths", () => {
  test("does not take the one-shot path after streaming state exists", () => {
    const decoder = new TextDecoder();
    expect(decoder.decode(Uint8Array.of(0xe2), { stream: true })).toBe("");

    const tail = new Uint8Array(64);
    tail.fill(0x61);
    tail[0] = 0x82;
    tail[1] = 0xac;
    expect(decoder.decode(tail)).toBe(`\u20ac${"a".repeat(62)}`);
  });

  test("preserves streaming BOM state across a large final chunk", () => {
    const decoder = new TextDecoder();
    expect(decoder.decode(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61), { stream: true })).toBe("a");

    const tail = new Uint8Array(64);
    tail.fill(0x61);
    tail.set([0xef, 0xbb, 0xbf]);
    expect(decoder.decode(tail)).toBe(`\ufeff${"a".repeat(61)}`);
  });

  test("preserves WHATWG invalid UTF-8 replacement boundaries", () => {
    const input = new Uint8Array(72);
    input.fill(0x61);
    input.set([0xe2, 0x28, 0xa1], 64);
    expect(new TextDecoder().decode(input)).toBe(`${"a".repeat(64)}\ufffd(\ufffd${"a".repeat(5)}`);
  });

  test("normalizes fatal native decode errors", () => {
    const input = new Uint8Array(65);
    input.fill(0x61);
    input[64] = 0x80;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(input);
      throw new Error("expected decode to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect(error.code).toBe("ERR_ENCODING_INVALID_ENCODED_DATA");
    }
  });

  test("strips only a leading BOM unless ignoreBOM is set", () => {
    const input = new Uint8Array(70);
    input.fill(0x61);
    input.set([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(input)).toBe(`\ufeff${"a".repeat(64)}`);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(input)).toBe(`\ufeff\ufeff${"a".repeat(64)}`);
  });

  test("encodes lone surrogates above the native threshold as replacement characters", () => {
    const encoder = new TextEncoder();
    const prefix = "a".repeat(256);
    expect(Array.from(encoder.encode(`${prefix}\ud800`).slice(-3))).toEqual([0xef, 0xbf, 0xbd]);
    expect(Array.from(encoder.encode(`${prefix}\udc00`).slice(-3))).toEqual([0xef, 0xbf, 0xbd]);
  });
});
