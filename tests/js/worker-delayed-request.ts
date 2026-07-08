const worker = new Worker(`${cottontail.cwd()}/tests/js/fixtures/request-worker.js`, {
  type: "module",
});

await new Promise((resolve) => setTimeout(resolve, 150));

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("delayed worker response timed out")), 1500);
  worker.onerror = (event) => {
    clearTimeout(timeout);
    reject(new Error(`worker error: ${event?.message || event}`));
  };
  worker.onmessage = (event) => {
    clearTimeout(timeout);
    resolve(event.data);
  };
  worker.postMessage({
    type: "request",
    requestId: 9,
    method: "delayed-ping",
    params: { delayed: true },
  });
});

worker.terminate();

if (JSON.stringify(result) !== JSON.stringify({
  type: "response",
  requestId: 9,
  success: true,
  payload: {
    method: "delayed-ping",
    params: { delayed: true },
  },
})) {
  throw new Error(`delayed worker response mismatch: ${JSON.stringify(result)}`);
}

console.log("worker delayed request passed");
