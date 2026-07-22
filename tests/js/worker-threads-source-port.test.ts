import { expect, test } from "bun:test";
import {
  BroadcastChannel,
  MessageChannel,
  MessagePort,
  Worker,
  getEnvironmentData,
  postMessageToThread,
  receiveMessageOnPort,
  setEnvironmentData,
} from "node:worker_threads";

function once(target: Worker, event: string) {
  return new Promise<any[]>(resolve => target.once(event, (...args: any[]) => resolve(args)));
}

function messageFrom(worker: Worker) {
  return new Promise<any>((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
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

function streamText(stream: any) {
  return new Promise<string>((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk: any) => { output += String(chunk); });
    stream.once("error", reject);
    stream.once("end", () => resolve(output));
  });
}

test("worker source loader reports module-evaluation errors to its owner", async () => {
  const worker = new Worker(
    `throw new TypeError("source-port-error");`,
    { eval: true },
  );
  const errorEvent = once(worker, "error");
  const [error] = await errorEvent;
  expect(error).toBeInstanceOf(TypeError);
  expect(error.message).toBe("source-port-error");
  await worker.terminate();
});

test("eval workers use the real CommonJS loader and inherit cloned metadata", async () => {
  const environmentKey = `source-port-${Date.now()}`;
  const inherited = { nested: { value: 7 } };
  setEnvironmentData(environmentKey, inherited);

  const worker = new Worker(
    `const workers = require("node:worker_threads");
     const path = require("node:path");
     workers.parentPort.postMessage({
       argv: process.argv,
       env: process.env,
       environmentData: workers.getEnvironmentData(${JSON.stringify(environmentKey)}),
       execArgv: process.execArgv,
       hasModule: typeof module === "object" && typeof require === "function",
       isMainThread: workers.isMainThread,
       joined: path.join("worker", "loader"),
       resourceLimits: workers.resourceLimits,
       threadId: workers.threadId,
       threadName: workers.threadName,
       workerData: workers.workerData,
     });`,
    {
      eval: true,
      argv: [42, null],
      env: { CT_SOURCE_PORT_ENV: 123 },
      execArgv: ["--trace-warnings"],
      name: "source-port-eval",
      resourceLimits: { stackSizeMb: 3 },
      workerData: { token: "eval-data" },
    },
  );
  inherited.nested.value = 99;

  const result = await messageFrom(worker);
  expect(result.hasModule).toBe(true);
  expect(result.joined).toBe("worker/loader");
  expect(result.isMainThread).toBe(false);
  expect(result.workerData).toEqual({ token: "eval-data" });
  expect(result.environmentData).toEqual({ nested: { value: 7 } });
  expect(result.threadId).toBe(worker.threadId);
  expect(result.threadName).toBe("source-port-eval");
  expect(result.resourceLimits).toEqual({ stackSizeMb: 3 });
  expect(result.argv.slice(-2)).toEqual(["42", "null"]);
  expect(result.execArgv).toEqual(["--trace-warnings"]);
  expect(result.env.CT_SOURCE_PORT_ENV).toBe("123");
  expect(getEnvironmentData(environmentKey)).toBe(inherited);
  setEnvironmentData(environmentKey, undefined);
  await worker.terminate();
});

test("file URL, CommonJS, ESM, and data URL workers use runtime module loading", async () => {
  const fixtures = `${import.meta.dirname}/fixtures`;
  const cjs = new Worker(`${fixtures}/worker-source-port-cjs.cjs`, { workerData: "cjs-data" });
  const cjsResult = await messageFrom(cjs);
  expect(cjsResult.kind).toBe("cjs");
  expect(cjsResult.dependency).toEqual({ loaded: "cjs-dependency" });
  expect(cjsResult.workerData).toBe("cjs-data");
  expect(cjsResult.filename.endsWith("worker-source-port-cjs.cjs")).toBe(true);
  await cjs.terminate();

  const esmUrl = new URL("./fixtures/worker-source-port-esm.mjs", import.meta.url);
  const esm = new Worker(esmUrl, { type: "module", workerData: "esm-data" });
  const esmResult = await messageFrom(esm);
  expect(esmResult.kind).toBe("esm");
  expect(esmResult.workerData).toBe("esm-data");
  expect(esmResult.url.endsWith("worker-source-port-esm.mjs")).toBe(true);
  await esm.terminate();

  const dataSource = `import { parentPort, workerData } from "node:worker_threads";
    parentPort.postMessage({ kind: "data", workerData });`;
  const data = new Worker(`data:text/javascript,${encodeURIComponent(dataSource)}`, { workerData: "data-url" });
  expect(await messageFrom(data)).toEqual({ kind: "data", workerData: "data-url" });
  await data.terminate();
});

test("concurrent workers from one module get independent wrappers and terminate cleanly", async () => {
  const url = new URL("./fixtures/worker-source-port-listener.mjs", import.meta.url);
  const first = new Worker(url);
  const second = new Worker(url);
  const firstThreadId = first.threadId;
  const secondThreadId = second.threadId;
  const firstMessage = messageFrom(first);
  const secondMessage = messageFrom(second);
  first.postMessage("first");
  second.postMessage("second");

  expect(await firstMessage).toEqual({ threadId: firstThreadId, value: "first" });
  expect(await secondMessage).toEqual({ threadId: secondThreadId, value: "second" });
  await first.terminate();
  await second.terminate();
});

test("structured clone preserves graph identity, sparse arrays, views, and errors", () => {
  const { port1, port2 } = new MessageChannel();
  const buffer = new ArrayBuffer(16);
  const bytes = new Uint8Array(buffer);
  bytes.set([1, 2, 3, 4, 5, 6]);
  const sparse: any[] = new Array(4);
  sparse[2] = "present";
  (sparse as any).extra = 11;
  const cause = new RangeError("cause");
  const error = new AggregateError([new TypeError("inner")], "outer", { cause });
  const value: any = {
    boxed: new Number(-0),
    error,
    first: new Uint8Array(buffer, 1, 3),
    second: new DataView(buffer, 2, 4),
    sparse,
  };
  value.self = value;

  port1.postMessage(value);
  const received = receiveMessageOnPort(port2)?.message;
  expect(received.self).toBe(received);
  expect(received.first.buffer).toBe(received.second.buffer);
  expect(Array.from(received.first)).toEqual([2, 3, 4]);
  expect(received.second.byteOffset).toBe(2);
  expect(received.sparse.length).toBe(4);
  expect(0 in received.sparse).toBe(false);
  expect(received.sparse[2]).toBe("present");
  expect(received.sparse.extra).toBe(11);
  expect(Object.is(received.boxed.valueOf(), -0)).toBe(true);
  expect(received.error).toBeInstanceOf(AggregateError);
  expect(received.error.message).toBe("outer");
  expect(received.error.cause).toBeInstanceOf(RangeError);
  expect(received.error.errors[0]).toBeInstanceOf(TypeError);

  const transferred = new ArrayBuffer(4);
  const transferredView = new Uint8Array(transferred);
  transferredView.set([9, 8, 7, 6]);
  port1.postMessage({ transferred }, [transferred]);
  const transferResult = receiveMessageOnPort(port2)?.message;
  expect(transferred.byteLength).toBe(0);
  expect(transferredView.byteLength).toBe(0);
  expect(Array.from(new Uint8Array(transferResult.transferred))).toEqual([9, 8, 7, 6]);
});

test("MessageEvent.ports preserves transferred-port identity and transfer validation is atomic", async () => {
  const transport = new MessageChannel();
  const transferred = new MessageChannel();
  const eventPromise = new Promise<any>(resolve => {
    transport.port2.addEventListener("message", resolve, { once: true });
  });

  expect(() => transport.port1.postMessage("peer", [transport.port2])).toThrow();
  expect(() => transport.port1.postMessage("duplicate", [transferred.port1, transferred.port1])).toThrow();
  transport.port1.postMessage({ port: transferred.port1 }, [transferred.port1]);

  const event = await eventPromise;
  expect(event.data.port).toBeInstanceOf(MessagePort);
  expect(event.ports).toHaveLength(1);
  expect(event.ports[0]).toBe(event.data.port);

  const reply = once(transferred.port2 as any, "message");
  event.ports[0].postMessage("transferred-reply");
  expect((await reply)[0]).toBe("transferred-reply");
});

test("MessagePort ref state follows message listeners and explicit ownership", () => {
  const { port1, port2 } = new MessageChannel();
  const emitterListener = () => {};
  const eventTargetListener = () => {};

  expect(port1.hasRef()).toBe(false);
  expect(port1.ref()).toBeUndefined();
  expect(port1.hasRef()).toBe(true);
  expect(port1.unref()).toBeUndefined();
  expect(port1.hasRef()).toBe(false);

  port1.on("message", emitterListener);
  expect(port1.hasRef()).toBe(true);
  port1.off("message", emitterListener);
  expect(port1.hasRef()).toBe(false);

  port1.onmessage = emitterListener;
  expect(port1.hasRef()).toBe(true);
  port1.onmessage = null;
  expect(port1.hasRef()).toBe(false);

  port1.addEventListener("message", eventTargetListener);
  expect(port1.hasRef()).toBe(true);
  port1.removeEventListener("message", eventTargetListener);
  expect(port1.hasRef()).toBe(false);

  port1.close();
  port2.close();
});

test("parentPort starts unreferenced and tracks worker message listeners", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     const initial = parentPort.hasRef();
     const handler = value => {
       const during = parentPort.hasRef();
       parentPort.off("message", handler);
       parentPort.postMessage({ type: "result", initial, during, after: parentPort.hasRef(), value });
     };
     parentPort.on("message", handler);
     parentPort.postMessage({ type: "ready", afterAdd: parentPort.hasRef() });`,
    { eval: true },
  );
  const ready = await messageFrom(worker);
  expect(ready).toEqual({ type: "ready", afterAdd: true });

  const result = messageFrom(worker);
  const exit = once(worker, "exit");
  worker.postMessage("worker-message");
  expect(await result).toEqual({
    type: "result",
    initial: false,
    during: true,
    after: false,
    value: "worker-message",
  });
  expect((await exit)[0]).toBe(0);
});

test("BroadcastChannel has Node emitter and Web EventTarget delivery in one isolate", async () => {
  const name = `source-port-broadcast-${Date.now()}`;
  const first = new BroadcastChannel(name);
  const second = new BroadcastChannel(name);
  const emitterMessage = once(first as any, "message");
  const eventTargetMessage = new Promise<any>(resolve => {
    second.addEventListener("message", resolve, { once: true });
  });

  second.postMessage({ via: "emitter" });
  first.postMessage({ via: "event-target" });
  expect((await emitterMessage)[0]).toEqual({ via: "emitter" });
  expect((await eventTargetMessage).data).toEqual({ via: "event-target" });
  first.close();
  expect(() => first.postMessage("closed")).toThrow();
  second.close();
});

test("parentPort is a MessagePort and delivers EventTarget transfer metadata", async () => {
  const worker = new Worker(
    `const { MessagePort, parentPort } = require("node:worker_threads");
     parentPort.addEventListener("message", event => {
       event.ports[0].postMessage("port-reply");
       parentPort.postMessage({
         dataMatches: event.data.port === event.ports[0],
         isMessagePort: parentPort instanceof MessagePort,
         transferredIsPort: event.ports[0] instanceof MessagePort,
       });
     }, { once: true });`,
    { eval: true },
  );
  const channel = new MessageChannel();
  const portReply = once(channel.port1 as any, "message");
  const result = messageFrom(worker);
  worker.postMessage({ port: channel.port2 }, [channel.port2]);

  expect((await portReply)[0]).toBe("port-reply");
  expect(await result).toEqual({
    dataMatches: true,
    isMessagePort: true,
    transferredIsPort: true,
  });
  await worker.terminate();
});

test("MessagePort survives a second transfer through a nested worker and propagates close", async () => {
  const nestedSource = `
    const { parentPort, threadId, workerData } = require("node:worker_threads");
    workerData.on("message", value => workerData.postMessage({ type: "reply", threadId, value }));
    workerData.once("close", () => parentPort.postMessage({ type: "remote-close", threadId }));
    workerData.postMessage({ type: "ready", threadId });
  `;
  const outerSource = `
    const { parentPort, Worker, workerData } = require("node:worker_threads");
    const nested = new Worker(${JSON.stringify(nestedSource)}, {
      eval: true,
      workerData,
      transferList: [workerData],
    });
    nested.on("message", message => {
      parentPort.postMessage(message);
      if (message.type === "remote-close") nested.terminate();
    });
    nested.on("error", error => { throw error; });
  `;

  const { port1, port2 } = new MessageChannel();
  const ready = once(port1 as any, "message");
  const outer = new Worker(outerSource, { eval: true, workerData: port2, transferList: [port2] });
  const [readyMessage] = await ready;
  expect(readyMessage.type).toBe("ready");
  expect(readyMessage.threadId).not.toBe(outer.threadId);

  const reply = once(port1 as any, "message");
  port1.postMessage({ nested: true });
  const [replyMessage] = await reply;
  expect(replyMessage.type).toBe("reply");
  expect(replyMessage.value).toEqual({ nested: true });

  const remoteClose = matchingMessage(outer, value => value?.type === "remote-close");
  port1.close();
  expect((await remoteClose).threadId).toBe(readyMessage.threadId);
  await outer.terminate();
});

test("worker stdio uses parent-owned streams", async () => {
  const worker = new Worker(
    `const { parentPort } = require("node:worker_threads");
     process.stdin.once("data", chunk => {
       process.stdout.write("stdout:" + chunk);
       process.stderr.write("stderr:" + chunk);
       parentPort.postMessage("stdio-complete");
     });`,
    { eval: true, stdin: true, stdout: true, stderr: true },
  );
  const stdout = streamText(worker.stdout);
  const stderr = streamText(worker.stderr);
  const complete = messageFrom(worker);
  const exit = once(worker, "exit");
  worker.stdin.end("payload");
  expect(await complete).toBe("stdio-complete");
  await exit;
  expect(await stdout).toBe("stdout:payload");
  expect(await stderr).toBe("stderr:payload");
});

test("user uncaught handlers run inside the worker instead of becoming owner errors", async () => {
  const capture = new Worker(
    `const { parentPort } = require("node:worker_threads");
     process.setUncaughtExceptionCaptureCallback(error => {
       process.setUncaughtExceptionCaptureCallback(null);
       parentPort.postMessage({ kind: "capture", message: error.message });
     });
     throw new Error("captured-worker-error");`,
    { eval: true },
  );
  expect(await messageFrom(capture)).toEqual({ kind: "capture", message: "captured-worker-error" });
  await capture.terminate();

  const listener = new Worker(
    `const { parentPort } = require("node:worker_threads");
     process.once("uncaughtException", error => {
       parentPort.postMessage({ kind: "listener", message: error.message });
     });
     throw new Error("listener-worker-error");`,
    { eval: true },
  );
  expect(await messageFrom(listener)).toEqual({ kind: "listener", message: "listener-worker-error" });
  await listener.terminate();
});

test("postMessageToThread delivers process workerMessage events in both directions", async () => {
  const worker = new Worker(
    `const { parentPort, postMessageToThread, threadId } = require("node:worker_threads");
     process.on("workerMessage", (value, source) => parentPort.postMessage({ type: "from-main", value, source }));
     parentPort.on("message", async value => {
       if (value === "send-main") {
         await postMessageToThread(0, { from: threadId });
         parentPort.postMessage({ type: "sent-main" });
       }
     });
     parentPort.postMessage({ type: "ready" });`,
    { eval: true },
  );
  expect((await messageFrom(worker)).type).toBe("ready");

  const fromMain = matchingMessage(worker, value => value?.type === "from-main");
  expect(await postMessageToThread(worker.threadId, { token: 1 })).toBeUndefined();
  expect(await fromMain).toEqual({ type: "from-main", value: { token: 1 }, source: 0 });

  const workerMessage = once(process as any, "workerMessage");
  const sentMain = matchingMessage(worker, value => value?.type === "sent-main");
  worker.postMessage("send-main");
  const [value, source] = await workerMessage;
  expect(value).toEqual({ from: worker.threadId });
  expect(source).toBe(worker.threadId);
  await sentMain;
  await worker.terminate();
});

test("terminate settles once and clears exited worker metadata", async () => {
  const worker = new Worker(`setInterval(() => {}, 1000);`, {
    eval: true,
    name: "terminating-worker",
    resourceLimits: { stackSizeMb: 2 },
  });
  await once(worker, "online");
  const originalThreadId = worker.threadId;
  const exitEvent = once(worker, "exit");
  const first = worker.terminate();
  const second = worker.terminate();
  expect(second).toBe(first);
  const code = await first;
  expect(code).toBe(1);
  expect((await exitEvent)[0]).toBe(code);
  expect(originalThreadId).toBeGreaterThan(0);
  expect(worker.threadId).toBe(-1);
  expect(worker.threadName).toBeNull();
  expect(worker.resourceLimits).toEqual({});
  expect(worker.ref()).toBeUndefined();
  expect(worker.unref()).toBeUndefined();
});

test("process.exit clears worker handles and propagates the requested code", async () => {
  const worker = new Worker(`setInterval(() => {}, 1000); process.exit(23);`, { eval: true });
  expect((await once(worker, "exit"))[0]).toBe(23);
  expect(worker.threadId).toBe(-1);
});
