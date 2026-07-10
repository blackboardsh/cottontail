import clusterDefault, {
  SCHED_NONE,
  SCHED_RR,
  Worker,
  _events,
  _eventsCount,
  _maxListeners,
  disconnect,
  fork,
  isMaster,
  isPrimary,
  isWorker,
  schedulingPolicy,
  settings,
  setupMaster,
  setupPrimary,
  workers,
} from "node:cluster";
import { createRequire } from "node:module";
import { connect as connectNet, createServer as createNetServer } from "node:net";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const require = createRequire(import.meta.url);
assert(require("node:cluster").fork === fork, "require node:cluster mismatch");
assert(clusterDefault.fork === fork, "cluster default fork mismatch");
assert(SCHED_NONE === 1 && SCHED_RR === 2, "cluster scheduling constants mismatch");
assert(isPrimary === true && isMaster === true && isWorker === false, "cluster primary flags mismatch");
assert(typeof _events === "object", "cluster _events export mismatch");
assert(_eventsCount === 0, "cluster _eventsCount export mismatch");
assert(_maxListeners === undefined, "cluster _maxListeners export mismatch");
assert(typeof schedulingPolicy === "number", "cluster schedulingPolicy mismatch");

const childPath = `${import.meta.dirname}/fixtures/fork-child.js`;
setupPrimary({ exec: childPath, silent: true });
setupMaster({ exec: childPath, silent: true });
assert(settings.exec === childPath, "cluster setupPrimary settings mismatch");

const worker = fork({ COTTONTAIL_CLUSTER_TEST: "1" });
assert(worker instanceof Worker, "cluster fork Worker mismatch");
assert(workers[worker.id] === worker, "cluster workers map mismatch");
assert(worker.isConnected(), "cluster worker should be connected");

const messages: any[] = [];
const closeCode = await new Promise<number | null>((resolve, reject) => {
  worker.on("message", (message) => {
    messages.push(message);
    if (message?.ready) worker.send({ value: "cluster-ok" });
  });
  worker.on("error", reject);
  worker.on("close", (code) => resolve(code));
});

assert(closeCode === 0, `cluster worker close mismatch: ${closeCode}`);
assert(messages.some((message) => message?.ready === true), "cluster worker ready message mismatch");
assert(messages.some((message) => message?.echo === "cluster-ok"), "cluster worker echo mismatch");
assert(worker.isDead(), "cluster worker should be dead after close");

const handleWorker = fork({ COTTONTAIL_CLUSTER_HANDLE_TEST: "1" });
const handleMessages: any[] = [];
const handleClosePromise = new Promise<number | null>((resolve) => handleWorker.on("close", (code) => resolve(code)));
await new Promise<void>((resolve, reject) => {
  handleWorker.on("message", (message) => {
    handleMessages.push(message);
    if (message?.ready) resolve();
  });
  handleWorker.on("error", reject);
});
const handleServer = createNetServer((socket) => {
  handleWorker.send({ socketTest: true }, socket, (error: Error | null) => {
    if (error) handleWorker.emit("error", error);
    socket.destroy();
  });
});
await new Promise<void>((resolve, reject) => {
  handleServer.once("error", reject);
  handleServer.listen(0, "127.0.0.1", () => resolve());
});
const handleAddress = handleServer.address();
if (handleAddress == null || typeof handleAddress === "string") throw new Error("cluster handle server address mismatch");
const handleReply = await new Promise<string>((resolve, reject) => {
  const client = connectNet(handleAddress.port, "127.0.0.1");
  let data = "";
  client.setEncoding("utf8");
  client.once("error", reject);
  handleWorker.once("error", reject);
  client.once("connect", () => client.write("from-cluster-client"));
  client.on("data", (chunk) => { data += chunk; });
  client.on("end", () => resolve(data));
});
await new Promise<void>((resolve) => handleServer.close(() => resolve()));
const handleCloseCode = await handleClosePromise;
assert(handleCloseCode === 0, `cluster handle worker close mismatch: ${handleCloseCode}`);
assert(handleMessages.some((message) => message?.socketReceived === true), "cluster socket handle was not received");
assert(handleMessages.some((message) => message?.socketData === "from-cluster-client"), "cluster socket handle data mismatch");
assert(handleReply === "from-child-socket", `cluster socket handle reply mismatch: ${JSON.stringify(handleReply)}`);

await new Promise<void>((resolve) => disconnect(() => resolve()));

console.log("node cluster surface passed");
