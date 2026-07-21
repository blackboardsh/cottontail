import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures", "worker-ref-lifecycle-child.js");

function run(mode: "ref" | "unref" | "toggle") {
  const child = Bun.spawnSync({
    cmd: [process.execPath, fixture, mode],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  return child.stdout.toString();
}

test("referenced workers keep the parent alive through natural exit", () => {
  const output = run("ref");
  expect(output).toContain("ref:true");
  expect(output).toContain("worker-ref-finished");
});

test("unreferenced workers do not keep the parent alive", () => {
  const output = run("unref");
  expect(output).toContain("unref:false");
  expect(output).not.toContain("worker-unref-finished");
});

test("ref restores parent-loop ownership before worker startup completes", () => {
  const output = run("toggle");
  expect(output).toContain("toggle:true");
  expect(output).toContain("worker-toggle-finished");
});
