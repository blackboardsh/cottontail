import { expect, test } from "bun:test";
import {
  MessageChannel,
  MessagePort,
  Worker,
  receiveMessageOnPort,
} from "node:worker_threads";

function onceEvent(target: { once(name: string, handler: (...args: any[]) => void): unknown }, name: string) {
  return new Promise<any[]>(resolve => target.once(name, (...args: any[]) => resolve(args)));
}

test("MessagePort preserves FIFO delivery and receiveMessageOnPort can consume queued messages", async () => {
  const { port1, port2 } = new MessageChannel();
  const delivered: unknown[] = [];
  port2.on("message", value => delivered.push(value));

  port1.postMessage({ sequence: 1 });
  port1.postMessage({ sequence: 2 });

  expect(receiveMessageOnPort(port2)).toEqual({ message: { sequence: 1 } });
  expect(receiveMessageOnPort(port2)).toEqual({ message: { sequence: 2 } });
  expect(receiveMessageOnPort(port2)).toBeUndefined();
  await Promise.resolve();
  expect(delivered).toEqual([]);
  expect(() => receiveMessageOnPort(null as any)).toThrow();
});

test("worker eval can load runtime builtins and reports typed errors", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     const process = require("node:process");
     parentPort.postMessage({ execPath: process.execPath, isMainThread: require("worker_threads").isMainThread });`,
    { eval: true },
  );
  const [message] = await onceEvent(worker, "message");
  expect(message.execPath).toBe(process.execPath);
  expect(message.isMainThread).toBe(false);
  await worker.terminate();

  const throwing = new Worker(`throw new TypeError("worker failure")`, { eval: true });
  const [error] = await onceEvent(throwing, "error");
  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toBe("worker failure");
  await throwing.terminate();
});

test("worker eval reports Bun-compatible module and syntax diagnostics", async () => {
  const missing = new Worker(`require("./cottontail-worker-missing-fixture.js")`, { eval: true });
  const [missingError] = await onceEvent(missing, "error");
  expect(String(missingError)).toContain(
    "error: Cannot find module './cottontail-worker-missing-fixture.js' from 'blob:",
  );
  expect(missingError.code).toBe("MODULE_NOT_FOUND");
  await missing.terminate();

  const invalid = new Worker(`postMessage(throw new Error("boom"))`, { eval: true });
  const [syntaxError] = await onceEvent(invalid, "error");
  expect(String(syntaxError)).toContain("error: Unexpected throw");
  await invalid.terminate();
});

test("workerData transfers MessagePort identity and messages", async () => {
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(
    `const { MessagePort, workerData } = require("node:worker_threads");
     workerData.postMessage({ isPort: workerData instanceof MessagePort, value: 42 });`,
    { eval: true, workerData: port2, transferList: [port2] },
  );
  const [message] = await onceEvent(port1, "message");
  expect(message).toEqual({ isPort: true, value: 42 });
  await worker.terminate();
});

test("Atomics.waitAsync yields until a worker notifies shared memory", async () => {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  expect(() => Atomics.waitAsync(new Int32Array(1), 0, 0, 0)).toThrow();
  expect(Atomics.waitAsync(view, 0, 1)).toEqual({ async: false, value: "not-equal" });
  expect(Atomics.waitAsync(view, 0, "0" as any, 0)).toEqual({ async: false, value: "timed-out" });

  const notifyWins = Atomics.waitAsync(view, 0, 0, 10);
  expect(notifyWins.async).toBe(true);
  expect(Atomics.notify(view, 0, 1)).toBe(1);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  expect(Atomics.notify(view, 0, 1)).toBe(0);
  expect(await notifyWins.value).toBe("ok");

  const expiring = Atomics.waitAsync(view, 0, 0, 10);
  expect(expiring.async).toBe(true);
  expect(await expiring.value).toBe("timed-out");
  expect(Atomics.notify(view, 0, 1)).toBe(0);

  const waiting = Atomics.waitAsync(view, 0, 0, 15_000);
  expect(waiting.async).toBe(true);
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const notified = Atomics.notify(new Int32Array(workerData), 0, 1);
     parentPort.postMessage(notified);`,
    { eval: true, workerData: shared },
  );
  const message = onceEvent(worker, "message");
  expect(await waiting.value).toBe("ok");
  expect((await message)[0]).toBe(1);
  expect(Atomics.load(view, 0)).toBe(0);
  await worker.terminate();
}, 20_000);

test("creating a Worker emits process worker asynchronously", async () => {
  const event = onceEvent(process, "worker");
  const worker = new Worker("", { eval: true });
  const [emittedWorker] = await event;
  expect(emittedWorker).toBe(worker);
  await worker.terminate();
});
