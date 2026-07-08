const workerPath = cottontail.env("COTTONTAIL_PLATFORM_WORKER");
const method = cottontail.env("COTTONTAIL_PLATFORM_METHOD");
const statePath = cottontail.env("COTTONTAIL_PLATFORM_STATE_PATH");
const paramsJson = cottontail.env("COTTONTAIL_PLATFORM_PARAMS") || "{}";
const delayMs = Number(cottontail.env("COTTONTAIL_PLATFORM_DELAY_MS") || 0);

if (!workerPath) throw new Error("COTTONTAIL_PLATFORM_WORKER missing");
if (!method) throw new Error("COTTONTAIL_PLATFORM_METHOD missing");

const params = JSON.parse(paramsJson);

const worker = new Worker(workerPath, { type: "module" });

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error(`worker invoke timed out: ${method}`)), 30000);
  worker.onerror = (event) => {
    clearTimeout(timeout);
    reject(new Error(`worker error: ${event?.message || event}`));
  };
  worker.onmessage = (event) => {
    const message = event.data;
    if (message?.type !== "response") return;
    clearTimeout(timeout);
    if (message.success) {
      resolve(message.payload);
    } else {
      reject(new Error(String(message.error || "Unknown worker error")));
    }
  };
  worker.postMessage({
    type: "init",
    context: {
      statePath,
      machineId: "test-machine",
      channel: "dev",
    },
  });
  const sendRequest = () => {
    worker.postMessage({
      type: "request",
      requestId: 1,
      method,
      params,
    });
  };
  if (delayMs > 0) {
    setTimeout(sendRequest, delayMs);
  } else {
    sendRequest();
  }
});

worker.terminate();

console.log(JSON.stringify(result));
