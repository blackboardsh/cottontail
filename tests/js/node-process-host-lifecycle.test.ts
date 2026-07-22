import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const fixtureDirectory = mkdtempSync(join(tmpdir(), "cottontail-process-lifecycle-"));
let fixtureId = 0;

afterAll(() => {
  rmSync(fixtureDirectory, { recursive: true, force: true });
});

async function runSource(source: string) {
  const fixture = join(fixtureDirectory, `fixture-${fixtureId++}.js`);
  writeFileSync(fixture, source);
  const child = Bun.spawn({
    cmd: [process.execPath, fixture],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("beforeExit repeats when a listener schedules referenced work", async () => {
  const result = await runSource(`
    let count = 0;
    process.on("beforeExit", () => {
      console.log("beforeExit", count);
      if (count++ === 0) setTimeout(() => {}, 1);
    });
    process.on("exit", () => console.log("exit", count));
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("beforeExit 0\nbeforeExit 1\nexit 2\n");
});

test("top-level exceptions route through the fatal exception handler", async () => {
  const result = await runSource(`
    process.on("uncaughtExceptionMonitor", error => console.log("monitor", error.message));
    process.on("uncaughtException", error => {
      console.log("caught", error.message);
      process.exitCode = 42;
    });
    throw new Error("host-fatal");
  `);

  expect(result.exitCode).toBe(42);
  expect(result.stdout).toContain("monitor host-fatal\ncaught host-fatal\n");
});

test("an exception from an uncaughtException listener uses fatal exit code 7", async () => {
  const result = await runSource(`
    process.on("uncaughtException", () => { throw new Error("handler-failed"); });
    throw new Error("original");
  `);

  expect(result.exitCode).toBe(7);
  expect(result.stderr).toContain("handler-failed");
});

test("exit listeners can replace a fatal exit code with zero", async () => {
  const result = await runSource(`
    process.on("exit", code => {
      console.log(code, process.exitCode);
      process.exitCode = 0;
    });
    throw new Error("fatal-before-exit");
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe("1 1\n");
});

test.skipIf(process.platform === "win32")("OS signals emit their name and number", async () => {
  const result = await runSource(`
    process.once("SIGUSR1", (name, number) => {
      console.log(name, number);
      process.exit(0);
    });
    process.kill(process.pid, "SIGUSR1");
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe(`SIGUSR1 ${process.binding("constants").os.signals.SIGUSR1}\n`);
});

test.skipIf(process.platform === "win32")("self-signals are queued without OS coalescing", async () => {
  const result = await runSource(`
    const expected = 64;
    let count = 0;
    const deadline = setTimeout(() => process.exit(2), 2000);
    const handler = () => {
      count++;
      if (count === expected) {
        clearTimeout(deadline);
        process.off("SIGINT", handler);
        process.exit(0);
      }
    };
    process.on("SIGINT", handler);
    for (let index = 0; index < expected; index++) process.kill(process.pid, "SIGINT");
  `);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
});

test("memoryUsage arrayBuffers grows with ArrayBuffer backing stores", () => {
  const initial = process.memoryUsage().arrayBuffers;
  const buffer = new ArrayBuffer(16 * 1024 * 1024);
  expect(buffer.byteLength).toBe(16 * 1024 * 1024);
  expect(process.memoryUsage().arrayBuffers).toBeGreaterThanOrEqual(initial + buffer.byteLength);
});
