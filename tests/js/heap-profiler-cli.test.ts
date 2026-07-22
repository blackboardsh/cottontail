import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-heap-profiler-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(args: string[], cwd: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("--heap-prof writes a V8 snapshot at shutdown", () => {
  const directory = join(root, "v8");
  const path = join(directory, "profile.heapsnapshot");
  const child = run([
    "--heap-prof",
    "--heap-prof-dir",
    directory,
    "--heap-prof-name",
    "profile.heapsnapshot",
    "-e",
    "globalThis.heapProfileSentinel = { value: 42 }; console.log('done')",
  ], root);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("done");
  expect(child.stderr.toString()).toContain("Heap profile written to:");
  expect(existsSync(path)).toBe(true);
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  expect(snapshot.snapshot.node_count).toBeGreaterThan(0);
  expect(snapshot.snapshot.edge_count).toBeGreaterThan(0);
  expect(snapshot.nodes.length).toBe(snapshot.snapshot.node_count * 7);
  expect(snapshot.edges.length).toBe(snapshot.snapshot.edge_count * 3);
});

test("--heap-prof-md writes graph-derived markdown", () => {
  const directory = join(root, "markdown");
  const path = join(directory, "profile.md");
  const child = run([
    "--heap-prof-md",
    `--heap-prof-dir=${directory}`,
    "--heap-prof-name=profile.md",
    "-e",
    "globalThis.heapProfileSentinel = new Array(32).fill({ retained: true })",
  ], root);

  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toContain("Heap profile written to:");
  const profile = readFileSync(path, "utf8");
  expect(profile).toContain("# Bun Heap Profile");
  expect(profile).toContain("## Summary");
  expect(profile).toContain("## Top 50 Types by Retained Size");
  expect(profile).toContain("## Retainer Chains");
  expect(profile).toContain("## All Objects");
  expect(profile).toContain("## All Edges");
  expect(profile).toContain("## Complete Type Statistics");
});

test("heap profile path options warn without enabling capture", () => {
  const path = join(root, "disabled.heapsnapshot");
  const child = run(["--heap-prof-name", path, "-e", "console.log('ok')"], root);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString().trim()).toBe("ok");
  expect(child.stderr.toString()).toContain("--heap-prof-name requires --heap-prof or --heap-prof-md to be enabled");
  expect(existsSync(path)).toBe(false);
});
