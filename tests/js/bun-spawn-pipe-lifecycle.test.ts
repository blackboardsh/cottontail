import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runtimeEnvironment(cacheRoot: string) {
  return { ...process.env, COTTONTAIL_TMP_DIR: cacheRoot };
}

test("spawned eval writers share a launcher and preserve pipe bytes", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "cottontail-spawn-pipe-launcher-"));
  const outputSize = 1024 * 1024;
  const source = [
    `for (let buffer = Buffer.alloc(${outputSize}, "P"); buffer.length > 0;) {`,
    '  const written = require("node:fs").writeSync(1, buffer);',
    "  buffer = buffer.slice(written);",
    "}",
  ].join("\n");

  try {
    const children = Array.from({ length: 16 }, () => Bun.spawn({
      cmd: [process.execPath, "-e", source],
      env: runtimeEnvironment(cacheRoot),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }));
    const outputs = await Promise.all(children.map(async (child, index) => {
      if (index % 2 === 0) {
        expect(await child.exited).toBe(0);
        return child.stdout.blob();
      }
      const blob = await child.stdout.blob();
      expect(await child.exited).toBe(0);
      return blob;
    }));
    for (const output of outputs) expect(output.size).toBe(outputSize);
    for (const child of children) expect(await child.stderr.text()).toBe("");

    const artifactRoot = join(cacheRoot, "cottontail", "cache");
    const launchers = readdirSync(artifactRoot).filter(name =>
      name.startsWith("commonjs-runtime-") && name.endsWith(".mjs")
    );
    expect(launchers.length).toBe(1);
    const launcher = readFileSync(join(artifactRoot, launchers[0]), "utf8");
    expect(launcher).toContain("__ctWriteSync");
    expect(launcher).not.toContain("node/module.js");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}, 15_000);

test("unread process pipes still reach close and release native lifecycle state", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "cottontail-spawn-pipe-unread-"));
  try {
    const children = Array.from({ length: 40 }, () => {
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "-e",
          'require("fs").writeSync(1, Buffer.alloc(10, "X"));',
        ],
        env: runtimeEnvironment(cacheRoot),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
      return { child, closed };
    });
    expect(await Promise.all(children.map(({ child }) => child.exited))).toEqual(
      Array.from({ length: children.length }, () => 0),
    );
    await Promise.all(children.map(({ closed }) => closed));
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}, 15_000);

test("other fs APIs retain the complete CommonJS fallback", async () => {
  const cacheRoot = mkdtempSync(join(tmpdir(), "cottontail-spawn-pipe-fs-fallback-"));
  try {
    const child = Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        [
          'const fs = require("fs");',
          "const size = fs.statSync(process.execPath).size;",
          'fs.writeSync(1, Buffer.from(String(size)));',
        ].join("\n"),
      ],
      env: runtimeEnvironment(cacheRoot),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(Number(await child.stdout.text())).toBeGreaterThan(0);
    expect(await child.exited).toBe(0);
    expect(await child.stderr.text()).toBe("");
  } finally {
    rmSync(cacheRoot, { recursive: true, force: true });
  }
}, 15_000);
