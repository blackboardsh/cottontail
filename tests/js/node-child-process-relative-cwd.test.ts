import { afterAll, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

const root = mkdtempSync(join(process.cwd(), ".cottontail-child-cwd-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

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
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const stdout = await new Response(child.stdout).text();

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
