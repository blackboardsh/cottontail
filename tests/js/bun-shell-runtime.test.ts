import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

const root = mkdtempSync(join(tmpdir(), "cottontail-shell-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("ports Bun shell escaping", () => {
  expect($.escape("1 2 3")).toBe('"1 2 3"');
  expect($.escape("nice\nlmao")).toBe('"nice\nlmao"');
  expect($.escape("lol $NICE")).toBe('"lol \\$NICE"');
});

test.skipIf(process.platform === "win32")("preserves interpolation quote context and typed-array redirects", async () => {
  const value = "http://www.example.com?candy_name=M&M";
  expect(await $`echo url="${value}"`.text()).toBe(`url=${value}\n`);
  expect(await $`echo url='${value}'`.text()).toBe(`url=${value}\n`);
  expect(await $`FOO=expanded; echo "${"$FOO"}"`.text()).toBe("$FOO\n");

  const stderr = Buffer.alloc(16);
  const redirected = await $`echo problem >&2 2> ${stderr}`.quiet();
  expect(redirected.stderr.byteLength).toBe(0);
  expect(stderr.subarray(0, 8).toString()).toBe("problem\n");

  const stdout = Buffer.alloc(16);
  const builtinRedirect = await $`echo answer > ${stdout}`.quiet();
  expect(builtinRedirect.stdout.byteLength).toBe(0);
  expect(stdout.subarray(0, 7).toString()).toBe("answer\n");
});

test.skipIf(process.platform === "win32")("preserves Blob and typed-array stdin as binary data", async () => {
  expect(await $`cat < ${new Blob(["blob-input"])}`.text()).toBe("blob-input");
  expect(await $`cat < ${new TextEncoder().encode("typed-input")}`.text()).toBe("typed-input");
});

test("parses structured object references eagerly", () => {
  const output = Buffer.alloc(16);
  expect(() => $`echo "answer > ${output}"`).toThrow(
    "JS object reference not allowed in double quotes",
  );
  expect(() => $`${output} | cat`).toThrow('expected a command or assignment but got: "JSObjRef"');
});

test("constructs ShellError with Bun's lazy initialization semantics", () => {
  const error = new $.ShellError();
  expect(error).toBeInstanceOf(Error);
  expect(error).toBeInstanceOf($.ShellError);
  expect(error.name).toBe("Error");
  expect(error.message).toBe("");
  expect(error.exitCode).toBeUndefined();
});

test.skipIf(process.platform === "win32")("shell execution does not block the JavaScript event loop", async () => {
  let timerRan = false;
  const pending = $`sleep 0.05; echo complete`.text();
  setTimeout(() => { timerRan = true; }, 0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(timerRan).toBe(true);
  expect(await pending).toBe("complete\n");
});

test.skipIf(process.platform === "win32")("ported cp builtin participates in command lists", async () => {
  const result = await $`echo payload > source.txt; cp -v source.txt destination.txt`
    .cwd(root)
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe(`${resolve(root, "source.txt")} -> ${resolve(root, "destination.txt")}\n`);
  expect(readFileSync(join(root, "destination.txt"), "utf8")).toBe("payload\n");
});

test.skipIf(process.platform === "win32")("Shell instances keep defaults isolated", async () => {
  const first = new $.Shell().env({ VALUE: "first" });
  const second = new $.Shell().env({ VALUE: "second" });

  expect(await first`echo $VALUE`.text()).toBe("first\n");
  expect(await second`echo $VALUE`.text()).toBe("second\n");
});
