import { color } from "bun";
import { expect, test } from "bun:test";

test("Bun.color uses the vendored CSS parser and color-space conversions", () => {
  expect(color("red", "css")).toBe("red");
  expect(color("rgb(256, 0, 0)", "css")).toBe("red");
  expect(color("color(display-p3 1 0 0)", "css")).toBe("color(display-p3 1 0 0)");
  expect(color("red", "hsl")).toBe("hsl(0, 1, 0.5)");
  expect(color("red", "lab")).toBe("lab(0.54290545, 80.80492, 69.89099)");
  expect(color("not a color", "css")).toBeNull();
});

test("Bun.color preserves Bun's structured and packed-number formats", () => {
  expect(color({ r: 255, g: 0, b: 0, a: 0.5 }, "{rgba}")).toEqual({
    r: 255,
    g: 0,
    b: 0,
    a: 0.49803921580314636,
  });
  expect(color([255, 0, 0, 127], "[rgba]")).toEqual([255, 0, 0, 127]);
  expect(color(0xff0000, "css")).toBe("#f000");
  expect(color(-1, "rgba")).toBe("rgba(255, 255, 254, 1)");
  expect(color(Infinity, "rgba")).toBe("rgba(255, 255, 255, 0.49803922)");
});

test("Bun.color validates the public contract", () => {
  expect(() => color()).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }));
  expect(() => color({}, "css")).toThrow(expect.objectContaining({
    name: "TypeError",
    code: "ERR_INVALID_ARG_TYPE",
  }));
  expect(() => color([1, 2], "css")).toThrow("Expected array length 3 or 4");
  expect(() => color("red", "unknown" as any)).toThrow(expect.objectContaining({
    code: "ERR_INVALID_ARG_VALUE",
  }));
});

test("Bun.color ANSI conversion matches Bun's packed modulo behavior", () => {
  expect(color(-1, "ansi-24bit")).toBe("\x1b[38;2;255;255;254m");
  expect(color(0xff0000, "ansi256")).toBe("\x1b[38;5;196m");
  expect(color({ r: 0, g: 255, b: 0 }, "ansi-16")).toBe("\x1b[38;5;\x0am");
});
