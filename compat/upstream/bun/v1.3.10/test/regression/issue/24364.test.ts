import { expect, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("react-tailwind template passes tsc --noEmit", async () => {
  // Read template files from source
  const templateDir = join(import.meta.dir, "../../../src/init/react-tailwind");
  const buildTs = readFileSync(join(templateDir, "build.ts"), "utf8");
  const tsconfigJson = readFileSync(join(templateDir, "tsconfig.json"), "utf8");

  // Create temp directory with template files
  using dir = tempDir("issue-24364", {
    "build.ts": buildTs,
    "tsconfig.json": tsconfigJson,
  });

  // Pin Bun v1.3.10's TypeScript and the package versions available at release.
  await using install = Bun.spawn({
    cmd: [bunExe(), "add", "-d", "typescript@5.9.2", "@types/bun@1.3.9", "bun-plugin-tailwind@0.1.2"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [, , installExitCode] = await Promise.all([install.stdout.text(), install.stderr.text(), install.exited]);
  expect(installExitCode).toBe(0);

  // Run tsc --noEmit (use bunExe() x for cross-platform compatibility)
  await using tsc = Bun.spawn({
    cmd: [bunExe(), "x", "tsc", "--noEmit"],
    cwd: String(dir),
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([tsc.stdout.text(), tsc.stderr.text(), tsc.exited]);

  expect(stderr).toBe("");
  expect(stdout).toBe("");
  expect(exitCode).toBe(0);
}, 20_000);
