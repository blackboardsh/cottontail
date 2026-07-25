import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "cottontail-console-signals-"));
const repoRoot = join(import.meta.dir, "..", "..");
const zig = join(repoRoot, "vendors", "zig", "zig.exe");
const helperSource = join(import.meta.dir, "fixtures", "windows-console-signal-helper.c");
const helper = join(fixtureDirectory, "windows-console-signal-helper.exe");
const decoder = new TextDecoder();

function run(command: string[]) {
  return Bun.spawnSync({
    cmd: command,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
}

function outputText(output: Uint8Array | undefined) {
  return output == null ? "" : decoder.decode(output);
}

beforeAll(() => {
  const compilation = run([zig, "cc", helperSource, "-O2", "-luser32", "-o", helper]);
  if (compilation.exitCode !== 0) {
    throw new Error(
      `failed to compile Windows console helper (${compilation.exitCode})\n` +
      `${outputText(compilation.stdout)}${outputText(compilation.stderr)}`,
    );
  }
});

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

test("Windows signal listeners do not keep an otherwise-idle process alive", () => {
  const script = join(fixtureDirectory, "unref-listeners.js");
  writeFileSync(
    script,
    `
      process.on("SIGHUP", () => {});
      process.on("SIGINT", () => {});
      process.on("SIGBREAK", () => {});
      console.log("listeners-installed");
    `,
  );

  const child = run([process.execPath, script]);
  expect(child.exitCode).toBe(0);
  expect(outputText(child.stdout)).toBe("listeners-installed\n");
  expect(outputText(child.stderr)).toBe("");
});

test("CTRL_BREAK_EVENT reaches a SIGBREAK listener with Node-compatible arguments", () => {
  const script = join(fixtureDirectory, "sigbreak-listener.js");
  const result = join(fixtureDirectory, "sigbreak-result.json");
  const ready = join(fixtureDirectory, "sigbreak-ready");
  writeFileSync(
    script,
    `
      const { writeFileSync } = require("node:fs");
      const [resultPath, readyPath] = process.argv.slice(2);
      const watchdog = setTimeout(() => process.exit(70), 10_000);
      process.once("SIGBREAK", (...arguments_) => {
        clearTimeout(watchdog);
        writeFileSync(resultPath, JSON.stringify(arguments_));
        process.exit(0);
      });
      writeFileSync(readyPath, "ready");
    `,
  );

  const child = run([helper, process.execPath, script, result, ready]);
  expect(child.exitCode).toBe(0);
  expect(outputText(child.stdout)).toBe("");
  expect(outputText(child.stderr)).toBe("");
  expect(JSON.parse(readFileSync(result, "utf8"))).toEqual(["SIGBREAK"]);
});
