const { isMainThread, parentPort, threadId, workerData } = require("node:worker_threads");
const dependency = require("./worker-source-port-dependency.cjs");

parentPort.postMessage({
  dependency,
  dirname: __dirname,
  filename: __filename,
  isMainThread,
  kind: "cjs",
  threadId,
  workerData,
});
