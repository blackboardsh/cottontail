import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function runChild(testFile: string, update: boolean) {
  return Bun.spawnSync({
    cmd: [process.execPath, "test", testFile, ...(update ? ["--update-snapshots"] : [])],
    cwd: dirname(testFile),
    env: { ...process.env, CI: "false" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("concurrent tests retain snapshot ownership while updating and matching", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-concurrent-snapshots-"));
  const testFile = join(directory, "concurrent-child.test.ts");
  try {
    writeFileSync(testFile, `
import { describe, expect, test } from "bun:test";

let ready = 0;
let release;
const gate = new Promise(resolve => { release = resolve; });
async function overlap() {
  ready += 1;
  if (ready === 2) release();
  await gate;
}

describe.concurrent("overlap", () => {
  test("slow owner", async () => {
    await overlap();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect("slow inline").toMatchInlineSnapshot('"stale slow inline"');
    expect(new Promise(resolve => setTimeout(() => resolve("slow promised"), 15)))
      .resolves.toMatchInlineSnapshot('"stale slow promised"');
  });

  test("fast owner", async () => {
    await overlap();
    expect("fast inline").toMatchInlineSnapshot('"stale fast inline"');
    expect(new Promise(resolve => setTimeout(() => resolve("fast promised"), 5)))
      .resolves.toMatchInlineSnapshot('"stale fast promised"');
  });
});
`);

    const update = runChild(testFile, true);
    expect(update.exitCode, new TextDecoder().decode(update.stderr)).toBe(0);

    const updatedSource = readFileSync(testFile, "utf8");
    const slowBlock = updatedSource.slice(
      updatedSource.indexOf('test("slow owner"'),
      updatedSource.indexOf('test("fast owner"'),
    );
    const fastBlock = updatedSource.slice(updatedSource.indexOf('test("fast owner"'));
    expect(slowBlock).toContain('"slow inline"');
    expect(slowBlock).toContain('"slow promised"');
    expect(slowBlock).not.toContain('"fast inline"');
    expect(slowBlock).not.toContain('"fast promised"');
    expect(fastBlock).toContain('"fast inline"');
    expect(fastBlock).toContain('"fast promised"');
    expect(fastBlock).not.toContain('"slow inline"');
    expect(fastBlock).not.toContain('"slow promised"');

    const match = runChild(testFile, false);
    expect(match.exitCode, new TextDecoder().decode(match.stderr)).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
