if (typeof process.send !== "function") {
  throw new Error("external Node fork did not receive an IPC channel");
}

process.send({
  ready: true,
  runtime: process.release?.name,
  framingProbe: `node-ipc-\ud83d\ude42-${"x".repeat(96 * 1024)}-tail`,
});

process.once("message", message => {
  process.send({
    pong: message?.ping,
    unicodeEcho: message?.unicode,
    backpressureLength: message?.backpressureProbe?.length,
  });
  process.disconnect();
});
