const worker = new Worker(`${cottontail.cwd()}/tests/js/fixtures/request-worker.js`, {
  type: "module",
});

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("worker response timed out")), 1000);
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
    requestId: 7,
    method: "ping",
    params: { ok: true },
  });
});

worker.terminate();

if (JSON.stringify(result) !== JSON.stringify({
  type: "response",
  requestId: 7,
  success: true,
  payload: {
    method: "ping",
    params: { ok: true },
  },
})) {
  throw new Error(`worker response mismatch: ${JSON.stringify(result)}`);
}

console.log("worker request response passed");
