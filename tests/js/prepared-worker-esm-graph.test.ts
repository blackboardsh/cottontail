import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const root = mkdtempSync(join(tmpdir(), "cottontail-worker-esm-graph-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("module workers link a multi-file ESM graph before execution", async () => {
  const moduleCount = 48;
  for (let index = moduleCount - 1; index >= 0; index -= 1) {
    const source = index === moduleCount - 1
      ? "export const value = 1;\n"
      : [
          `import { value as next } from "./module-${index + 1}.js";`,
          "export const value = next + 1;",
          "",
        ].join("\n");
    writeFileSync(join(root, `module-${index}.js`), source);
  }

  const entry = join(root, "worker.js");
  writeFileSync(entry, [
    'import { parentPort } from "node:worker_threads";',
    'import { value } from "./module-0.js";',
    "parentPort.postMessage(value);",
    "",
  ].join("\n"));

  const value = await new Promise<number>((resolve, reject) => {
    const worker = new Worker(entry);
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });

  expect(value).toBe(moduleCount);
});
