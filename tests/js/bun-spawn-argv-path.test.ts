import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Bun.spawn preserves a relative child script path in process.argv", async () => {
  const args = Array.from({ length: 129 }, (_, index) => `arg${index}`);
  const cwd = mkdtempSync(join(tmpdir(), "cottontail-spawn-argv-"));
  const scriptName = "bun-spawn-argv-child.js";
  writeFileSync(
    join(cwd, scriptName),
    "console.log(JSON.stringify({ argv: process.argv, execPath: process.execPath }));\n",
  );
  using cleanup = { [Symbol.dispose]: () => rmSync(cwd, { recursive: true, force: true }) };

  await using child = Bun.spawn([process.execPath, scriptName, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  const { argv, execPath } = JSON.parse(stdout);
  expect(argv).toHaveLength(131);
  expect(argv[0]).toBe(execPath);
  expect(argv[1]).toEndWith(scriptName);
  expect(argv.slice(2)).toEqual(args);
});

test("Bun.spawnSync reports child resource usage", () => {
  const result = Bun.spawnSync([process.execPath, "-e", ""]);

  expect(result.exitCode).toBe(0);
  expect(result.resourceUsage).toBeDefined();
  expect(result.resourceUsage.maxRSS).toBeGreaterThan(0);
  expect(typeof result.resourceUsage.cpuTime.user).toBe("bigint");
  expect(typeof result.resourceUsage.cpuTime.system).toBe("bigint");
  expect(result.resourceUsage.cpuTime.total).toBe(
    result.resourceUsage.cpuTime.user + result.resourceUsage.cpuTime.system,
  );
});
