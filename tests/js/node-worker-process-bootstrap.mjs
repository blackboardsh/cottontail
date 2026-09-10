import assert from "node:assert/strict";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

const { port1, port2 } = new MessageChannel();
const notify = new Int32Array(new SharedArrayBuffer(4));
const worker = new Worker(new URL("./fixtures/worker-process-bootstrap.cjs", import.meta.url), {
  argv: ["worker-bootstrap-marker"],
  env: { ...process.env, COTTONTAIL_WORKER_PROCESS_BOOTSTRAP_MARKER: "worker-environment" },
  workerData: { port: port2, notify },
  transferList: [port2],
});
let workerError;
let exitCode;
worker.on("error", error => { workerError = error; });
const exited = new Promise(resolve => worker.once("exit", code => {
  exitCode = code;
  resolve(code);
}));
let timeout;
try {
  // Synchronous callers cannot receive worker error events while waiting, so
  // use a finite wait and make the fixture notify even if initialization fails.
  const waited = Atomics.wait(notify, 0, 0, 10_000);
  const result = receiveMessageOnPort(port1)?.message;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ifError(workerError);
  assert.notEqual(waited, "timed-out", "file worker did not reply");
  assert.equal(result?.error, undefined, result?.stack || result?.error);
  assert.deepEqual(result, {
    cwd: process.cwd(),
    pid: process.pid,
    arch: process.arch,
    execPathType: "string",
    nextTickType: "function",
    hrtimeBigintType: "function",
    targetArch: process.arch,
    marker: "worker-environment",
    args: ["worker-bootstrap-marker"],
  });
  assert.equal(await Promise.race([
    exited,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("file worker did not exit")), 2_000);
    }),
  ]), 0);
  console.log("node worker process bootstrap passed");
} finally {
  clearTimeout(timeout);
  port1.close();
  if (exitCode === undefined) await worker.terminate();
}
