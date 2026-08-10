import { expect, test } from "bun:test";

const catCommand = [
  process.execPath,
  "-e",
  'process.stdout.write(require("node:fs").readFileSync(0))',
];

test("Bun.spawn streams a large stdin chunk without blocking output", async () => {
  const input = "x".repeat(1024 * 1024);
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(input);
      controller.close();
    },
  });

  await using process = Bun.spawn(catCommand, {
    stdin: stream,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await process.stdout.text()).toBe(input);
  expect(await process.exited).toBe(0);
}, 15_000);

test("Bun.spawn preserves readable-stream chunk order", async () => {
  const chunks = Array.from({ length: 32 }, (_, index) => `${index}:`.padEnd(8192, "x"));
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });

  await using process = Bun.spawn(catCommand, {
    stdin: stream,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await process.stdout.text()).toBe(chunks.join(""));
  expect(await process.exited).toBe(0);
}, 15_000);

test("Bun.spawn writes a large stdin chunk without blocking output", async () => {
  const input = "z".repeat(1024 * 1024);
  await using process = Bun.spawn(catCommand, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const write = process.stdin.write(input);
  expect(write).toBeInstanceOf(Promise);
  expect(await write).toBe(input.length);
  expect(process.stdin.end()).toBe(0);
  expect(await process.stdout.text()).toBe(input);
  expect(await process.exited).toBe(0);
}, 15_000);

test("Bun.spawn stdin uses the FileSink write and flush contract", async () => {
  await using process = Bun.spawn(catCommand, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const write = process.stdin.write("abc");
  const writeWasAsync = write instanceof Promise;
  expect(await write).toBe(3);
  expect(await process.stdin.flush()).toBe(writeWasAsync ? 0 : 3);
  expect(await process.stdin.flush()).toBe(0);
  expect(await process.stdin.end()).toBe(0);
  expect(await process.stdout.text()).toBe("abc");
  expect(await process.exited).toBe(0);
}, 15_000);

test.skipIf(process.platform === "win32")("async maxBuffer closes output inherited by a descendant", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "exec", "yes"],
    maxBuffer: 256,
    killSignal: "SIGHUP",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await child.exited).toBe(129);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBe("SIGHUP");
  const output = await child.stdout.bytes();
  expect(output.byteLength).toBeGreaterThanOrEqual(256);
  expect(output.byteLength).toBeLessThanOrEqual(1024 * 1024);
  expect(new TextDecoder().decode(output.subarray(0, 256))).toBe("y\n".repeat(128));
  expect(await child.stderr.text()).toBe("");
}, 5_000);

test("async maxBuffer Infinity leaves captured output unlimited", async () => {
  const outputSize = 512 * 1024;
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `require("node:fs").writeSync(1, Buffer.alloc(${outputSize}, "I"))`,
    ],
    maxBuffer: Infinity,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await child.stdout.bytes();
  expect(await child.exited).toBe(0);
  expect(output.byteLength).toBe(outputSize);
  expect(output[0]).toBe("I".charCodeAt(0));
  expect(output.at(-1)).toBe("I".charCodeAt(0));
  expect(await child.stderr.text()).toBe("");
}, 5_000);

test.skipIf(process.platform === "win32")("async timeout closes output inherited by a descendant", async () => {
  const started = Date.now();
  const child = Bun.spawn({
    cmd: [process.execPath, "exec", "sleep 5"],
    timeout: 100,
    killSignal: "SIGHUP",
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await child.exited).toBe(129);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBe("SIGHUP");
  expect(await child.stdout.text()).toBe("");
  expect(await child.stderr.text()).toBe("");
  expect(Date.now() - started).toBeLessThan(2_000);
}, 3_000);

test("Bun.spawn AbortSignal terminates live and pre-aborted subprocesses", async () => {
  async function expectAbortedExit(abortBeforeSpawn: boolean) {
    const controller = new AbortController();
    if (abortBeforeSpawn) controller.abort();

    const started = performance.now();
    await using child = Bun.spawn({
      cmd: [process.execPath, "-e", "await Bun.sleep(100000)"],
      signal: controller.signal,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });

    if (!abortBeforeSpawn) {
      await Bun.sleep(1);
      controller.abort();
    }

    expect(await child.exited).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(5_000);
  }

  await expectAbortedExit(false);
  await expectAbortedExit(true);
}, 10_000);
