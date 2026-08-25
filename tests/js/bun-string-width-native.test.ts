import { expect, test } from "bun:test";

const nativeStringWidthBeforeActivation = typeof (globalThis as any).cottontail.stringWidthNative;
void (globalThis as any).Cottontail.text;
const nativeStringWidth = (globalThis as any).cottontail.stringWidthNative as (
  value: string,
  countAnsiEscapeCodes: boolean,
  ambiguousIsNarrow: boolean,
) => number;

test("text native bindings install only when the capability activates", () => {
  expect(nativeStringWidthBeforeActivation).toBe("undefined");
  expect(typeof nativeStringWidth).toBe("function");
});

function stringFromCodeUnits(units: number[]): string {
  let result = "";
  for (let index = 0; index < units.length; index += 4096) {
    result += String.fromCharCode(...units.slice(index, index + 4096));
  }
  return result;
}

function jsOracle(
  input: string,
  options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean },
): number {
  // The non-Latin-1 prefix forces the public wrapper onto its unchanged JS
  // implementation. It has width two and does not affect following ANSI or
  // code-point policy.
  return Bun.stringWidth(`界${input}`, options) - 2;
}

const focusedCorpus = [
  "",
  "plain ASCII text",
  "\x00\x1f\x7f\x80\x9f",
  "\u00ad\u034f\u061c\u200b\u200c\u200d\u2060\ufeff",
  "e\u0301",
  "\u05d0\u05b0",
  "\u0627\u0650",
  "\u0915\u094d\u0915",
  "界古池や",
  "\u00b1\u201c\u2605\u26e3",
  "1\u20e3#\ufe0f\u20e3*\u20e3",
  "\ud83c\udde8\ud83c\udde6",
  "\ud83c\udde8\ud83c\udde6\ud83c\uddef",
  "👶🏽",
  "👩‍👩‍👦‍👦",
  "👨‍❤️‍💋‍👨",
  "🏴\u{e0067}\u{e0062}\u{e007f}",
  "\u2601\ufe0e\u2601\ufe0f",
  "\ud800\udbff\udc00\udfff",
  "a\x1b[31mb\x1b[0mc",
  "a\x1b[1;31;48;2;255;0;0mb",
  "a\x1b[unterminated",
  "a\x1b]0;title\x07b",
  "a\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\b",
  "a\x1b]payload\x9cb",
  "a\x1bxbc",
  "\x1b\x1b[31mred",
];

const focusedExpected = [
  [0, 0, 0, 0],
  [16, 16, 16, 16],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [1, 1, 1, 1],
  [1, 1, 1, 1],
  [2, 2, 2, 2],
  [8, 8, 8, 8],
  [6, 6, 8, 8],
  [6, 6, 6, 6],
  [2, 2, 2, 2],
  [3, 3, 3, 3],
  [2, 2, 2, 2],
  [2, 2, 2, 2],
  [2, 2, 2, 2],
  [2, 2, 2, 2],
  [3, 3, 3, 3],
  [1, 1, 1, 1],
  [3, 10, 3, 10],
  [2, 21, 2, 21],
  [12, 14, 12, 14],
  [2, 10, 2, 10],
  [6, 35, 6, 35],
  [1, 10, 1, 10],
  [4, 4, 4, 4],
  [3, 7, 3, 7],
] as const;

test("public Bun.stringWidth preserves focused Unicode and ANSI behavior", () => {
  for (let index = 0; index < focusedCorpus.length; index += 1) {
    const input = focusedCorpus[index];
    const expected = focusedExpected[index];
    expect(Bun.stringWidth(input)).toBe(expected[0]);
    expect(Bun.stringWidth(input, { countAnsiEscapeCodes: true })).toBe(expected[1]);
    expect(Bun.stringWidth(input, { ambiguousIsNarrow: false })).toBe(expected[2]);
    expect(Bun.stringWidth(input, {
      countAnsiEscapeCodes: true,
      ambiguousIsNarrow: false,
    })).toBe(expected[3]);
  }
});

test("native-accepted focused inputs match the current implementation", () => {
  let accepted = 0;
  for (const input of focusedCorpus) {
    for (const countAnsiEscapeCodes of [false, true]) {
      for (const ambiguousIsNarrow of [false, true]) {
        const options = { countAnsiEscapeCodes, ambiguousIsNarrow };
        const native = nativeStringWidth(input, countAnsiEscapeCodes, ambiguousIsNarrow);
        const reference = jsOracle(input, options);
        if (native >= 0) {
          accepted += 1;
          expect(native).toBe(reference);
        }
      }
    }
  }
  expect(accepted).toBeGreaterThan(0);
});

