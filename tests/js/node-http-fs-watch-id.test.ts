import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-http-fs-watch-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("fs.watch cannot replace an HTTP listener's descriptor callback", () => {
  const watched = join(root, "watched.txt");
  const entry = join(root, "server.mjs");
  writeFileSync(watched, "initial\n");
  writeFileSync(entry, [
    'import { watch } from "node:fs";',
    'import { createServer } from "node:http";',
    `const watched = ${JSON.stringify(watched)};`,
    'const server = createServer((_request, response) => response.end("ok"));',
    'await new Promise((resolve, reject) => {',
    '  server.once("error", reject);',
    '  server.listen(0, "127.0.0.1", resolve);',
    '});',
    'const watcher = watch(watched, () => {});',
    'const deadline = setTimeout(() => process.exit(2), 5_000);',
    'try {',
    '  const { port } = server.address();',
    '  const response = await fetch(`http://127.0.0.1:${port}/`);',
    '  if (response.status !== 200 || await response.text() !== "ok") process.exit(3);',
    '  console.log("ok");',
    '} finally {',
    '  clearTimeout(deadline);',
    '  watcher.close();',
    '  await new Promise(resolve => server.close(resolve));',
    '}',
    '',
  ].join("\n"));

  const result = Bun.spawnSync({
    cmd: [process.execPath, entry],
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("ok\n");
  expect(result.stderr.toString()).toBe("");
}, 15_000);
