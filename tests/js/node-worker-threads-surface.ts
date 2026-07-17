import {
  BroadcastChannel,
  MessageChannel,
  MessagePort,
  SHARE_ENV,
  Worker,
  getEnvironmentData,
  isInternalThread,
  isMainThread,
  isMarkedAsUntransferable,
  locks,
  markAsUncloneable,
  markAsUntransferable,
  moveMessagePortToContext,
  parentPort,
  postMessageToThread,
  receiveMessageOnPort,
  resourceLimits,
  setEnvironmentData,
  threadId,
  threadName,
  workerData,
} from "node:worker_threads";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const require = createRequire(import.meta.url);
assert(require("node:worker_threads").Worker === Worker, "require node:worker_threads mismatch");
assert(typeof SHARE_ENV === "symbol", "SHARE_ENV mismatch");
assert(isMainThread === true, "isMainThread mismatch");
assert(isInternalThread === false, "isInternalThread mismatch");
assert(parentPort === null, "parentPort should be null on main thread");
assert(workerData === null, "workerData should be null on main thread");
assert(threadId === 0, "main threadId mismatch");
assert(typeof threadName === "string", "threadName mismatch");
assert(typeof resourceLimits === "object", "resourceLimits mismatch");

setEnvironmentData("key", { value: 42 });
assert(getEnvironmentData("key").value === 42, "environmentData mismatch");
setEnvironmentData("shared", { token: "env", count: 7n });

const marked = {};
markAsUntransferable(marked);
markAsUncloneable(marked);
assert(isMarkedAsUntransferable(marked), "markAsUntransferable mismatch");

const channel = new MessageChannel();
assert(channel.port1 instanceof MessagePort, "MessageChannel port1 mismatch");
channel.port2.postMessage("queued");
assert(receiveMessageOnPort(channel.port1)?.message === "queued", "receiveMessageOnPort mismatch");
let portMessage = "";
const liveMessage = new Promise<void>((resolve) => {
  channel.port1.once("message", (value) => {
    portMessage = value;
    resolve();
  });
});
channel.port1.start();
channel.port2.postMessage("live");
await liveMessage;
assert(portMessage === "live", "MessagePort live message mismatch");
const portContext = createContext({});
const movedPort = moveMessagePortToContext(channel.port1, portContext);
assert(movedPort === channel.port1, "moveMessagePortToContext mismatch");
portContext.port = movedPort;
assert(runInContext("port", portContext) === movedPort, "moved MessagePort context mismatch");
channel.port1.unref();
assert(channel.port1.hasRef() === false, "MessagePort unref mismatch");
channel.port1.ref();
assert(channel.port1.hasRef() === true, "MessagePort ref mismatch");

const complexChannel = new MessageChannel();
const cyclic: any = {
  big: 11n,
  view: new Uint8Array([9, 8]),
  map: new Map([["k", "channel"]]),
};
cyclic.self = cyclic;
complexChannel.port2.postMessage(cyclic);
const complexReceived = receiveMessageOnPort(complexChannel.port1)?.message;
assert(complexReceived.big === 11n, "MessagePort bigint clone mismatch");
assert(complexReceived.view instanceof Uint8Array && complexReceived.view[0] === 9, "MessagePort typed array clone mismatch");
assert(complexReceived.map instanceof Map && complexReceived.map.get("k") === "channel", "MessagePort Map clone mismatch");
assert(complexReceived.self === complexReceived, "MessagePort cycle clone mismatch");
let cloneError = false;
try {
  complexChannel.port2.postMessage(marked);
} catch (error) {
  cloneError = error?.name === "DataCloneError";
}
assert(cloneError, "markAsUncloneable should reject MessagePort postMessage");
const blockedTransfer = new ArrayBuffer(1);
markAsUntransferable(blockedTransfer);
let transferError = false;
try {
  complexChannel.port2.postMessage({ blockedTransfer }, [blockedTransfer]);
} catch (error) {
  transferError = error?.name === "DataCloneError";
}
assert(transferError, "markAsUntransferable should reject transferList");
let invalidTransferError = false;
try {
  complexChannel.port2.postMessage({ value: "bad-transfer" }, [{} as any]);
} catch (error) {
  invalidTransferError = error?.name === "DataCloneError";
}
assert(invalidTransferError, "non-transferable objects should reject transferList");
const transferBuffer = new ArrayBuffer(3);
const transferView = new Uint8Array(transferBuffer);
transferView.set([4, 5, 6]);
complexChannel.port2.postMessage({ transferBuffer }, [transferBuffer]);
const transferReceived = receiveMessageOnPort(complexChannel.port1)?.message;
assert(transferBuffer.byteLength === 0, "transferred ArrayBuffer should be detached");
assert(transferView.byteLength === 0 && transferView.length === 0, "views over transferred ArrayBuffer should be detached");
assert(transferReceived.transferBuffer instanceof ArrayBuffer, "transferred ArrayBuffer clone mismatch");
assert(new Uint8Array(transferReceived.transferBuffer).join(",") === "4,5,6", "transferred ArrayBuffer bytes mismatch");
let detachedTransferError = false;
try {
  complexChannel.port2.postMessage({ transferBuffer }, [transferBuffer]);
} catch (error) {
  detachedTransferError = error?.name === "DataCloneError";
}
assert(detachedTransferError, "detached ArrayBuffer should reject transferList reuse");

