import { afterAll, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = mkdtempSync(join(process.cwd(), ".cottontail-child-cwd-"));

afterAll(async () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
});

test("relative executable paths are resolved from the requested cwd", async () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  const executable = join(bin, process.platform === "win32" ? "cottontail.exe" : "cottontail");
  linkSync(process.execPath, executable);

  const child = spawn(`.${process.platform === "win32" ? "\\" : "/"}bin${process.platform === "win32" ? "\\cottontail.exe" : "/cottontail"}`, [
    "-e",
    "process.stdout.write(process.cwd())",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

  let stderr = "";
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toBe(root);
});

test("fast external processes cannot exit before event registration", async () => {
  const children = Array.from({ length: 16 }, () => process.platform === "win32"
    ? spawn("cmd.exe", ["/d", "/s", "/c", "exit 0"], { stdio: "ignore" })
    : spawn("/usr/bin/true", [], { stdio: "ignore" }));

  const exitCodes = await Promise.race([
    Promise.all(children.map(child => new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    }))),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fast child exit event was lost")), 2_000)),
  ]);

  expect(exitCodes).toEqual(Array(16).fill(0));
});

test.skipIf(process.platform !== "win32")("bare executables use the child cwd and case-insensitive PATH", async () => {
  const bin = join(root, "path-bin");
  mkdirSync(bin);
  linkSync(process.execPath, join(bin, "path-probe.exe"));

  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => {
      const upper = name.toUpperCase();
      return upper !== "PATH" && upper !== "PATHEXT";
    }),
  );
  env.pAtH = "path-bin";
  // Node and Bun still try the native .COM/.EXE suffixes when PATHEXT is empty.
  env.PaThExT = "";

  const child = spawn("path-probe", ["-p", "process.cwd()"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const exitCode = await exit;

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout.trim()).toBe(root);
}, 15_000);
