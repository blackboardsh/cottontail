import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("repeated bare paths return independent URL objects", () => {
  const path = "Z".repeat(1021);
  const first = pathToFileURL(path);
  const second = pathToFileURL(path);

  expect(first).not.toBe(second);
  expect(first.href).toBe(second.href);

  first.pathname = "/changed";
  expect(second.pathname).toEndWith(`/${path}`);
});

test("bare-path resolution cache follows process.cwd()", () => {
  const originalCwd = process.cwd();
  const firstDirectory = mkdtempSync(join(tmpdir(), "cottontail-url-a-"));
  const secondDirectory = mkdtempSync(join(tmpdir(), "cottontail-url-b-"));

  try {
    process.chdir(firstDirectory);
    const firstCwd = process.cwd();
    const first = pathToFileURL("entry.js");
    process.chdir(secondDirectory);
    const secondCwd = process.cwd();
    const second = pathToFileURL("entry.js");

    expect(first.href).not.toBe(second.href);
    expect(first.pathname).toBe(`${firstCwd}/entry.js`);
    expect(second.pathname).toBe(`${secondCwd}/entry.js`);
  } finally {
    process.chdir(originalCwd);
    rmSync(firstDirectory, { recursive: true, force: true });
    rmSync(secondDirectory, { recursive: true, force: true });
  }
});