let broadcastMessage = "";
const left = new BroadcastChannel("cottontail-worker-test");
const right = new BroadcastChannel("cottontail-worker-test");
right.onmessage = (event) => { broadcastMessage = event.data; };
left.postMessage("broadcast");
await new Promise((resolve) => setTimeout(resolve, 1));
assert(broadcastMessage === "broadcast", "BroadcastChannel mismatch");
left.close();
right.close();

const lockResult = await locks.request("resource", async (lock) => lock.name);
assert(lockResult === "resource", "locks.request mismatch");
assert(Array.isArray((await locks.query()).held), "locks.query mismatch");

const childPath = `${import.meta.dirname}/fixtures/worker-thread-child.js`;
const worker = new Worker(childPath, {
  workerData: {
    token: "abc",
    big: 12n,
    view: new Uint8Array([1, 2, 3]),
    map: new Map([["k", "worker-data"]]),
  },
  name: "cottontail-worker",
  resourceLimits: { stackSizeMb: 4 },
});
assert(worker instanceof Worker, "Worker constructor mismatch");
assert(typeof worker.threadId === "number" && worker.threadId > 0, "Worker threadId mismatch");
assert(worker.threadName === "cottontail-worker", "Worker threadName mismatch");
assert(typeof worker.postMessage === "function", "Worker postMessage mismatch");
const messages: any[] = [];
const reply = new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("worker_threads response timed out")), 1500);
  worker.on("message", (message) => {
    messages.push(message);
    if (message.type === "ready") {
      const payload: any = {
        value: "ping",
        big: 99n,
        view: new Uint8Array([5, 6]),
        map: new Map([["k", "mapped"]]),
        date: new Date("2020-01-02T03:04:05.000Z"),
      };
      payload.self = payload;
      worker.postMessage(payload);
    }
    if (message.type === "reply") {
      clearTimeout(timeout);
      resolve(message);
    }
  });
  worker.on("error", reject);
});
assert(worker.ref() === worker && worker.unref() === worker, "Worker ref/unref mismatch");
let cpuUsageError: any;
try {
  await worker.cpuUsage();
} catch (error) {
  cpuUsageError = error;
}
assert(cpuUsageError?.code === "ERR_COTTONTAIL_NATIVE_BOUNDARY", "Worker cpuUsage boundary mismatch");
assert(typeof (await worker.getHeapStatistics()) === "object", "Worker heap stats mismatch");

const response = await reply;
assert(messages.some((message) => message.type === "ready"), "Worker ready message mismatch");
const ready = messages.find((message) => message.type === "ready");
assert(ready.workerData.big === 12n, "Worker ready workerData bigint mismatch");
assert(ready.workerData.view instanceof Uint8Array && ready.workerData.view.join(",") === "1,2,3", "Worker ready workerData view mismatch");
assert(ready.workerData.map instanceof Map && ready.workerData.map.get("k") === "worker-data", "Worker ready workerData map mismatch");
assert(ready.env.count === 7n && ready.env.token === "env", "Worker ready environmentData mismatch");
assert(ready.isMainThread === false, "Worker isMainThread mismatch");
assert(ready.threadId === worker.threadId, "Worker imported threadId mismatch");
assert(ready.threadName === "cottontail-worker", "Worker imported threadName mismatch");
assert(ready.resourceLimits.stackSizeMb === 4, "Worker resourceLimits mismatch");
assert(response.value === "ping", "Worker reply mismatch");
assert(response.big === "99", "Worker reply bigint mismatch");
assert(response.view.join(",") === "5,6", "Worker reply typed array mismatch");
assert(response.map === "mapped", "Worker reply map mismatch");
assert(response.date === "2020-01-02T03:04:05.000Z", "Worker reply date mismatch");
assert(response.cycle === true, "Worker reply cycle mismatch");
assert(response.workerData.token === "abc", "Worker workerData mismatch");
assert(response.env.count === 7n, "Worker environmentData mismatch");
assert(await postMessageToThread(worker.threadId, { value: "post-to-thread" }) === undefined, "postMessageToThread mismatch");

