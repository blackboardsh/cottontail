import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-bail-junit-"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
  return directory;
}

async function run(directory: string, args: string[]) {
  const child = Bun.spawn({
    cmd: [process.execPath, "test", ...args],
    cwd: directory,
    env: { ...process.env, AGENT: "0", CI: "false", GITHUB_ACTIONS: "" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [, stderrText, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { exitCode, stderrText };
}

function expectJunitReport(outfile: string, names: string[]) {
  expect(existsSync(outfile)).toBe(true);
  const xml = readFileSync(outfile, "utf8");
  expect(xml).toContain("<?xml");
  expect(xml).toContain("<testsuites");
  expect(xml).toContain("</testsuites>");
  for (const name of names) expect(xml).toContain(name);
}

test("--bail writes JUnit reporter outfile", async () => {
  const directory = fixture({
    "fail.test.ts": `
      import { test, expect } from "bun:test";
      test("failing test", () => { expect(1).toBe(2); });
    `,
  });
  try {
    const outfile = join(directory, "results.xml");
    const result = await run(directory, [
      "--bail",
      "--reporter=junit",
      `--reporter-outfile=${outfile}`,
      "fail.test.ts",
    ]);
    expect(result.exitCode, result.stderrText).not.toBe(0);
    expectJunitReport(outfile, ["failing test"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);

test("--bail writes JUnit reporter outfile with multiple files", async () => {
  const directory = fixture({
    "a_pass.test.ts": `
      import { test, expect } from "bun:test";
      test("passing test", () => { expect(1).toBe(1); });
    `,
    "b_fail.test.ts": `
      import { test, expect } from "bun:test";
      test("another failing test", () => { expect(1).toBe(2); });
    `,
  });
  try {
    const outfile = join(directory, "results.xml");
    const result = await run(directory, [
      "--bail",
      "--reporter=junit",
      `--reporter-outfile=${outfile}`,
    ]);
    expect(result.exitCode, result.stderrText).not.toBe(0);
    expectJunitReport(outfile, ["passing test", "another failing test"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
