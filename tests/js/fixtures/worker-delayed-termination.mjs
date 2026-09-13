import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

const mode = process.argv[2];
assert.ok(["top-level", "message-handler", "web-message-handler"].includes(mode), "expected a worker execution mode");
const webMode = mode === "web-message-handler";
if (webMode) await import("bun");
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function bounded(promise, label, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
function message(worker) {
  return bounded(new Promise((resolve, reject) => {
    if (!webMode) {
      worker.once("message", resolve);
      worker.once("error", reject);
    } else {
      const receive = (event) => { cleanup(); resolve(event.data); };
      const fail = (event) => { cleanup(); reject(new Error(event.message || "Web Worker failed")); };
      const cleanup = () => { worker.removeEventListener("message", receive); worker.removeEventListener("error", fail); };
      worker.addEventListener("message", receive);
      worker.addEventListener("error", fail);
    }
  }), "worker response");
}
async function ping(worker, value) {
  const response = message(worker);
  worker.postMessage(value);
  assert.deepEqual(await response, { echo: value });
}

const echoSource = `
  const { parentPort } = require("node:worker_threads");
  parentPort.on("message", value => parentPort.postMessage({ echo: value }));
  parentPort.postMessage("ready");
`;
function webWorker(source) {
  return new globalThis.Worker(`data:text/javascript,${encodeURIComponent(source)}`, { type: "module" });
}
function echoWorker() {
  return webMode ? webWorker(`import "bun"; self.onmessage = event => postMessage({ echo: event.data }); postMessage("ready");`)
    : new Worker(echoSource, { eval: true });
}
function stop(worker, label) {
  if (!webMode) return bounded(worker.terminate(), label);
  const exit = new Promise((resolve) => worker.addEventListener("exit", (event) => resolve(event.code)));
  assert.equal(worker.terminate(), undefined);
  return bounded(exit, label);
}
const loopBody = `
  Atomics.store(progress, 0, 1);
  let spin = 0;
  for (;;) {
    spin = (spin + 1) | 0;
    if ((spin & 0xffff) === 0) Atomics.add(progress, 1, 1);
  }
`;
const loopSource = `
  const { parentPort, workerData } = require("node:worker_threads");
  const progress = new Int32Array(workerData);
  function run() { ${loopBody} }
  ${mode === "message-handler" ? 'parentPort.once("message", run); parentPort.postMessage("ready");' : 'parentPort.postMessage("ready"); run();'}
`;

// The surrounding Node driver owns this process and enforces a hard deadline.
// Do not depend on the very termination operation being tested to bound failure.
try {
  const companion = echoWorker();
  assert.equal(await message(companion), "ready");
  const progress = webMode ? null : new Int32Array(new SharedArrayBuffer(8));
  const busy = webMode
    ? webWorker(`import "bun"; self.onmessage = () => { postMessage("started"); for (;;) {} }; postMessage("ready");`)
    : new Worker(loopSource, { eval: true, workerData: progress.buffer });
  let exitEvents = 0;
  let reportedExit;
  const exited = new Promise((resolve) => {
    const onExit = (code) => { exitEvents++; reportedExit = code; resolve(code); };
    if (webMode) busy.addEventListener("exit", (event) => onExit(event.code));
    else busy.on("exit", onExit);
  });
  assert.equal(await message(busy), "ready");
  if (mode === "message-handler") busy.postMessage("start");
  if (webMode) {
    const started = message(busy);
    busy.postMessage("start");
    assert.equal(await started, "started");
  } else {
    await bounded((async () => {
      while (Atomics.load(progress, 0) !== 1 || Atomics.load(progress, 1) < 8) await sleep(5);
    })(), "worker entering continuous JavaScript");
  }

  const startedAt = webMode ? null : Atomics.load(progress, 1);
  let mainTicks = 0;
  const heartbeat = setInterval(() => mainTicks++, 20);
  // Terminating at the first shared-memory update can beat the first watchdog
  // callback. Keep this same invocation running through multiple time budgets.
  for (let index = 0; index < 5; index++) {
    await ping(companion, `during-loop-${index}`);
    await sleep(100);
  }
  assert.ok(mainTicks >= 5, "main event loop must remain responsive during runaway worker execution");
  if (!webMode) assert.ok(Atomics.load(progress, 1) > startedAt, "the worker must remain actively executing before termination");
  console.log(JSON.stringify({ stage: "terminate-requested", mode, mainTicks, counter: webMode ? null : Atomics.load(progress, 1) }));

  const terminationStarted = Date.now();
  const result = busy.terminate();
  if (webMode) assert.equal(result, undefined, "the Web Worker API reports completion through its exit event");
  assert.equal(busy.terminate(), result, "repeated termination must preserve the API result (including Node's pending Promise)");
  const terminate = webMode ? exited : result;
  const [terminated] = await Promise.all([
    bounded(terminate, "delayed runaway termination").then((code) => ({ code, milliseconds: Date.now() - terminationStarted })),
    ping(companion, "while-terminating"),
  ]);
  assert.equal(terminated.code, 1);
  assert.ok(terminated.milliseconds <= 3000, `termination blocked or settled too late: ${terminated.milliseconds}ms`);
  assert.equal(await bounded(exited, "worker exit event"), 1);
  assert.equal(busy.threadId, -1);
  assert.equal(reportedExit, 1);
  const stoppedAt = webMode ? null : Atomics.load(progress, 1);
  await sleep(100);
  if (!webMode) assert.equal(Atomics.load(progress, 1), stoppedAt, "termination must stop JavaScript before resolving or reporting exit");
  assert.equal(exitEvents, 1, "termination must emit exactly one exit event");
  clearInterval(heartbeat);
  await ping(companion, "after-termination");
  assert.equal(await stop(companion, "companion termination"), 1);

  const replacement = echoWorker();
  assert.equal(await message(replacement), "ready");
  await ping(replacement, "new-worker-after-termination");
  assert.equal(await stop(replacement, "replacement termination"), 1);
  console.log(JSON.stringify({ stage: "passed", mode, exitEvents, stoppedAt, mainTicks, terminationMs: terminated.milliseconds }));
} catch (error) {
  console.error(error?.stack || error);
  process.exit(1);
}
