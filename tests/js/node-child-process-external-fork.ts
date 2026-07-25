import { fork } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const node = Bun.which("node");
assert(node, "Node executable is required for the external fork conformance test");

const child = fork(`${import.meta.dirname}/fixtures/external-node-fork-child.cjs`, [], {
  execPath: node,
  silent: true,
});

let stderr = "";
child.stderr?.on("data", chunk => {
  stderr += chunk.toString();
});

await new Promise<void>((resolve, reject) => {
  let receivedPong = false;
  let sendCallbackCalled = false;
  let sendCallbackError: unknown = undefined;
  const backpressureLength = 1024 * 1024 + 4096;
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error(`external Node fork timed out: ${stderr}`));
  }, 30_000);

  child.once("error", error => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on("message", message => {
    if (message?.ready) {
      assert(message.runtime === "node", `fork used the wrong runtime: ${message.runtime}`);
      assert(
        message.framingProbe?.startsWith("node-ipc-\ud83d\ude42-") &&
          message.framingProbe?.endsWith("-tail") &&
          message.framingProbe.length > 96 * 1024,
        "external Node fork lost a split libuv IPC frame",
      );
      const canContinue = child.send(
        {
          ping: "round-trip",
          unicode: "parent-\ud83d\ude42-child",
          backpressureProbe: "y".repeat(backpressureLength),
        },
        error => {
          sendCallbackCalled = true;
          sendCallbackError = error;
        },
      );
      assert(canContinue === false, "external Node IPC send did not expose pipe backpressure");
    } else if (
      message?.pong === "round-trip" &&
      message?.unicodeEcho === "parent-\ud83d\ude42-child" &&
      message?.backpressureLength === backpressureLength
    ) {
      receivedPong = true;
    }
  });
  child.once("close", code => {
    clearTimeout(timeout);
    if (code !== 0) reject(new Error(`external Node fork exited with ${code}: ${stderr}`));
    else if (!receivedPong) reject(new Error("external Node fork closed before the IPC round trip completed"));
    else if (!sendCallbackCalled) reject(new Error("external Node IPC send callback was not called"));
    else if (sendCallbackError != null) reject(sendCallbackError);
    else resolve();
  });
});

console.log("node child_process external fork passed");
