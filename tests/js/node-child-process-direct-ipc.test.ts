import { spawn } from "node:child_process";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitForClose(child: ReturnType<typeof spawn>, label: string) {
  let stderr = "";
  child.stderr?.on("data", chunk => {
    stderr += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out: ${stderr}`));
    }, 25_000);
    child.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", code => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${label} exited with ${code}: ${stderr}`));
    });
  });
}

const node = Bun.which("node");
assert(node, "Node executable is required for the direct IPC conformance test");

{
  const ipcIndex = 5;
  const stdio = ["ignore", "ignore", "pipe", "ignore", "ignore", "ipc"] as const;
  const child = spawn(node, [join(import.meta.dirname, "fixtures", "external-node-fork-child.cjs")], {
    stdio: [...stdio],
  });
  assert(child.connected, "external Node direct spawn did not expose a connected IPC channel");
  assert(typeof child.send === "function", "external Node direct spawn did not expose send()");
  assert(child.stdio.length === stdio.length, "external Node direct spawn leaked its IPC transport");
  assert(child.stdio[ipcIndex] === null, "external Node direct spawn exposed its IPC stream in child.stdio");

  let receivedPong = false;
  child.on("message", message => {
    if (message?.ready) {
      assert(message.runtime === "node", `direct spawn used the wrong runtime: ${message.runtime}`);
      assert(
        message.framingProbe?.startsWith("node-ipc-\ud83d\ude42-") &&
          message.framingProbe?.endsWith("-tail") &&
          message.framingProbe.length > 96 * 1024,
        "external Node direct spawn lost a split libuv IPC frame",
      );
      child.send({ ping: "direct-extra-fd", unicode: "direct-\ud83d\ude42-child" });
    } else if (
      message?.pong === "direct-extra-fd" &&
      message?.unicodeEcho === "direct-\ud83d\ude42-child"
    ) {
      receivedPong = true;
    }
  });
  await waitForClose(child, "external Node direct IPC");
  assert(receivedPong, "external Node direct spawn closed before the IPC round trip completed");
}

{
  // Windows' standard-handle pipes are one-way. Cottontail preserves Node's
  // public primary-slot contract while routing the channel through a hidden
  // duplex descriptor in the child.
  const ipcIndex = 0;
  const stdio = ["ipc", "ignore", "pipe", "ignore"] as const;
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, "fixtures", "child-process-ipc-bootstrap-child.js")],
    { serialization: "advanced", stdio: [...stdio] },
  );
  assert(child.connected, "Cottontail direct spawn did not expose a connected IPC channel");
  assert(typeof child.send === "function", "Cottontail direct spawn did not expose send()");
  assert(child.stdio.length === stdio.length, "primary-slot direct spawn leaked its IPC transport");
  assert(child.stdio[ipcIndex] === null, "primary-slot direct spawn exposed its IPC stream in child.stdio");

  let receivedAdvancedReply = false;
  child.on("message", message => {
    if (!message?.ready) {
      receivedAdvancedReply =
        message?.bigint === 42n &&
        message?.map instanceof Map &&
        message.map.get("source") === "direct-primary-slot" &&
        message?.typed instanceof Uint8Array &&
        message.typed[2] === 7 &&
        message?.receivedCycle === true &&
        message?.self === message;
      return;
    }
    const request: any = {
      bigint: 41n,
      map: new Map([["source", "direct-primary-slot"]]),
      typed: new Uint8Array([3, 5, 7]),
    };
    request.self = request;
    child.send(request);
  });
  await waitForClose(child, "Cottontail primary-slot direct IPC");
  assert(receivedAdvancedReply, "Cottontail direct spawn lost advanced IPC values");
}

console.log("node child_process direct IPC passed");
