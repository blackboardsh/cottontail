import { parentPort, threadId } from "node:worker_threads";

parentPort.on("message", value => {
  parentPort.postMessage({ threadId, value });
});
