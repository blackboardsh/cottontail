import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CI snapshot failures include Bun-compatible context", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-ci-snapshot-diagnostics-"));
  try {
    writeFileSync(join(directory, "diagnostics.test.ts"), `
import { expect, test } from "bun:test";

test("new external", () => {
  expect("external value").toMatchSnapshot();
});

test("new inline", () => {
  expect("inline value").toMatchInlineSnapshot();
});
`);

    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", "diagnostics.test.ts"],
      cwd: directory,
      env: { ...process.env, CI: "1", GITHUB_ACTIONS: "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = new TextDecoder().decode(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Snapshot creation is disabled in CI environments");
    expect(stderr).toContain('Snapshot name: "new external 1"');
    expect(stderr).toContain('Received: "external value"');
    expect(stderr).toContain("Inline snapshot creation is disabled in CI environments");
    expect(stderr).toContain('Received: "inline value"');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
