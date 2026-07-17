import { isMainThread, parentPort, threadId, workerData } from "node:worker_threads";

parentPort.postMessage({
  isMainThread,
  kind: "esm",
  threadId,
  url: import.meta.url,
  workerData,
});
