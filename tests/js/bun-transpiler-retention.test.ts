import { expect, test } from "bun:test";
import { join } from "node:path";

for (const operation of ["scan", "transform"]) {
  test(`standalone ${operation} releases nested parser allocations`, async () => {
    // Measure in a separate process so other tests cannot distort native RSS.
    // This input exceeds the JS transform cache limit and exercises the parser
    // repeatedly. Warm once to allow reusable AST stores and JIT code to settle.
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "fixtures/transpiler-retention.js"),
      operation,
    ], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    // The old implementation retains hundreds of MB across these operations.
    // Leave room for allocator/JIT variation without permitting linear growth.
    expect(result.growth).toBeLessThan(48 * 1024 * 1024);
  }, 60_000);
}
