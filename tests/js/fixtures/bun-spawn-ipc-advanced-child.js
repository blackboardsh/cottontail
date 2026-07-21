process.on("message", message => {
  const response = {
    bigint: message.bigint + 1n,
    map: message.map,
    typed: message.typed,
    receivedCycle: message.self === message,
  };
  response.self = response;
  process.send(response);
  process.disconnect();
});
