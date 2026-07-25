import { fork, type ChildProcess } from "node:child_process";
import { createServer as createNetServer, type Server } from "node:net";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function waitForMessage(
  child: ChildProcess,
  predicate: (message: any) => boolean,
  timeoutMs = 10_000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for IPC message from child ${child.pid}`));
    }, timeoutMs);
    const onMessage = (message: any) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
    };
    child.on("message", onMessage);
    child.on("error", onError);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${label}`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

const childPath = `${import.meta.dirname}/fixtures/windows-ipc-ack-scope-child.js`;
const victim = fork(childPath);
const sibling = fork(childPath);
let server: Server | undefined;

try {
  await Promise.all([
    waitForMessage(victim, (message) => message?.ready === true),
    waitForMessage(sibling, (message) => message?.ready === true),
  ]);

  server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address != null && typeof address !== "string", "socket server address was unavailable");

  const blocking = waitForMessage(victim, (message) => message?.blocking === true);
  victim.send({ block: true, duration: 1_500 });
  await blocking;

  let transferCallbackCalled = false;
  const transferFinished = new Promise<void>((resolve, reject) => {
    victim.send(
      { transfer: true },
      server!,
      { keepOpen: true },
      (error: Error | null) => {
        transferCallbackCalled = true;
        if (error) reject(error);
        else resolve();
      },
    );
  });
  const victimReceived = waitForMessage(
    victim,
    (message) => message?.receivedTransfer === true,
  );

  // This is the first handle sent by this parent, so its sequence is 1.
  // A sibling channel must not be able to acknowledge that transfer.
  const forged = waitForMessage(sibling, (message) => message?.forgedAck === true);
  sibling.send({ forgeAck: true, handleSeq: 1 });
  const forgedResult = await forged;
  assert(forgedResult.ok === true, "sibling failed to write the forged ACK frame");

  await delay(250);
  assert(
    transferCallbackCalled === false,
    "an ACK received on a sibling IPC channel completed the victim's handle transfer",
  );

  await withTimeout(
    Promise.all([transferFinished, victimReceived]),
    10_000,
    "the victim's real handle-transfer ACK",
  );

  console.log("node child_process Windows IPC ACK scoping passed");
} finally {
  if (server?.listening) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
  for (const child of [victim, sibling]) {
    if (child.exitCode == null) {
      try { child.send({ exit: true }); } catch {}
      try { child.kill(); } catch {}
    }
  }
}
