import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures", "worker-ref-lifecycle-child.js");

type Mode = "ref" | "unref" | "toggle" | "message-port-ref" | "message-port-unref" |
  "broadcast-ref" | "broadcast-unref";

function run(mode: Mode) {
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

test("referenced messaging handles keep the process alive", () => {
  const portOutput = run("message-port-ref");
  expect(portOutput).toContain("message-port-ref:true");
  expect(portOutput).toContain("message-port-ref-finished");

  const broadcastOutput = run("broadcast-ref");
  expect(broadcastOutput).toContain("broadcast-ref");
  expect(broadcastOutput).toContain("broadcast-ref-finished");
});

test("unreferenced messaging handles release process ownership", () => {
  const portOutput = run("message-port-unref");
  expect(portOutput).toContain("message-port-unref:false");
  expect(portOutput).not.toContain("message-port-unref-finished");

  const broadcastOutput = run("broadcast-unref");
  expect(broadcastOutput).toContain("broadcast-unref");
  expect(broadcastOutput).not.toContain("broadcast-unref-finished");
});
