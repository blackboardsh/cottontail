import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function exec(command: string, cwd?: string) {
  return Bun.spawnSync([process.execPath, "exec", command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("direct bun exec preserves quoted and spaced shell arguments", () => {
  const command = String.raw`printf '%s|%s|%s\n' "spaced value" 'single quoted' "double \"quoted\""`;
  const child = exec(command);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe('spaced value|single quoted|double "quoted"\n');
  expect(child.stderr.toString()).toBe("");
});

test("direct bun exec propagates the shell exit status", () => {
  const child = exec("exit 23");

  expect(child.exitCode).toBe(23);
  expect(child.stdout.toString()).toBe("");
  expect(child.stderr.toString()).toBe("");
});

test("direct bun exec does not install the public bun package", () => {
  const cwd = mkdtempSync(join(tmpdir(), "cottontail-exec-fresh-cwd-"));
  const packageJson = JSON.stringify({ name: "exec-fresh-cwd", version: "1.0.0" }, null, 2);
  try {
    writeFileSync(join(cwd, "package.json"), packageJson);
    const child = exec("printf 'fresh-cwd\\n'", cwd);

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("fresh-cwd\n");
    expect(child.stderr.toString()).toBe("");
    expect(readFileSync(join(cwd, "package.json"), "utf8")).toBe(packageJson);
    expect(existsSync(join(cwd, "node_modules", "bun"))).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
