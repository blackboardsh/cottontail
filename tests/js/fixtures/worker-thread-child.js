import {
  getEnvironmentData,
  isMainThread,
  parentPort,
  resourceLimits,
  threadId,
  threadName,
  workerData,
} from "node:worker_threads";

parentPort.on("message", (message) => {
  if (message.shared) {
    const shared = new Int32Array(message.shared);
    const before = Atomics.load(shared, 0);
    Atomics.store(shared, 0, before + 1);
    Atomics.add(shared, 1, 3);
    Atomics.notify(shared, 0, 1);
    parentPort.postMessage({
      type: "shared-done",
      before,
      after: Atomics.load(shared, 0),
      second: Atomics.load(shared, 1),
      isShared: message.shared instanceof SharedArrayBuffer,
    });
    return;
  }

  if (message.waitShared) {
    const shared = new Int32Array(message.waitShared);
    parentPort.postMessage({ type: "wait-started" });
    const result = Atomics.wait(shared, 0, 1, 1000);
    parentPort.postMessage({ type: "wait-result", result });
    return;
  }

  if (message.port) {
    const port = message.port;
    port.on("message", (value) => {
      port.postMessage({
        type: "port-reply",
        value: value.value,
        map: value.map instanceof Map ? value.map.get("k") : undefined,
        threadId,
      });
    });
    port.postMessage({ type: "port-ready", threadId });
    return;
  }

  parentPort.postMessage({
    type: "reply",
    value: message.value,
    big: typeof message.big === "bigint" ? message.big.toString() : undefined,
    view: message.view ? Array.from(message.view) : undefined,
    map: message.map instanceof Map ? message.map.get("k") : undefined,
    date: message.date instanceof Date ? message.date.toISOString() : undefined,
    cycle: message.self === message,
    workerData,
    env: getEnvironmentData("shared"),
    isMainThread,
    threadId,
    threadName,
    resourceLimits,
  });
});

parentPort.postMessage({
  type: "ready",
  workerData,
  env: getEnvironmentData("shared"),
  isMainThread,
  threadId,
  threadName,
  resourceLimits,
});
