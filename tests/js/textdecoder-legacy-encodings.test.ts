import { expect, test } from "bun:test";

const legacyCases = [
  {
    encoding: "shift_jis",
    bytes: [0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd],
    text: "こんにちは",
  },
  {
    encoding: "euc-jp",
    bytes: [0xa4, 0xb3, 0xa4, 0xf3, 0xa4, 0xcb, 0xa4, 0xc1, 0xa4, 0xcf],
    text: "こんにちは",
  },
  {
    encoding: "iso-2022-jp",
    bytes: [
      0x1b, 0x24, 0x42, 0x24, 0x33, 0x24, 0x73, 0x24, 0x4b, 0x24, 0x41,
      0x24, 0x4f, 0x1b, 0x28, 0x42,
    ],
    text: "こんにちは",
  },
  {
    encoding: "big5",
    bytes: [0xa4, 0xa4, 0xa4, 0xe5],
    text: "中文",
  },
  {
    encoding: "euc-kr",
    bytes: [0xc7, 0xd1, 0xb1, 0xb9, 0xbe, 0xee],
    text: "한국어",
  },
  {
    encoding: "gbk",
    bytes: [0xd6, 0xd0, 0xce, 0xc4],
    text: "中文",
  },
  {
    encoding: "gb18030",
    bytes: [0x94, 0x39, 0xfc, 0x36],
    text: "😀",
  },
] as const;

test("legacy CJK TextDecoder encodings work in static builds", () => {
  for (const { encoding, bytes, text } of legacyCases) {
    expect(new TextDecoder(encoding).decode(Uint8Array.from(bytes))).toBe(text);
  }
});

test("legacy CJK TextDecoder preserves split sequences while streaming", () => {
  for (const { encoding, bytes, text } of legacyCases) {
    const decoder = new TextDecoder(encoding);
    expect(decoder.decode(Uint8Array.from(bytes.slice(0, 1)), { stream: true })).toBe("");
    expect(decoder.decode(Uint8Array.from(bytes.slice(1)))).toBe(text);
  }
});

test("legacy CJK TextDecoder fatal mode rejects truncated input", () => {
  for (const [encoding, bytes] of [
    ["shift_jis", [0x82]],
    ["iso-2022-jp", [0x1b, 0x24]],
    ["gb18030", [0x81, 0x30]],
  ] as const) {
    expect(() => {
      new TextDecoder(encoding, { fatal: true }).decode(Uint8Array.from(bytes));
    }).toThrow();
  }
});

test("ICU-backed single-byte TextDecoder tables are populated", () => {
  const bytes = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
  expect(new TextDecoder("windows-1251").decode(bytes)).toBe("Привет");
});
