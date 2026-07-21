import { afterAll, expect, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "bun-shell-subshell-background-"));

afterAll(() => rmSync(root, { force: true, recursive: true }));

test.skipIf(process.platform === "win32")("subshell background FIFO writers join at the parent shell", async () => {
  const output = await $`
    mkfifo fifo
    (echo payload >fifo &)
    cat fifo
  `.cwd(root).quiet().nothrow();

  expect(output.exitCode).toBe(0);
  expect(output.stdout.toString()).toBe("payload\n");
  expect(output.stderr.toString()).toBe("");
});
