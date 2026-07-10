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
channel.port1.on("message", (value) => { portMessage = value; });
channel.port1.start();
channel.port2.postMessage("live");
assert(portMessage === "live", "MessagePort live message mismatch");
assert(moveMessagePortToContext(channel.port1, {}) === channel.port1, "moveMessagePortToContext mismatch");
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
assert(worker.ref() === worker && worker.unref() === worker, "Worker ref/unref mismatch");
assert(typeof (await worker.cpuUsage()).user === "number", "Worker cpuUsage mismatch");
assert(typeof (await worker.getHeapStatistics()) === "object", "Worker heap stats mismatch");

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
assert(await postMessageToThread(worker.threadId, { value: "post-to-thread" }) === true, "postMessageToThread mismatch");

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

assert(await worker.terminate() === 0, "Worker terminate mismatch");

console.log("node worker_threads surface passed");
