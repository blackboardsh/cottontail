import { expect, test } from "bun:test";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures", "idle-runtime-child.mjs");
// ARM64's interpreter needs time to start both the child and its worker before
// the measured 600 ms idle window. Keep the polling/timer assertions unchanged.
const startupTimeout = process.platform === "win32" && process.arch === "arm64" ? 15_000 : 5_000;

function run(mode: string) {
  const child = Bun.spawnSync({
    cmd: [process.execPath, fixture, mode],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(child.exitCode).toBe(0);
  expect(child.stderr.toString()).toBe("");
  return JSON.parse(child.stdout.toString().trim());
}

for (const mode of ["main", "worker"]) {
  test(`${mode} runtime sleeps between idle turns`, () => {
    const result = run(mode);
    expect(result.elapsed).toBeGreaterThanOrEqual(580);
    // Each turn can poll twice. Allow startup/wake overhead but reject the
    // previous 16 ms cadence (roughly 75 polls during this 600 ms window).
    expect(result.polls).toBeLessThanOrEqual(40);
  }, startupTimeout);
}

test("short native timer deadlines still shorten the idle wait", () => {
  const result = run("timers");
  // A fixed 50 ms sleep instead of deadline-aware waiting would take >=300 ms.
  expect(result.elapsed).toBeLessThan(250);
});
