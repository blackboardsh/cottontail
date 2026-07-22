if (typeof process.send !== "function") {
  throw new Error("process.send was not installed during child_process bootstrap");
}

process.on("message", (message) => {
  const response = {
    bigint: message.bigint + 1n,
    map: message.map,
    typed: message.typed,
    receivedCycle: message.self === message,
  };
  response.self = response;
  process.send(response, (error) => {
    if (error) throw error;
    process.disconnect();
  });
});

process.send({ ready: true, bigint: 1n });