const transferredChannel = new MessageChannel();
const transferredPortReply = new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("transferred MessagePort timed out")), 1500);
  transferredChannel.port1.on("message", (message) => {
    if (message.type === "port-ready") {
      transferredChannel.port1.postMessage({
        value: "through-port",
        map: new Map([["k", "port-map"]]),
      });
    }
    if (message.type === "port-reply") {
      clearTimeout(timeout);
      resolve(message);
    }
  });
  transferredChannel.port1.start();
  worker.postMessage({ port: transferredChannel.port2 }, [transferredChannel.port2]);
});
const portReply = await transferredPortReply;
assert(portReply.value === "through-port", "transferred MessagePort reply mismatch");
assert(portReply.map === "port-map", "transferred MessagePort structured clone mismatch");
assert(portReply.threadId === worker.threadId, "transferred MessagePort worker thread mismatch");

assert(typeof SharedArrayBuffer === "function", "SharedArrayBuffer global missing");
const sharedBuffer = new SharedArrayBuffer(8);
assert(sharedBuffer instanceof SharedArrayBuffer, "SharedArrayBuffer instanceof mismatch");
const sharedView = new Int32Array(sharedBuffer);
Atomics.store(sharedView, 0, 7);
Atomics.store(sharedView, 1, 0);
const sharedReplyPromise = new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("SharedArrayBuffer worker response timed out")), 1500);
  worker.on("message", (message) => {
    if (message.type === "shared-done") {
      clearTimeout(timeout);
      resolve(message);
    }
  });
});
worker.postMessage({ shared: sharedBuffer });
assert(Atomics.wait(sharedView, 0, 7, 1000) === "ok", "Atomics.wait should be notified by worker");
const sharedReply = await sharedReplyPromise;
assert(sharedReply.isShared === true, "worker should receive SharedArrayBuffer");
assert(sharedReply.before === 7, "worker shared buffer initial value mismatch");
assert(sharedReply.after === 8, "worker shared buffer updated value mismatch");
assert(sharedReply.second === 3, "worker shared buffer Atomics.add mismatch");
assert(Atomics.load(sharedView, 0) === 8, "parent should observe shared buffer mutation");
assert(Atomics.load(sharedView, 1) === 3, "parent should observe shared Atomics.add mutation");
assert(Atomics.wait(sharedView, 0, 99, 1) === "not-equal", "Atomics.wait should report not-equal");
assert(Atomics.wait(sharedView, 0, 8, 0) === "timed-out", "Atomics.wait zero timeout should time out");
assert(Atomics.notify(sharedView, 0, 1) === 0, "Atomics.notify should report no waiters");

const waitBuffer = new SharedArrayBuffer(8);
const waitView = new Int32Array(waitBuffer);
Atomics.store(waitView, 0, 1);
Atomics.store(waitView, 1, 1);
const waitStartedPromise = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Atomics.wait worker start timed out")), 1500);
  worker.on("message", (message) => {
    if (message.type === "wait-started") {
      clearTimeout(timeout);
      resolve();
    }
  });
});
const waitResultPromise = new Promise<any>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("Atomics.wait worker result timed out")), 1500);
  worker.on("message", (message) => {
    if (message.type === "wait-result") {
      clearTimeout(timeout);
      resolve(message);
    }
  });
});
worker.postMessage({ waitShared: waitBuffer });
await waitStartedPromise;
assert(Atomics.notify(waitView, 1, 1) === 0, "Atomics.notify should ignore waiters at other indexes");
let notifiedWaiters = 0;
for (let attempt = 0; attempt < 50 && notifiedWaiters === 0; attempt += 1) {
  notifiedWaiters = Atomics.notify(waitView, 0, 1);
  if (notifiedWaiters === 0) await new Promise((resolve) => setTimeout(resolve, 5));
}
assert(notifiedWaiters === 1, "Atomics.notify should wake one matching waiter");
const waitResult = await waitResultPromise;
assert(waitResult.result === "ok", "worker Atomics.wait should return ok after notify");
assert(Atomics.notify(waitView, 0, 1) === 0, "Atomics.notify should not count completed waiters");

assert(typeof worker[Symbol.asyncDispose] === "function", "Worker asyncDispose mismatch");
assert(await worker.terminate() === 1, "Worker terminate mismatch");

console.log("node worker_threads surface passed");
