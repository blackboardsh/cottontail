if (typeof process.send !== "function") {
  throw new Error("external Node fork did not receive an IPC channel");
}

process.send({
  ready: true,
  runtime: process.release?.name,
});

process.once("message", message => {
  process.send({ pong: message?.ping });
  process.disconnect();
});
