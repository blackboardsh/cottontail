import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bunfig test preload runs for a generated aggregate entrypoint", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-bunfig-preload-"));
  try {
    writeFileSync(
      join(directory, "bunfig.toml"),
      '[test]\npreload = "./preload.ts"\n',
    );
    writeFileSync(
      join(directory, "preload.ts"),
      'globalThis.__cottontailBunfigPreload = "loaded";\n',
    );
    writeFileSync(
      join(directory, "preloaded.test.ts"),
      `import { expect, test } from "bun:test";

test("preloaded", () => {
  expect((globalThis as any).__cottontailBunfigPreload).toBe("loaded");
  console.log("bunfig preload ran");
});
`,
    );

    // A bare filter takes the generated aggregate-entrypoint path in the CLI.
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "preloaded.test.ts"],
      cwd: directory,
      env: { ...process.env, CI: "false" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("bunfig preload ran");
    expect(stderr).toContain("1 pass");
    expect(stderr).toContain("0 fail");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
