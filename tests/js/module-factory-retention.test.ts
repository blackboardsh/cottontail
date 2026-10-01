import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("collected factories preserve module identity and can recompile after eviction", async () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-weak-factory-"));
  const path = join(root, "module.cjs");
  const host = (globalThis as any).cottontail;
  const compile = host.compileFunction;
  let count = 0;
  host.compileFunction = (...args: unknown[]) => { count++; return compile(...args); };
  try {
    writeFileSync(path, "module.exports = { value: 42 };\n");
    const first = require(path);
    expect(count).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 0));
    Bun.gc(true);
    expect(require(path)).toBe(first);
    delete require.cache[path];
    const second = require(path);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(count).toBe(2);
    delete require.cache[path];
    writeFileSync(path, "module.exports = { value: 99 };\n");
    expect(require(path).value).toBe(99);
  } finally {
    host.compileFunction = compile;
    delete require.cache[path];
    rmSync(root, { recursive: true, force: true });
  }
});

test("native compilation preserves Unicode, NUL and lone UTF-16 surrogates", () => {
  const compile = (globalThis as any).cottontail.compileFunction;
  for (const value of ["plain ASCII", "café 日本語 🚀", "before\0after", "\ud800", "\udfff"]) {
    // Keep the characters literal so UTF-8 conversion would lose lone surrogates.
    const run = compile('(function () { return "' + value + '"; })', "/tmp/string-storage.js");
    expect(run()).toBe(value);
  }
});

test("native file decoding preserves Unicode, embedded NUL and invalid-byte replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-compact-text-"));
  const path = join(root, "text.txt");
  const read = (globalThis as any).cottontail.readFile;
  try {
    for (const text of ["ASCII", "café 日本語 🚀", "é\0after"]) {
      writeFileSync(path, text);
      expect(read(path)).toBe(text);
    }
    writeFileSync(path, new Uint8Array([0x61, 0xff, 0xe2, 0x82, 0x62]));
    expect(read(path)).toBe("a\ufffd\ufffd\ufffdb");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
