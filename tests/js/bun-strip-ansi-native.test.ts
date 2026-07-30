import { describe, expect, test } from "bun:test";

function referenceStripANSI(value: unknown): string {
  const text = String(value);
  if (!/[\x1b\x90\x98\x9b-\x9f]/.test(text)) return text;
  let out = "";
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (!isANSIControl(code)) {
      index += 1;
      continue;
    }
    out += text.slice(plainStart, index);
    const next = consumeANSI(text, index);
    if (next === index) {
      out += text[index];
      index += 1;
    } else {
      index = next;
    }
    plainStart = index;
  }
  return out + text.slice(plainStart);
}

function isANSIControl(code: number): boolean {
  return code === 0x1b ||
    code === 0x90 ||
    code === 0x98 ||
    (code >= 0x9b && code <= 0x9f);
}

function consumeANSI(text: string, start: number): number {
  type State =
    | "start"
    | "got-esc"
    | "ignore-next"
    | "in-csi"
    | "in-osc"
    | "in-osc-got-esc"
    | "need-st"
    | "need-st-got-esc";

  let state: State = "start";
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    switch (state) {
      case "start":
        if (code === 0x1b) state = "got-esc";
        else if (code === 0x9b) state = "in-csi";
        else if (code === 0x9d) state = "in-osc";
        else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) state = "need-st";
        else return index;
        break;
      case "got-esc":
        if (code === 0x5b) state = "in-csi";
        else if ([0x20, 0x23, 0x25, 0x28, 0x29, 0x2a, 0x2b, 0x2e, 0x2f].includes(code)) state = "ignore-next";
        else if (code === 0x5d) state = "in-osc";
        else if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) state = "need-st";
        else state = "start";
        break;
      case "ignore-next":
        state = "start";
        break;
      case "in-csi":
        if (code >= 0x40 && code <= 0x7e) state = "start";
        break;
      case "in-osc":
        if (code === 0x07 || code === 0x9c) state = "start";
        else if (code === 0x1b) state = "in-osc-got-esc";
        break;
      case "in-osc-got-esc":
        state = code === 0x5c ? "start" : "in-osc";
        break;
      case "need-st":
        if (code === 0x9c) state = "start";
        else if (code === 0x1b) state = "need-st-got-esc";
        break;
      case "need-st-got-esc":
        state = code === 0x5c ? "start" : "need-st";
        break;
    }
  }
  return text.length;
}

function expectDifferential(input: unknown): void {
  expect(Bun.stripANSI(input as string)).toBe(referenceStripANSI(input));
}

describe("Bun.stripANSI native fast path", () => {
  test("matches below, at, and above the native threshold", () => {
    for (const length of [0, 1, 32, 2047, 2048, 2049, 4096, 65536]) {
      expectDifferential("x".repeat(length) + "\x1b[31mred\x1b[0m");
      expectDifferential("\x1b[31m" + "x".repeat(length) + "\x1b[0m");
      expectDifferential("x".repeat(length));
    }
  });

  test("matches CSI, C1 CSI, and malformed sequence behavior", () => {
    const cases = [
      "\x1b[31mred\x1b[0m",
      "\x1b[38;2;255;0;0mred\x1b[0m",
      "\x1b[;;mempty",
      "\x1b[" + "1;".repeat(2048) + "mtext",
      "\x1b[",
      "\x1b[31",
      "\x1b[\ud83d\ude00tail",
      "\x9b31mtext\x9b39m",
      "\x9b[31mtext",
      "\x9b\ud800tail",
      "\x9b" + "1;".repeat(2048),
    ];
    for (const input of cases) {
      expectDifferential(input.repeat(input.length < 256 ? 128 : 1));
    }
  });

  test("matches OSC terminators and unterminated OSC behavior", () => {
    const payload = "title-\ud83d\ude80-".repeat(128);
    for (const terminator of ["\x07", "\x1b\\", "\x9c"]) {
      expectDifferential("before\x1b]0;" + payload + terminator + "after");
    }
    expectDifferential("before\x1b]0;" + payload);
    expectDifferential("before\x1b]0;" + payload + "\x1bXstill-osc\x07after");
    expectDifferential("before\x1b]0;" + payload + "\x1b");
  });

  test("matches two-byte, intermediate, lone ESC, and C1 ST behavior", () => {
    const suffix = "tail".repeat(128);
    for (const prefix of [
      "\x1b7",
      "\x1b=",
      "\x1bM",
      "\x1b(B",
      "\x1b#8",
      "\x1b%G",
      "\x1b ",
      "\x1b",
      "\x9c",
    ]) {
      expectDifferential(prefix + suffix);
    }
    expectDifferential(suffix + "\x1b");
  });

  test("matches Bun's DCS, SOS, PM, and APC string controls", () => {
    const suffix = "visible".repeat(64);
    for (const introducer of ["\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x90", "\x98", "\x9e", "\x9f"]) {
      expectDifferential("before" + introducer + "opaque payload\x1b\\" + suffix);
      expectDifferential("before" + introducer + "opaque payload\x9c" + suffix);
      expectDifferential("before" + introducer + "unterminated payload");
    }
    expectDifferential("before\x9cafter");
    expectDifferential("\x1b[31m\x1b]0;title\x07\x1bPpayload\x1b\\after");
  });

  test("preserves Unicode code units, including lone surrogates", () => {
    const inputs = [
      "你好\x1b[31m世界\x1b[0m".repeat(128),
      "\ud83d\ude00\x1b[32m\ud83d\ude80\x1b[0m".repeat(128),
      ("\ud800x\udc00\x1b[1my\x1b[0m").repeat(128),
      ("e\u0301\x9b31mZ\x9b0m").repeat(128),
    ];
    for (const input of inputs) expectDifferential(input);
  });

  test("coerces exactly once before selecting the fast path", () => {
    let calls = 0;
    const coercible = {
      toString() {
        calls += 1;
        return "\x1b[31m" + "x".repeat(4096) + "\x1b[0m";
      },
    };
    expectDifferential(coercible);
    expect(calls).toBe(2);

    expect(Bun.stripANSI(Symbol("ansi"))).toBe("Symbol(ansi)");
    expect(Bun.stripANSI(123 as unknown as string)).toBe("123");
    expect(Bun.stripANSI(null as unknown as string)).toBe("null");
    expect(Bun.stripANSI(undefined as unknown as string)).toBe("undefined");
  });

  test("preserves conversion exceptions", () => {
    const sentinel = { sentinel: true };
    const throwing = {
      toString() {
        throw sentinel;
      },
    };
    let received: unknown;
    try {
      Bun.stripANSI(throwing as unknown as string);
    } catch (error) {
      received = error;
    }
    expect(received).toBe(sentinel);
    expect(() => Bun.stripANSI(Object.create(null))).toThrow(TypeError);
  });
});
