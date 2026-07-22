import { expect, test } from "bun:test";
import {
  BroadcastChannel,
  MessageChannel,
  Worker,
  locks,
  moveMessagePortToContext,
} from "node:worker_threads";
import { createContext, runInContext } from "node:vm";

function once(target: any, event: string) {
  return new Promise<any[]>(resolve => target.once(event, (...args: any[]) => resolve(args)));
}

function matchingMessage(target: Worker, predicate: (value: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const onMessage = (value: any) => {
      if (!predicate(value)) return;
      target.off("message", onMessage);
      resolve(value);
    };
    target.on("message", onMessage);
    target.once("error", reject);
  });
}

function streamBuffer(stream: any) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: any) => chunks.push(Buffer.from(chunk)));
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

test("per-worker CPU and profiler APIs expose the native boundary instead of fake data", async () => {
  const worker = new Worker(`setInterval(() => {}, 1000);`, { eval: true });
  await once(worker, "online");
  for (const method of ["cpuUsage", "startCpuProfile", "startHeapProfile"] as const) {
    let error: any;
    try {
      await worker[method]();
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("ERR_COTTONTAIL_NATIVE_BOUNDARY");
  }
  await worker.terminate();
});

test("moving a MessagePort into a shared-realm vm context keeps it functional", async () => {
  const { port1, port2 } = new MessageChannel();
  const context = createContext({});
  context.port = moveMessagePortToContext(port1, context);
  expect(runInContext("port", context)).toBe(port1);
  const received = new Promise(resolve => { context.record = resolve; });
  runInContext("port.onmessage = ({ data }) => record(data)", context);
  port2.postMessage("moved");
  expect(await received).toBe("moved");
});

test("Worker ref state follows native startup and exit lifecycle", async () => {
  const worker = new Worker(`setTimeout(() => {}, 80);`, { eval: true });
  expect(worker.hasRef()).toBe(true);
  expect(worker.unref()).toBe(worker);
  expect(worker.hasRef()).toBe(false);
  expect(worker.ref()).toBe(worker);
  expect(worker.hasRef()).toBe(true);
  await once(worker, "exit");
  expect(worker.hasRef()).toBe(false);
  expect(worker.ref()).toBe(worker);
  expect(worker.hasRef()).toBe(false);
});

test("resourceLimits terminates a worker that exceeds its stock-JSC heap ceiling", async () => {
  const worker = new Worker(`const retained = []; for (;;) retained.push(new ArrayBuffer(1024 * 1024));`, {
    eval: true,
    resourceLimits: { maxOldGenerationSizeMb: 24, stackSizeMb: 2 },
  });
  const error = once(worker, "error");
  const exit = once(worker, "exit");
  expect((await error)[0]).toMatchObject({
    code: "ERR_WORKER_OUT_OF_MEMORY",
    message: "Worker terminated due to reaching memory limit: JS heap out of memory",
  });
  expect((await exit)[0]).toBe(1);
});

test("BroadcastChannel delivers across worker isolates", async () => {
  const channel = new BroadcastChannel("worker-native-boundary");
  const message = new Promise(resolve => { channel.onmessage = event => resolve(event.data); });
  const worker = new Worker(
    `const { BroadcastChannel } = require("node:worker_threads");
     new BroadcastChannel("worker-native-boundary").postMessage("worker");`,
    { eval: true },
  );
  expect(await message).toBe("worker");
  channel.close();
  await worker.terminate();
});

test("natural worker exit emits beforeExit and propagates process.exitCode", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     process.once("beforeExit", code => parentPort.postMessage({ type: "beforeExit", code }));
     process.exitCode = 23;`,
    { eval: true },
  );
  const message = once(worker, "message");
  const exit = once(worker, "exit");
  expect((await message)[0]).toEqual({ type: "beforeExit", code: 23 });
  expect((await exit)[0]).toBe(23);
});

test("hard termination interrupts non-cooperative JavaScript before reporting exit", async () => {
  const progress = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     const progress = new Int32Array(workerData);
     Atomics.store(progress, 0, 1);
     parentPort.postMessage("running");
     let spin = 0;
     for (;;) {
       spin = (spin + 1) | 0;
       if ((spin & 0xfffff) === 0) Atomics.add(progress, 1, 1);
     }`,
    { eval: true, workerData: progress.buffer },
  );
  expect((await once(worker, "message"))[0]).toBe("running");
  while (Atomics.load(progress, 1) === 0) await Bun.sleep(5);

  const exit = once(worker, "exit");
  const first = worker.terminate();
  expect(worker.terminate()).toBe(first);
  expect(await first).toBe(1);
  expect((await exit)[0]).toBe(1);
  expect(worker.threadId).toBe(-1);

  const stoppedAt = Atomics.load(progress, 1);
  await Bun.sleep(100);
  expect(Atomics.load(progress, 1)).toBe(stoppedAt);
});

