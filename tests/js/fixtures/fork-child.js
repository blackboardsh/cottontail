import { _forkChild } from "node:child_process";

_forkChild();
if (typeof process.send !== "function") throw new Error("_forkChild did not install process.send");

process.on("message", (message, handle) => {
  if (message?.socketTest && handle) {
    handle.setEncoding?.("utf8");
    handle.on?.("data", (chunk) => {
      process.send({ socketData: String(chunk) });
      handle.end?.("from-child-socket");
      process.exit(0);
    });
    process.send({ socketReceived: true });
    return;
  }
  if (message?.serverTest && handle) {
    handle.once?.("connection", (socket) => {
      socket.end("from-child-server");
      handle.close?.(() => process.exit(0));
    });
    process.send({ serverReceived: true });
    return;
  }
  process.send({ echo: message.value });
  process.exit(0);
});

process.send({ ready: true });
