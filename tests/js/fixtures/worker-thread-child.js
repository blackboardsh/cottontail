parentPort.on("message", (message) => {
  parentPort.postMessage({
    type: "reply",
    value: message.value,
    workerData,
  });
});

parentPort.postMessage({ type: "ready", workerData });
