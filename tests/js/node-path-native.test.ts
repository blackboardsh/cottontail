import { describe, expect, test } from "bun:test";
import path from "node:path";

const nativeNormalize = cottontail.pathNormalizeNative;

describe("native node:path normalize", () => {
  test("binding matches the JS path for short POSIX inputs", () => {
    for (const value of [
      "",
      ".",
      "..",
      "/",
      "///",
      "./fixtures///b/../b/c.js",
      "/foo/../../../bar",
      "a//b//../b",
      "a//b//./c",
      "a//b//.",
      "/a/b/c/../../../x/y/z",
      "///..//./foo/.//bar",
      "bar/foo../../",
      "bar/foo../..",
      "bar/foo../../baz",
      "bar/foo../",
      "../foo../../../bar",
      "../.../.././.../../../bar",
      "../../../foo/../../../bar/../../",
      "../foobar/barfoo/foo/../../../bar/../../",
      "café/δ/../終.js",
      `a/\ud800/b/../c`,
    ]) {
      expect(nativeNormalize(false, value)).toBe(path.posix.normalize(value));
    }
  });

  test("binding matches the JS path for short Win32 inputs", () => {
    for (const value of [
      "",
      ".",
      "..",
      "\\",
      "\\\\\\",
      "C:",
      "C:..\\abc",
      "C:..\\..\\abc\\..\\def",
      "C:\\.",
      "file:stream",
      "\\\\server\\share\\dir\\file.ext",
      "\\\\.\\PHYSICALDRIVE0",
      "bar\\foo..\\..\\",
      "bar\\foo..\\..",
      "bar\\foo..\\..\\baz",
      "bar\\foo..\\",
      "..\\foo..\\..\\..\\bar",
      "..\\...\\..\\.\\...\\..\\..\\bar",
      "../../../foo/../../../bar/../../",
      "../foobar/barfoo/foo/../../../bar/../../",
      "café\\δ\\..\\終.js",
      `a\\\ud800\\b\\..\\c`,
    ]) {
      expect(nativeNormalize(true, value)).toBe(path.win32.normalize(value));
    }
  });

  test("public POSIX normalize uses the native-safe long-input behavior", () => {
    const cases = [
      [`${"segment/../".repeat(80)}dist//tool.js`, "dist/tool.js"],
      [`/${"segment/../".repeat(80)}dist//tool.js`, "/dist/tool.js"],
      [`café/${"δ/../".repeat(80)}終.js`, "café/終.js"],
    ] as const;

    for (const [value, expected] of cases) {
      expect(value.length).toBeGreaterThanOrEqual(256);
      expect(nativeNormalize(false, value)).toBe(expected);
      expect(path.posix.normalize(value)).toBe(expected);
    }
  });

  test("public Win32 normalize uses the native-safe long-input behavior", () => {
    const cases = [
      [`C:\\${"segment\\..\\".repeat(80)}dist\\\\tool.js`, "C:\\dist\\tool.js"],
      [
        `\\\\server\\share\\${"segment\\..\\".repeat(80)}dist\\\\tool.js`,
        "\\\\server\\share\\dist\\tool.js",
      ],
      [`${"segment\\..\\".repeat(80)}dist\\\\tool.js`, "dist\\tool.js"],
    ] as const;

    for (const [value, expected] of cases) {
      expect(value.length).toBeGreaterThanOrEqual(256);
      expect(nativeNormalize(true, value)).toBe(expected);
      expect(path.win32.normalize(value)).toBe(expected);
    }
  });

  test("long String objects retain the existing JS fallback behavior", () => {
    const value = new String(`${"segment/../".repeat(80)}dist/tool.js`);
    expect(path.posix.normalize(value as unknown as string)).toBe("dist/tool.js");
  });
});