test("postMessageToThread rejects when the destination has no listener", async () => {
  const { postMessageToThread } = await import("node:worker_threads");
  const missing = new Worker(
    `const { parentPort } = require("node:worker_threads");
     parentPort.once("message", () => {});
     parentPort.postMessage("ready");`,
    { eval: true },
  );
  await once(missing, "message");
  await expect(postMessageToThread(missing.threadId, "missing")).rejects.toMatchObject({
    code: "ERR_WORKER_MESSAGING_FAILED",
  });
  await missing.terminate();
});

test("postMessageToThread reports destination handler errors", async () => {
  const { postMessageToThread } = await import("node:worker_threads");
  const throwing = new Worker(
    `const { parentPort } = require("node:worker_threads");
     process.on("workerMessage", () => { throw new Error("worker-message-handler"); });
     parentPort.once("message", () => {});
     parentPort.postMessage("ready");`,
    { eval: true },
  );
  await once(throwing, "message");
  await expect(postMessageToThread(throwing.threadId, "throw")).rejects.toMatchObject({
    code: "ERR_WORKER_MESSAGING_ERRORED",
  });
  await throwing.terminate();
});

test("postMessageToThread times out while the destination event loop is blocked", async () => {
  const { postMessageToThread } = await import("node:worker_threads");
  const blocked = new Worker(
    `const { parentPort } = require("node:worker_threads");
     process.on("workerMessage", () => {});
     parentPort.postMessage("ready");
     const end = Date.now() + 250;
     while (Date.now() < end) {}`,
    { eval: true },
  );
  const exit = once(blocked, "exit");
  await once(blocked, "message");
  await expect(postMessageToThread(blocked.threadId, "timeout", 25)).rejects.toMatchObject({
    code: "ERR_WORKER_MESSAGING_TIMEOUT",
  });
  await exit;
});

