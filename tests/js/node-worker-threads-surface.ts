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
const worker = new Worker(childPath, { workerData: { token: "abc" }, name: "cottontail-worker" });
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
    if (message.type === "ready") worker.postMessage({ value: "ping" });
    if (message.type === "reply") {
      clearTimeout(timeout);
      resolve(message);
    }
  });
  worker.on("error", reject);
});

const response = await reply;
assert(messages.some((message) => message.type === "ready"), "Worker ready message mismatch");
assert(response.value === "ping", "Worker reply mismatch");
assert(response.workerData.token === "abc", "Worker workerData mismatch");
assert(await postMessageToThread(worker.threadId, { value: "post-to-thread" }) === true, "postMessageToThread mismatch");
assert(await worker.terminate() === 0, "Worker terminate mismatch");

console.log("node worker_threads surface passed");
