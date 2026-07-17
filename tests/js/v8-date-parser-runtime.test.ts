import { describe, expect, test } from "bun:test";

describe("V8-compatible Date parser", () => {
  test("parses legacy V8 formats instead of accepting invalid suffixes", () => {
    expect(Date.parse("Ignore this prefix 01 Jan 2000 08:00:00 UT")).toBe(946713600000);
    expect(Date.parse("Janisamonth01 2000 08:00:00 UT")).toBe(946713600000);
    expect(Date.parse("Dec ((27) 26 (24)) 25 1995 1:30 PM UTC")).toBe(819898200000);
    expect(Date.parse("Dec 25 1995 1:30 PM (AM) (UTC) PST")).toBe(819927000000);
    expect(Date.parse("Dec 25 1995 1:30 XXX (GMT)")).toBeNaN();
    expect(Date.parse("May 25 2008 1:30 (PM)) UTC")).toBeNaN();
  });

  test("implements ISO defaults, offsets, and time clipping", () => {
    expect(Date.parse("2000-01-01T08:00:00.001Z")).toBe(946713600001);
    expect(Date.parse("2000-01T00:00:00.001-08:00")).toBe(946713600001);
    expect(Date.parse("2000-01-01T24:00:00.000Z")).toBe(946771200000);
    expect(Date.parse("2000-01-01T24:00:00.001Z")).toBeNaN();
    expect(Date.parse("+100000-10-13")).not.toBeNaN();
    expect(Date.parse("+275760-09-24")).toBeNaN();
  });

  test("uses local time only when the parsed format omits a zone", () => {
    const local = Date.parse("Jan 01 2000 08:00:00");
    expect(local).toBe(new Date(2000, 0, 1, 8, 0, 0, 0).getTime());
    expect(Date.parse("2000-01-01")).toBe(Date.UTC(2000, 0, 1));

    const originalSetHours = Date.prototype.setHours;
    try {
      Date.prototype.setHours = () => { throw new Error("patched setHours was called"); };
      expect(Date.parse("Jan 01 2000 08:00:00")).toBe(local);
    } finally {
      Date.prototype.setHours = originalSetHours;
    }
  });

  test("preserves Date call and construction semantics", () => {
    const direct = Date();
    expect(typeof direct).toBe("string");
    expect(Date.length).toBe(7);
    expect(Date.name).toBe("Date");
    expect(new Date().constructor).toBe(Date);
    expect(new Date(2000, 0, 2).getFullYear()).toBe(2000);
    expect(new Date(new Date(123)).getTime()).toBe(123);

    let hint;
    const value = {
      [Symbol.toPrimitive](receivedHint) {
        hint = receivedHint;
        return "2000-01-01T08:00:00Z";
      },
    };
    expect(new Date(value).getTime()).toBe(946713600000);
    expect(hint).toBe("default");

    const numericPrimitive = {
      valueOf() { return 123; },
      toString() { throw new Error("Date construction used the wrong coercion order"); },
    };
    expect(new Date(numericPrimitive).getTime()).toBe(123);
  });

  test("preserves subclassing, prototype methods, and parse coercion", () => {
    class DerivedDate extends Date {}
    const derived = new DerivedDate("2000-01-01T08:00:00Z");
    expect(derived).toBeInstanceOf(DerivedDate);
    expect(derived).toBeInstanceOf(Date);
    expect(derived.toISOString()).toBe("2000-01-01T08:00:00.000Z");

    let hint;
    const input = {
      [Symbol.toPrimitive](receivedHint) {
        hint = receivedHint;
        return "Sep 09 2022 03:53:45Z";
      },
    };
    expect(Date.parse(input)).toBe(1662695625000);
    expect(hint).toBe("string");
    expect(() => Date.parse(Symbol("date"))).toThrow(TypeError);
  });
});
