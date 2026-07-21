import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function runChild(directory: string, args: string[] = []) {
  return Bun.spawnSync({
    cmd: [process.execPath, "test", "reporter.test.ts", ...args],
    cwd: directory,
    env: { ...process.env, CI: "false", GITHUB_ACTIONS: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function stderrText(result: ReturnType<typeof Bun.spawnSync>) {
  return new TextDecoder().decode(result.stderr);
}

test("reports committed external and inline snapshot additions", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-snapshot-reporter-added-"));
  try {
    writeFileSync(join(directory, "reporter.test.ts"), `
import { expect, test } from "bun:test";

test("adds snapshots", () => {
  expect("external").toMatchSnapshot();
  expect("inline").toMatchInlineSnapshot();
});
`);

    const result = runChild(directory);
    const stderr = stderrText(result);
    expect(result.exitCode, stderr).toBe(0);
    expect(stderr).toContain("snapshots: +2 added");
    expect(stderr).not.toContain("2 snapshots,");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reports passed, added, and failed snapshot outcomes", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-snapshot-reporter-outcomes-"));
  try {
    writeFileSync(join(directory, "reporter.test.ts"), `
import { expect, test } from "bun:test";

test("snapshot outcomes", () => {
  expect("existing").toMatchSnapshot();
  expect("new").toMatchSnapshot();
  expect("mismatch").toMatchSnapshot();
});
`);
    mkdirSync(join(directory, "__snapshots__"));
    writeFileSync(join(directory, "__snapshots__/reporter.test.ts.snap"), `// Bun Snapshot v1, https://bun.sh/docs/test/snapshots

exports[\`snapshot outcomes 1\`] = \`"existing"\`;
exports[\`snapshot outcomes 3\`] = \`"expected"\`;
`);

    const result = runChild(directory);
    const stderr = stderrText(result);
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("snapshots: 1 passed, +1 added, 1 failed");
    expect(stderr).not.toContain("3 snapshots,");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps Bun's compact summary when every snapshot passes", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-snapshot-reporter-passed-"));
  try {
    writeFileSync(join(directory, "reporter.test.ts"), `
import { expect, test } from "bun:test";

test("existing snapshot", () => {
  expect("existing").toMatchSnapshot();
});
`);
    mkdirSync(join(directory, "__snapshots__"));
    writeFileSync(join(directory, "__snapshots__/reporter.test.ts.snap"), `// Bun Snapshot v1, https://bun.sh/docs/test/snapshots

exports[\`existing snapshot 1\`] = \`"existing"\`;
`);

    const result = runChild(directory);
    const stderr = stderrText(result);
    expect(result.exitCode, stderr).toBe(0);
    expect(stderr).toContain("1 snapshot, 1 expect() calls");
    expect(stderr).not.toContain("snapshots:");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
