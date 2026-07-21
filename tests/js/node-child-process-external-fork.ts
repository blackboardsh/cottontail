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
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error(`external Node fork timed out: ${stderr}`));
  }, 10_000);

  child.once("error", error => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on("message", message => {
    if (message?.ready) {
      assert(message.runtime === "node", `fork used the wrong runtime: ${message.runtime}`);
      child.send({ ping: "round-trip" });
    } else if (message?.pong === "round-trip") {
      receivedPong = true;
    }
  });
  child.once("close", code => {
    clearTimeout(timeout);
    if (code !== 0) reject(new Error(`external Node fork exited with ${code}: ${stderr}`));
    else if (!receivedPong) reject(new Error("external Node fork closed before the IPC round trip completed"));
    else resolve();
  });
});

console.log("node child_process external fork passed");
