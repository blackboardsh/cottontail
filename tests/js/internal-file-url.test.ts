import { expect, test } from "bun:test";
import {
  fileURLToPath as internalFileURLToPath,
  pathToFileURL as internalPathToFileURL,
} from "../../src/runtime_modules/internal/file-url.js";
import {
  fileURLToPath as publicFileURLToPath,
  pathToFileURL as publicPathToFileURL,
} from "node:url";

test("internal file URL helpers preserve POSIX conversion semantics", () => {
  const input = "/tmp/one/../two name#value?.txt";
  const expected = "file:///tmp/two%20name%23value%3F.txt";

  expect(internalPathToFileURL(input, { windows: false }).href).toBe(expected);
  expect(internalFileURLToPath(expected, { windows: false })).toBe("/tmp/two name#value?.txt");
  expect(publicPathToFileURL(input, { windows: false }).href).toBe(expected);
  expect(publicFileURLToPath(expected, { windows: false })).toBe("/tmp/two name#value?.txt");
});

test("internal file URL helpers preserve Windows drive and UNC semantics", () => {
  const drivePath = "C:\\work\\one\\..\\two name#value?.txt";
  const driveURL = "file:///C:/work/two%20name%23value%3F.txt";
  expect(internalPathToFileURL(drivePath, { windows: true }).href).toBe(driveURL);
  expect(internalFileURLToPath(driveURL, { windows: true })).toBe("C:\\work\\two name#value?.txt");

  const uncPath = "\\\\m\u00fcnchen\\share\\one\\..\\file.txt";
  const uncURL = "file://xn--mnchen-3ya/share/file.txt";
  expect(internalPathToFileURL(uncPath, { windows: true }).href).toBe(uncURL);
  expect(internalFileURLToPath(uncURL, { windows: true })).toBe("\\\\m\u00fcnchen\\share\\file.txt");

  expect(internalPathToFileURL("\\\\?\\C:\\work\\file.txt", { windows: true }).href)
    .toBe("file:///C:/work/file.txt");
});

test("internal file URL helpers reject encoded separators on both path styles", () => {
  for (const [input, windows] of [
    ["file:///tmp/a%2Fb", false],
    ["file:///C:/a%2Fb", true],
    ["file:///C:/a%5Cb", true],
  ] as const) {
    try {
      internalFileURLToPath(input, { windows });
      throw new Error("expected fileURLToPath to reject an encoded separator");
    } catch (error) {
      expect(error.code).toBe("ERR_INVALID_FILE_URL_PATH");
    }
  }
});
