import { describe, expect, test } from "bun:test";

describe("native Bun text utilities", () => {
  test("escapeHTML preserves coercion and UTF-16 content", () => {
    let calls = 0;
    const value = {
      toString() {
        calls += 1;
        return `${"x".repeat(80)}<&>"'\u{1f642}\ud800`;
      },
    };
    expect(Bun.escapeHTML(value)).toBe(
      `${"x".repeat(80)}&lt;&amp;&gt;&quot;&#x27;\u{1f642}\ud800`,
    );
    expect(calls).toBe(1);
    expect(Bun.escapeHTML("plain")).toBe("plain");
  });

  test("stripANSI handles CSI, OSC, C1, and invalid suffixes", () => {
    expect(Bun.stripANSI("\x1b[31mred\x1b[0m")).toBe("red");
    expect(Bun.stripANSI("a\x1b]8;;https://example.com\x07link\x1b]8;;\x07b")).toBe("alinkb");
    expect(Bun.stripANSI("a\x1b]0;title\x1b\\b")).toBe("ab");
    expect(Bun.stripANSI("a\x9b31mb")).toBe("ab");
    expect(Bun.stripANSI("a\x1b[1\u0100b")).toBe("a\u0100b");
    expect(Bun.stripANSI("\x16before\x1b[31mred\x1b[0m\x19after")).toBe(
      "\x16beforered\x19after",
    );
  });

  test("stringWidth handles ANSI, emoji, ambiguity, and lone surrogates", () => {
    expect(Bun.stringWidth(null)).toBe(0);
    expect(Bun.stringWidth("\x1b[31mred\x1b[0m")).toBe(3);
    expect(Bun.stringWidth("\x1b[31mred\x1b[0m", { countAnsiEscapeCodes: true })).toBe(10);
    expect(Bun.stringWidth("👩‍💻")).toBe(2);
    expect(Bun.stringWidth("1️⃣")).toBe(2);
    expect(Bun.stringWidth("🇨🇦")).toBe(2);
    expect(Bun.stringWidth("\ud800")).toBe(0);
    expect(Bun.stringWidth("\u00b1")).toBe(1);
    expect(Bun.stringWidth("\u00b1", { ambiguousIsNarrow: false })).toBe(2);
  });

  test("stringWidth routes long ASCII and falls back for complex text", () => {
    expect(Bun.stringWidth(`${"a".repeat(256)}\0\n\x7fb`)).toBe(257);
    expect(Bun.stringWidth(`${"a".repeat(256)}\x1b[31mred\x1b[0m`)).toBe(259);
    expect(Bun.stringWidth(`${"a".repeat(256)}👩‍💻`)).toBe(258);
  });
});
