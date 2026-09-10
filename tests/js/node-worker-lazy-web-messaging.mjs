import assert from "node:assert/strict";
import { MessageChannel, Worker, receiveMessageOnPort } from "node:worker_threads";

async function checkMessaging(loadWebGlobals) {
  const label = loadWebGlobals ? "after lazy ReadableStream initialization" : "before lazy web initialization";
  const { port1, port2 } = new MessageChannel();
  const notifyHandle = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const { notifyHandle, port, loadWebGlobals } = workerData;
    const notify = () => {
      Atomics.store(notifyHandle, 0, 1);
      Atomics.notify(notifyHandle, 0);
    };
    try {
      Atomics.store(notifyHandle, 1, 1);
      // File itself exists in the minimal runtime. Its stream() method touches
      // the lazy ReadableStream global, loading the full web runtime after the
      // Node worker's messaging hooks, as Undici does in Miniflare.
      if (loadWebGlobals && typeof new File(["worker"], "message.txt").stream().getReader !== "function") {
        throw new Error("ReadableStream did not initialize correctly");
      }
      port.addEventListener("message", (event) => {
        port.postMessage({ id: event.data.id, value: event.data.value + 1 });
        notify();
        port.close();
      });
      port.start();
      Atomics.store(notifyHandle, 1, 2);
    } catch (error) {
      port.postMessage({ error: String(error), stack: error.stack });
      notify();
      port.close();
    }
  `, {
    eval: true,
    workerData: { notifyHandle, port: port2, loadWebGlobals },
    transferList: [port2],
  });
  let workerError;
  worker.on("error", (error) => { workerError = error; });
  let exitCode;
  const exited = new Promise((resolve) => worker.once("exit", (code) => {
    exitCode = code;
    resolve(code);
  }));
  let cleanupTimer;
  let succeeded = false;
  try {
    port1.postMessage({ id: 42, value: 6 });
    // Match Miniflare's synchronous proxy: the parent cannot process ordinary
    // events until the worker replies and wakes this finite native wait.
    const waited = Atomics.wait(notifyHandle, 0, 0, 10_000);
    const response = receiveMessageOnPort(port1)?.message;
    // Surface startup errors which could not be delivered while waiting.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ifError(workerError);
    assert.notEqual(waited, "timed-out", `${label}: worker stopped handling messages at stage ${Atomics.load(notifyHandle, 1)}`);
    assert.equal(response?.error, undefined, response?.stack || response?.error);
    assert.deepEqual(response, { id: 42, value: 7 }, `${label}: synchronous reply missing`);
    assert.equal(await Promise.race([
      exited,
      new Promise((_, reject) => {
        cleanupTimer = setTimeout(() => reject(new Error(`${label}: worker did not exit after closing its port`)), 2_000);
      }),
    ]), 0);
    succeeded = true;
    console.log(`ok worker messaging ${label}`);
  } finally {
    clearTimeout(cleanupTimer);
    for (const port of [port1, port2]) {
      try {
        port.close();
      } catch (error) {
        // Older runtimes can reject closing a port whose worker exited early.
        // Preserve the primary messaging failure instead of masking it.
        if (succeeded) throw error;
      }
    }
    try {
      if (!succeeded && exitCode === undefined) await Promise.race([
        worker.terminate().then(() => exited),
        new Promise((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error(`${label}: worker cleanup timed out`)), 2_000);
        }),
      ]);
    } finally {
      clearTimeout(cleanupTimer);
    }
  }
}

await checkMessaging(false);
await checkMessaging(true);
console.log("node worker lazy web messaging passed");
