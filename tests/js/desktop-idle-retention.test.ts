import { expect, test } from "bun:test";
import { join } from "node:path";

test("desktop idle cleanup releases late bootstrap garbage and preserves live state", async () => {
  const child = Bun.spawn([
    process.execPath,
    "--smol",
    join(import.meta.dir, "fixtures/desktop-idle-retention.js"),
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ collected: true, live: "still-live" });
}, 30_000);
