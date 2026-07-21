import { expect, test } from "bun:test";
import { Buffer as NodeBuffer } from "node:buffer";

const cases = [
  ["", ""],
  ["A", ""],
  ["ascii", ""],
  ["0g", ""],
  ["g0", ""],
  ["Abx", "ab"],
  ["1ag123", "1a"],
  ["abxxcd", "ab"],
  ["3DD84DDC", "3dd84ddc"],
] as const;

test("global Buffer decodes only complete hex byte pairs", () => {
  expect(globalThis.Buffer).toBe(NodeBuffer);

  for (const [input, expected] of cases) {
    expect(globalThis.Buffer.from(input, "hex").toString("hex")).toBe(expected);
    expect(NodeBuffer.from(input, "HEX").toString("hex")).toBe(expected);
  }
});

test("Buffer hex writes stop before an incomplete byte pair", () => {
  for (const [input, expected] of cases) {
    for (const write of [
      (buffer: Buffer) => buffer.write(input, "hex"),
      (buffer: Buffer) => buffer.write(input, 0, "hex"),
      (buffer: Buffer) => buffer.write(input, 0, buffer.length, "hex"),
      (buffer: Buffer) => (buffer as Buffer & { hexWrite(value: string, offset: number, length: number): number })
        .hexWrite(input, 0, buffer.length),
    ]) {
      const buffer = NodeBuffer.alloc(8);
      expect(write(buffer)).toBe(expected.length / 2);
      expect(buffer.toString("hex", 0, expected.length / 2)).toBe(expected);
    }
  }
});
