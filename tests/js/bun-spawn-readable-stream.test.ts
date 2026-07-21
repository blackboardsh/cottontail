import { expect, test } from "bun:test";

const catCommand = process.platform === "win32"
  ? ["cmd.exe", "/D", "/S", "/C", "more"]
  : ["/bin/cat"];

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
});

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
});

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
});

test("Bun.spawn stdin uses the FileSink write and flush contract", async () => {
  await using process = Bun.spawn(catCommand, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(process.stdin.write("abc")).toBe(3);
  expect(process.stdin.flush()).toBe(3);
  expect(process.stdin.flush()).toBe(0);
  expect(process.stdin.end()).toBe(0);
  expect(await process.stdout.text()).toBe("abc");
  expect(await process.exited).toBe(0);
});
