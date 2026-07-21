import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "cottontail-process-stdin-"));

afterAll(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

test("Bun.file stdin has file-backed process stream semantics", async () => {
  const inputPath = join(temporaryDirectory, "stdin.txt");
  writeFileSync(inputPath, "file-backed stdin\n");

  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "-e",
      `
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        console.log(JSON.stringify({
          ref: typeof process.stdin.ref,
          unref: typeof process.stdin.unref,
          text: Buffer.concat(chunks).toString(),
        }));
      `,
    ],
    stdin: Bun.file(inputPath),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(JSON.parse(stdout)).toEqual({
    ref: "undefined",
    unref: "undefined",
    text: "file-backed stdin\n",
  });
});

test("an exhausted subprocess stream permits one empty conversion", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `process.stdout.write("payload")`],
    stdout: "pipe",
    stderr: "pipe",
  });

  const [firstRead, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(firstRead).toBe("payload");
  expect(child.stdout.locked).toBe(true);
  expect(await child.stdout.text()).toBe("");
  expect(child.stdout.locked).toBe(true);
  let lockedError;
  try {
    await child.stdout.text();
  } catch (error) {
    lockedError = error;
  }
  expect(lockedError).toBeInstanceOf(TypeError);
  expect(lockedError.message).toContain("ReadableStream is locked");
});
