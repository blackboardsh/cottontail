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

test("creating a Worker emits process worker asynchronously", async () => {
  const event = onceEvent(process, "worker");
  const worker = new Worker("", { eval: true });
  const [emittedWorker] = await event;
  expect(emittedWorker).toBe(worker);
  await worker.terminate();
});
