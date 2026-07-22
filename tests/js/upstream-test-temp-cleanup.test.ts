import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");
const preloadPath = join(
  repoRoot,
  "compat",
  "upstream",
  "cottontail-bun-test-preload.ts",
).replaceAll("\\", "/");

function runFixture(fails: boolean, flags: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cottontail-upstream-temp-test-"));
  const fixture = join(root, "fixture");
  const managedBase = join(root, "managed");
  const sentinel = join(root, "user-owned");
  mkdirSync(fixture);
  mkdirSync(managedBase);
  mkdirSync(sentinel);
  writeFileSync(join(sentinel, "keep.txt"), "not owned by the test runner");
  writeFileSync(join(fixture, "bunfig.toml"), `[test]\npreload = ${JSON.stringify(preloadPath)}\n`);
  writeFileSync(
    join(fixture, "sample.test.ts"),
    `import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("temporary fixture", () => {
  const directory = mkdtempSync(join(realpathSync.native(tmpdir()), "bun.test."));
  writeFileSync(join(directory, "payload.txt"), "temporary");
  expect(true).toBe(${fails ? "false" : "true"});
});
`,
  );

  const env = {
    ...process.env,
    COTTONTAIL_RUNTIME_MODULES_DIR: join(repoRoot, "src", "runtime_modules"),
    COTTONTAIL_UPSTREAM_TMPDIR: managedBase,
    ...flags,
  };
  delete env.COTTONTAIL_UPSTREAM_TEMP_OWNER;
  if (!("COTTONTAIL_UPSTREAM_KEEP_TEMP" in flags)) delete env.COTTONTAIL_UPSTREAM_KEEP_TEMP;
  if (!("COTTONTAIL_KEEP_TEMP" in flags)) delete env.COTTONTAIL_KEEP_TEMP;
  if (!("DEBUG" in flags)) delete env.DEBUG;

  const result = Bun.spawnSync([process.execPath, "test", "sample.test.ts", "--max-concurrency", "1"], {
    cwd: fixture,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return { root, managedBase, sentinel, result, stderr: String(result.stderr) };
}

for (const [label, fails] of [["passing", false], ["failing", true]] as const) {
  test(`${label} upstream runs remove only their owned temp root`, () => {
    const run = runFixture(fails);
    try {
      expect(run.result.exitCode, run.stderr).toBe(fails ? 1 : 0);
      expect(readdirSync(run.managedBase)).toEqual([]);
      expect(existsSync(join(run.sentinel, "keep.txt"))).toBe(true);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });
}

for (const [label, flags] of [
  ["upstream keep-temp", { COTTONTAIL_UPSTREAM_KEEP_TEMP: "1" }],
  ["runtime keep-temp", { COTTONTAIL_KEEP_TEMP: "1" }],
  ["debug", { DEBUG: "1" }],
] as const) {
  test(`${label} preserves the owned temp root`, () => {
    const run = runFixture(false, flags);
    try {
      expect(run.result.exitCode, run.stderr).toBe(0);
      const roots = readdirSync(run.managedBase);
      expect(roots.length, `${JSON.stringify(roots)}\n${run.stderr}`).toBe(1);
      expect(roots[0].startsWith("cottontail-bun-tests-")).toBe(true);
      expect(readdirSync(join(run.managedBase, roots[0])).some(name => name.startsWith("bun.test."))).toBe(true);
      expect(existsSync(join(run.sentinel, "keep.txt"))).toBe(true);
      expect(run.stderr).toContain("kept upstream temp root:");
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });
}
