import { expect, test } from "bun:test";
import { join } from "node:path";

async function probe(args: string[] = [], overrides: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("MALLOC_") || key === "GLIBC_TUNABLES" || key.startsWith("COTTONTAIL_") || key.startsWith("JSC_")) delete env[key];
  }
  const child = Bun.spawn([
    process.execPath,
    ...args.filter(arg => arg.startsWith("--")),
    join(import.meta.dir, args.includes("policy")
      ? "fixtures/linux-native-allocator-policy.js"
      : "fixtures/linux-native-allocator-retention.js"),
    ...args.filter(arg => !arg.startsWith("--")),
  ], { env: { ...env, ...overrides }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return JSON.parse(stdout);
}

test.skipIf(process.platform !== "linux")("full GC returns freed glibc arena pages to the OS", async () => {
  // Most of the 128 MiB scratch allocation should be returned despite pins.
  // Leave generous room for JIT, page size, and allocator variation.
  expect((await probe()).reclaimed).toBeGreaterThan(64 * 1024 * 1024);
}, 30_000);

test.skipIf(process.platform !== "linux")("smol idle cleanup returns late native frees without JS heap growth", async () => {
  expect((await probe(["--smol", "idle"])).reclaimed).toBeGreaterThan(64 * 1024 * 1024);
}, 30_000);

test.skipIf(process.platform !== "linux")("smol keeps large native allocations independently reclaimable", async () => {
  expect((await probe(["--smol", "policy"])).mapped).toBe(true);
}, 30_000);

test.skipIf(process.platform !== "linux")("smol respects explicit glibc allocation policy", async () => {
  for (const overrides of [
    { MALLOC_MMAP_THRESHOLD_: "33554432" },
    { GLIBC_TUNABLES: "glibc.malloc.mmap_threshold=33554432" },
  ]) {
    expect((await probe(["--smol", "policy"], overrides)).mapped).toBe(false);
  }
}, 30_000);
