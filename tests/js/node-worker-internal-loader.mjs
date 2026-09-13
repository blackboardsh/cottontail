import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The full worker bootstrap is evaluated as a script after bundling. Its
// internal runtime loader must not remain as an external node:module import.
const source = `
  const { parentPort } = require("node:worker_threads");
  parentPort.postMessage({
    yaml: Bun.YAML.parse("answer: 42").answer,
    stream: typeof new ReadableStream({ start(controller) { controller.close(); } }).getReader,
  });
`;
const scratch = mkdtempSync(join(tmpdir(), "worker-loader-"));
const workerPath = join(scratch, "worker.mjs");
writeFileSync(workerPath, 'import { createRequire } from "node:module"; const require=createRequire(import.meta.url);\n' + source);
const worker = new Worker(workerPath);
// Full file-worker bootstrap plus first-use YAML takes about 15 seconds on
// Windows ARM running the x64 runtime. Keep a bounded native-emulation budget.
const timeout = process.platform === "win32" ? 45000 : 15000;
let timer;
try {
  const message = await new Promise((resolve, reject) => {
    let received = false;
    timer = setTimeout(() => reject(new Error(`Full worker bootstrap did not respond within ${timeout}ms`)), timeout);
    worker.once("message", (value) => { received = true; resolve(value); });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (!received) reject(new Error(`Worker exited ${code} before responding`));
    });
  });
  assert.deepEqual(message, { yaml: 42, stream: "function" });
  console.log("full worker bootstrap and lazy runtime loader passed");
} finally {
  clearTimeout(timer);
  await worker.terminate();
  rmSync(scratch, { recursive: true, force: true });
}
