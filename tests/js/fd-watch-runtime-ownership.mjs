import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

assert.equal(typeof cottontail?.fdWatchStart, "function", "This regression requires the native Cottontail runtime");

function createWatch() {
  const { fd } = cottontail.udpSocketCreate(4, false, false, false);
  try {
    cottontail.udpSocketBind(fd, 0, "127.0.0.1", 4);
    const { id } = cottontail.fdWatchStart(fd, 1, true, false, true);
    return { fd, id };
  } catch (error) {
    cottontail.udpSocketClose(fd);
    throw error;
  }
}

function checkOwnerMutations(id) {
  assert.equal(cottontail.fdWatchSetRef(id, false), true);
  assert.equal(cottontail.fdWatchSetRef(id, true), true);
  assert.equal(cottontail.fdWatchSetPaused(id, true), true);
  assert.equal(cottontail.fdWatchSetWritable(id, true), true);
  assert.equal(cottontail.fdWatchSetWritable(id, false), true);
  assert.equal(cottontail.fdWatchSetPaused(id, false), true);
}

if (!isMainThread) {
  const foreignId = workerData.watchId;
  // First use an idempotent ref(true) against an already referenced watch.
  // On the old implementation this returns true, failing before the unsafe
  // foreign-loop stop/pause calls. Run this fixture in a disposable process.
  assert.equal(cottontail.fdWatchSetRef(foreignId, true), false, "A worker must not ref another runtime's watcher");
  assert.equal(cottontail.fdWatchSetRef(foreignId, false), false);
  assert.equal(cottontail.fdWatchSetPaused(foreignId, true), false);
  assert.equal(cottontail.fdWatchSetWritable(foreignId, true), false);
  assert.equal(cottontail.fdWatchStop(foreignId), false);

  const own = createWatch();
  try {
    checkOwnerMutations(own.id);
    assert.equal(cottontail.fdWatchStop(own.id), true, "The worker can stop its own watcher");
    assert.equal(cottontail.fdWatchStop(own.id), false);
  } finally {
    cottontail.fdWatchStop(own.id);
    cottontail.udpSocketClose(own.fd);
  }
  parentPort.postMessage("foreign mutations refused; owner mutations succeeded");
  parentPort.close();
} else {
  const own = createWatch();
  let worker;
  let timer;
  let stopped = false;
  let exited = false;
  try {
    worker = new Worker(new URL(import.meta.url), { workerData: { watchId: own.id } });
    const result = new Promise((resolve, reject) => {
      // Full file-worker bootstrap on Windows x64 emulation is independently
      // slow. This is a startup bound, not a network/request timeout change.
      timer = setTimeout(() => reject(new Error("Watcher ownership worker timed out")), process.platform === "win32" ? 45000 : 15000);
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.once("exit", (code) => {
        exited = true;
        reject(new Error(`Watcher ownership worker exited ${code} before responding`));
      });
    });
    assert.equal(await result, "foreign mutations refused; owner mutations succeeded");
    clearTimeout(timer);
    checkOwnerMutations(own.id);

    // Return values alone are insufficient: the owner's watch must still
    // deliver real readiness after every attempted foreign mutation.
    const payload = new TextEncoder().encode("owner remains live: \u65e5\u672c\u8a9e \ud83c\udf0a");
    const received = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Owner watcher stopped receiving datagrams")), 5000);
      cottontail.fdSetEventHandler((event) => {
        if (event.id !== own.id) return;
        if (event.type === "error") { reject(new Error(event.message)); return; }
        if (event.type !== "readable") return;
        try {
          const packet = cottontail.udpSocketReceive(own.fd, 65536);
          if (packet) resolve(packet.data);
          else cottontail.fdWatchSetPaused(own.id, false);
        } catch (error) { reject(error); }
      });
    });
    cottontail.udpSocketSend(own.fd, payload, cottontail.udpSocketAddress(own.fd).port, "127.0.0.1", 4);
    assert.deepEqual(Array.from(new Uint8Array(await received)), Array.from(payload));
    assert.equal(cottontail.fdWatchStop(own.id), true, "The original owner can still stop its watcher");
    stopped = true;
    assert.equal(cottontail.fdWatchStop(own.id), false);
    for (const method of ["fdWatchSetRef", "fdWatchSetPaused", "fdWatchSetWritable"]) {
      assert.equal(cottontail[method](own.id, true), false, `${method} must reject a stopped watcher`);
    }
    console.log("fd watch runtime ownership passed");
  } finally {
    clearTimeout(timer);
    if (worker && !exited) await worker.terminate();
    if (!stopped) cottontail.fdWatchStop(own.id);
    cottontail.udpSocketClose(own.fd);
  }
}
