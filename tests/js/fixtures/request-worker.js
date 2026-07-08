self.onmessage = async (event) => {
  const message = event.data;
  if (message?.type !== "request") return;

  self.postMessage({
    type: "response",
    requestId: message.requestId,
    success: true,
    payload: {
      method: message.method,
      params: message.params,
    },
  });
};