test("native Latin-1 and ANSI fast path matches the JavaScript oracle", () => {
  for (let codeUnit = 0; codeUnit <= 0xff; codeUnit += 1) {
    const input = String.fromCharCode(codeUnit);
    expect(nativeStringWidth(input, false, true)).toBe(jsOracle(input));
    expect(nativeStringWidth(input, true, true)).toBe(
      jsOracle(input, { countAnsiEscapeCodes: true }),
    );
  }

  let state = 0x91e10da5;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  let accepted = 0;
  for (let caseIndex = 0; caseIndex < 1024; caseIndex += 1) {
    const length = 1 + (random() % 192);
    const units: number[] = [];
    for (let index = 0; index < length; index += 1) {
      units.push(random() & 0xff);
    }
    if (caseIndex % 4 === 0) units.splice(random() % units.length, 0, 0x1b, 0x5b, 0x33, 0x31, 0x6d);
    if (caseIndex % 8 === 0) units.splice(random() % units.length, 0, 0x1b, 0x5d, 0x78, 0x07);
    const input = stringFromCodeUnits(units);
    for (const countAnsiEscapeCodes of [false, true]) {
      const native = nativeStringWidth(input, countAnsiEscapeCodes, true);
      if (native >= 0) {
        accepted += 1;
        expect(native).toBe(jsOracle(input, { countAnsiEscapeCodes }));
      }
    }
  }
  expect(accepted).toBeGreaterThan(1000);
});

test("native eligibility rejects deterministic hostile UTF-16 mixtures", () => {
  const interestingUnits = [
    0x0000, 0x001b, 0x001f, 0x0023, 0x002a, 0x0031, 0x005b, 0x005c, 0x005d,
    0x007f, 0x009c, 0x00ad, 0x00b1, 0x0300, 0x034f, 0x05b0, 0x061c, 0x0650,
    0x094d, 0x200b, 0x200d, 0x201c, 0x20e3, 0x2601, 0x2605, 0x26e3, 0xd7ff,
    0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xfe0e, 0xfe0f, 0xfeff, 0xfffd,
  ];
  let state = 0x6d2b79f5;
  const random = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  let accepted = 0;

  for (let caseIndex = 0; caseIndex < 2048; caseIndex += 1) {
    const length = 1 + (random() % 192);
    const units: number[] = [];
    for (let index = 0; index < length; index += 1) {
      const value = random();
      units.push(
        value % 3 === 0
          ? interestingUnits[value % interestingUnits.length]
          : value & 0xffff,
      );
    }
    const input = stringFromCodeUnits(units);
    for (const countAnsiEscapeCodes of [false, true]) {
      for (const ambiguousIsNarrow of [false, true]) {
        const options = { countAnsiEscapeCodes, ambiguousIsNarrow };
        const native = nativeStringWidth(input, countAnsiEscapeCodes, ambiguousIsNarrow);
        const reference = jsOracle(input, options);
        if (native >= 0) {
          accepted += 1;
          expect(native).toBe(reference);
        }
      }
    }
  }
  expect(accepted).toBe(0);
});

test("native eligibility accepts realistic terminal fast paths", () => {
  const cases = [
    ["status: compiling package 42/100", false, 32],
    ["\x1b[31merror\x1b[0m: failed", false, 13],
    ["\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\", false, 4],
    ["\x1b[31merror\x1b[0m: failed", true, 20],
  ] as const;

  for (const [input, countAnsiEscapeCodes, expected] of cases) {
    expect(nativeStringWidth(input, countAnsiEscapeCodes, true)).toBe(expected);
  }
});

test("native eligibility rejects semantic differences handled by JS", () => {
  const rejected = [
    ["\u00b1", false, false],
    ["e\u0301", false, true],
    ["1\ufe0f\u20e3", false, true],
    ["\ud83c\udde8\ud83c\udde6", false, true],
    ["👶🏽", false, true],
    ["👩‍👩‍👦‍👦", false, true],
    ["🏴\u{e0067}\u{e0062}\u{e007f}", false, true],
    ["\u2601\ufe0f", false, true],
    ["\ud800", false, true],
    ["a\x1b]payload\x9cb", false, true],
    ["界古池や", false, true],
  ] as const;

  for (const [input, countAnsiEscapeCodes, ambiguousIsNarrow] of rejected) {
    expect(nativeStringWidth(input, countAnsiEscapeCodes, ambiguousIsNarrow)).toBe(-1);
  }
});

test("long fallback cases and JavaScript coercion preserve public behavior", () => {
  const malformed = `${"a".repeat(300)}\ud800`;
  const c1TerminatedOsc = `${"a".repeat(300)}\x1b]payload\x9cb`;
  expect(Bun.stringWidth(malformed)).toBe(300);
  expect(Bun.stringWidth(c1TerminatedOsc)).toBe(300);

  const order: string[] = [];
  const value = {
    toString() {
      order.push("value");
      return "x".repeat(300);
    },
  };
  const options = {
    get countAnsiEscapeCodes() {
      order.push("count");
      return true;
    },
    get ambiguousIsNarrow() {
      order.push("ambiguous");
      return false;
    },
  };
  expect(Bun.stringWidth(value, options)).toBe(300);
  expect(order).toEqual(["value", "count", "ambiguous"]);

  expect(Bun.stringWidth(undefined)).toBe(0);
  expect(Bun.stringWidth(null)).toBe(0);
  expect(Bun.stringWidth(Symbol("x"))).toBe(9);
  expect(Bun.stringWidth("±", { ambiguousIsNarrow: 0 as any })).toBe(1);
  expect(Bun.stringWidth("±", { ambiguousIsNarrow: false })).toBe(2);
  expect(Bun.stringWidth("\x1b[31mx", { countAnsiEscapeCodes: 1 as any })).toBe(1);
  expect(Bun.stringWidth("\x1b[31mx", { countAnsiEscapeCodes: true })).toBe(5);
});
