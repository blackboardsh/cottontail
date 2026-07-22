import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const root = mkdtempSync(join(tmpdir(), "cottontail-dynamic-esm-graph-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("workers load dynamic ESM graphs as one cached module graph", async () => {
  const moduleCount = 64;
  const shared = join(root, "shared.js");
  writeFileSync(shared, [
    "globalThis.__dynamicGraphExecutions = (globalThis.__dynamicGraphExecutions ?? 0) + 1;",
    "export const token = {};",
    "export const executions = globalThis.__dynamicGraphExecutions;",
    "",
  ].join("\n"));

  for (let index = moduleCount - 1; index >= 0; index -= 1) {
    const dependency = index === moduleCount - 1 ? "./shared.js" : `./module-${index + 1}.js`;
    const imported = index === moduleCount - 1 ? "executions as next" : "value as next";
    writeFileSync(join(root, `module-${index}.js`), [
      `import { ${imported} } from ${JSON.stringify(dependency)};`,
      "export const value = next + 1;",
      "",
    ].join("\n"));
  }

  const entry = join(root, "entry.js");
  writeFileSync(entry, [
    'import { value } from "./module-0.js";',
    'import { token } from "./shared.js";',
    "export { token, value };",
    "",
  ].join("\n"));

  const workerPath = join(root, "worker.js");
  writeFileSync(workerPath, [
    'import { parentPort, workerData } from "node:worker_threads";',
    'import { pathToFileURL } from "node:url";',
    "const entryUrl = pathToFileURL(workerData.entry).href;",
    "const sharedUrl = pathToFileURL(workerData.shared).href;",
    'const first = await import(`${entryUrl}?graph=first`);',
    "const shared = await import(sharedUrl);",
    "parentPort.postMessage({",
    "  value: first.value,",
    "  sharedIdentity: first.token === shared.token,",
    "  executions: shared.executions,",
    "  namespaceTag: Object.prototype.toString.call(first),",
    "});",
    "",
  ].join("\n"));

  const runWorker = () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: { entry, shared } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });

  for (const result of [await runWorker(), await runWorker()]) {
    expect(result).toEqual({
      value: moduleCount + 1,
      sharedIdentity: true,
      executions: 1,
      namespaceTag: "[object Module]",
    });
  }
});

test("workers link package graphs containing transitive top-level await", async () => {
  const packageRoot = join(root, "node_modules", "async-graph-package");
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "async-graph-package",
    type: "module",
    exports: "./index.js",
  }));
  writeFileSync(join(packageRoot, "index.js"), [
    'import { executions, value } from "./tla.js";',
    "export { executions, value };",
    "",
  ].join("\n"));
  writeFileSync(join(packageRoot, "tla.js"), [
    "await Promise.resolve();",
    "globalThis.__asyncPackageExecutions = (globalThis.__asyncPackageExecutions ?? 0) + 1;",
    "export const value = 42;",
    "export const executions = globalThis.__asyncPackageExecutions;",
    "",
  ].join("\n"));

  const entry = join(root, "async-entry.js");
  writeFileSync(entry, [
    'import { executions, value } from "async-graph-package";',
    "export { executions, value };",
    "",
  ].join("\n"));

  const workerPath = join(root, "async-worker.js");
  writeFileSync(workerPath, [
    'import { parentPort, workerData } from "node:worker_threads";',
    'import { pathToFileURL } from "node:url";',
    "const entryUrl = pathToFileURL(workerData).href;",
    'const namespace = await import(`${entryUrl}?linked-async`);',
    "parentPort.postMessage({",
    "  value: namespace.value,",
    "  executions: namespace.executions,",
    "  namespaceTag: Object.prototype.toString.call(namespace),",
    "});",
    "",
  ].join("\n"));

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const worker = new Worker(workerPath, { workerData: entry });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", code => {
      if (code !== 0) reject(new Error(`worker exited with code ${code}`));
    });
  });

  expect(result).toEqual({
    value: 42,
    executions: 1,
    namespaceTag: "[object Module]",
  });
});