test("worker_threads.locks coordinates ownership across isolates", async () => {
  const name = `worker-lock-${Date.now()}`;
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     navigator.locks.request(${JSON.stringify(name)}, async lock => {
       const state = await navigator.locks.query();
       const held = state.held.find(item => item.name === lock.name);
       parentPort.postMessage({ type: "acquired", mode: lock.mode, clientId: held.clientId });
       await new Promise(resolve => parentPort.once("message", resolve));
     }).then(
       () => parentPort.postMessage({ type: "released" }),
       error => parentPort.postMessage({ type: "error", name: error.name, message: error.message }),
     );`,
    { eval: true },
  );
  const exit = once(worker, "exit");
  const [acquired] = await once(worker, "message");
  expect(acquired).toMatchObject({ type: "acquired", mode: "exclusive" });
  expect(typeof acquired.clientId).toBe("string");

  const unavailable = await locks.request(name, { ifAvailable: true }, lock => lock === null);
  expect(unavailable).toBe(true);
  expect((await locks.query()).held.some(lock => lock.name === name)).toBe(true);

  worker.postMessage("release");
  expect((await once(worker, "message"))[0]).toEqual({ type: "released" });
  await exit;
  expect(await locks.request(name, lock => lock.name)).toBe(name);
});

test("worker_threads.locks supports shared queues, pending abort, and steal", async () => {
  const sharedName = `worker-shared-lock-${Date.now()}`;
  const shared = await locks.request(sharedName, { mode: "shared" }, async first => {
    return locks.request(sharedName, { mode: "shared" }, second => [first.mode, second.mode]);
  });
  expect(shared).toEqual(["shared", "shared"]);

  const abortName = `worker-abort-lock-${Date.now()}`;
  let releaseAbortHolder: () => void;
  let markAbortAcquired: () => void;
  const abortAcquired = new Promise<void>(resolve => { markAbortAcquired = resolve; });
  const abortHolder = locks.request(abortName, async () => {
    markAbortAcquired();
    await new Promise<void>(resolve => { releaseAbortHolder = resolve; });
  });
  await abortAcquired;
  const controller = new AbortController();
  const pending = locks.request(abortName, { signal: controller.signal }, () => "unreachable");
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  releaseAbortHolder!();
  await abortHolder;

  const stealName = `worker-steal-lock-${Date.now()}`;
  let releaseStolenHolder: () => void;
  let markStealAcquired: () => void;
  const stealAcquired = new Promise<void>(resolve => { markStealAcquired = resolve; });
  const original = locks.request(stealName, async () => {
    markStealAcquired();
    await new Promise<void>(resolve => { releaseStolenHolder = resolve; });
    return "original";
  });
  await stealAcquired;
  expect(await locks.request(stealName, { steal: true }, () => "stolen")).toBe("stolen");
  await expect(original).rejects.toMatchObject({ name: "AbortError" });
  releaseStolenHolder!();
});

test("worker stdio uses native pipes with descriptor isolation and backpressure", async () => {
  const byteLength = 512 * 1024;
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     const chunk = Buffer.alloc(${byteLength}, 120);
     const returned = process.stdout.write(chunk, () => parentPort.postMessage({ type: "callback" }));
     parentPort.postMessage({
       type: "write",
       returned,
       writableLength: process.stdout.writableLength,
       highWaterMark: process.stdout.writableHighWaterMark,
       stdinFd: process.stdin.fd,
       stdoutFd: process.stdout.fd,
       stderrFd: process.stderr.fd,
       stdinConstructor: process.stdin.constructor.name,
       stdoutConstructor: process.stdout.constructor.name,
       stderrConstructor: process.stderr.constructor.name,
     });
     process.stdout.once("drain", () => parentPort.postMessage({ type: "drain" }));`,
    { eval: true, stdin: true, stdout: true, stderr: true },
  );

  const [write] = await once(worker, "message");
  expect(write).toMatchObject({
    type: "write",
    returned: false,
    writableLength: byteLength,
    highWaterMark: 64 * 1024,
    stdinConstructor: "ReadableWorkerStdio",
    stdoutConstructor: "WritableWorkerStdio",
    stderrConstructor: "WritableWorkerStdio",
  });
  expect([write.stdinFd, write.stdoutFd, write.stderrFd]).toEqual([undefined, undefined, undefined]);
  expect(worker.stdin?.constructor.name).toBe("WritableWorkerStdio");
  expect(worker.stdout?.constructor.name).toBe("ReadableWorkerStdio");

  const drain = matchingMessage(worker, value => value?.type === "drain");
  const callback = matchingMessage(worker, value => value?.type === "callback");
  const output = streamBuffer(worker.stdout);
  const exit = once(worker, "exit");
  expect(await drain).toEqual({ type: "drain" });
  expect(await callback).toEqual({ type: "callback" });
  expect((await output).equals(Buffer.alloc(byteLength, 120))).toBe(true);
  expect((await exit)[0]).toBe(0);
});
