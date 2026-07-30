import { expect, test } from "bun:test";

test("Bun.file MIME inference preserves Bun extension behavior", () => {
  const cases = [
    ["file.css", "text/css;charset=utf-8"],
    ["file.js", "text/javascript;charset=utf-8"],
    ["file.ts", "text/javascript;charset=utf-8"],
    ["file.json", "application/json;charset=utf-8"],
    ["file.txt", "text/plain;charset=utf-8"],
    ["file.ico", "image/x-icon"],
    ["file.wasm", "application/wasm"],
    ["file.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["file.7z", "application/x-7z-compressed"],
    ["file.yaml", "text/yaml"],
    ["file.unknown", "application/octet-stream"],
    ["file.CSS", "application/octet-stream"],
    ["/directory.with.dot/file", "application/octet-stream"],
    ["/directory/file.", "application/octet-stream"],
    ["/directory/.json", "application/octet-stream"],
    [String.raw`C:\directory\file.css`, "text/css;charset=utf-8"],
    ["file.css?query", "application/octet-stream"],
    ["file.css#fragment", "application/octet-stream"],
    ["file.\u{1f4a5}", "application/octet-stream"],
    [`file.${"x".repeat(65)}`, "application/octet-stream"],
  ] as const;

  for (const [path, expected] of cases) {
    expect(Bun.file(path).type).toBe(expected);
  }
});

test("explicit Bun.file content types retain normalization and fallback behavior", () => {
  expect(Bun.file("file.css", { type: "CUSTOM/MimeType; Charset=UTF-8" }).type).toBe(
    "custom/mimetype; charset=utf-8",
  );
  expect(Bun.file("file.css", { type: "" }).type).toBe("text/css;charset=utf-8");
  expect(Bun.file("file.css", { type: "text/\u{1f4a5}" }).type).toBe("text/css;charset=utf-8");
});

test("native MIME lookup keeps its input boundary narrow", () => {
  expect(cottontail.mimeTypeByExtension("css")).toBe("text/css;charset=utf-8");
  expect(cottontail.mimeTypeByExtension("CSS")).toBe("application/octet-stream");
  expect(cottontail.mimeTypeByExtension("\u{1f4a5}")).toBe("application/octet-stream");
  expect(cottontail.mimeTypeByExtension("x".repeat(65))).toBe("application/octet-stream");
  expect(() => cottontail.mimeTypeByExtension(123)).toThrow(TypeError);
});
