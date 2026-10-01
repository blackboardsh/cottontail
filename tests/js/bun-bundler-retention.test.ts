import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

test("completed multi-file builds release idle workers' parsing arenas", async () => {
  const child = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "fixtures/bundler-retention.js"),
  ], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const result = JSON.parse(stdout);
  expect(result.outputBytes).toBeGreaterThan(1_000_000);
  // Idle-thread cleanup previously retained roughly 175 MiB for this graph.
  expect(result.growth).toBeLessThan(48 * 1024 * 1024);
}, 60_000);

test("bundle teardown completes independently across runtime workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-concurrent-builds-"));
  const workers: Worker[] = [];
  try {
    await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise<void>((resolve, reject) => {
      const worker = new Worker(join(import.meta.dir, "fixtures/bundler-concurrent-worker.js"), {
        workerData: { index, entry: join(root, `entry${index}.ts`) },
      });
      workers.push(worker);
      let completed = false;
      worker.on("message", message => {
        completed = message === "done";
        if (completed) resolve();
      });
      worker.on("error", reject);
      worker.on("exit", code => {
        if (!completed) reject(new Error(`Build worker ${index} exited before completing (${code})`));
      });
    })));
    expect(workers).toHaveLength(4);
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
