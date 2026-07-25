import { _forkChild } from "node:child_process";

_forkChild();
if (typeof process.send !== "function") throw new Error("_forkChild did not install process.send");

process.on("message", (message, handle) => {
  if (message?.block) {
    process.send({ blocking: true });
    const deadline = Date.now() + Number(message.duration ?? 1_500);
    while (Date.now() < deadline) {}
    process.send({ unblocked: true });
    return;
  }

  if (message?.forgeAck) {
    const fd = Number(process.env.COTTONTAIL_IPC_FD);
    const frame =
      `__COTTONTAIL_IPC__J:${JSON.stringify({
        __cottontailIpcEnvelope: 4,
        handleSeq: Number(message.handleSeq),
      })}\n`;
    const ok = Number.isInteger(fd) &&
      fd >= 0 &&
      globalThis.cottontail?.fdWrite?.(fd, frame) === true;
    process.send({ forgedAck: true, ok });
    return;
  }

  if (message?.transfer && handle) {
    handle.destroy?.();
    handle.close?.();
    process.send({ receivedTransfer: true });
    return;
  }

  if (message?.exit) process.exit(0);
});

process.send({ ready: true });
