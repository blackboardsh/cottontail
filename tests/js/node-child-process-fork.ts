import { fork } from "node:child_process";
import { connect as connectNet, createServer as createNetServer } from "node:net";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const childPath = `${import.meta.dirname}/fixtures/fork-child.js`;
const child = fork(childPath);
const messages: any[] = [];

const exit = new Promise<number | null>((resolve) => {
  child.on("message", (message) => {
    messages.push(message);
    if (message?.ready) child.send({ value: "ok" });
  });
  child.on("close", (code) => resolve(code));
});

const code = await exit;
assert(code === 0, `fork child exited with ${code}`);
assert(messages.some((message) => message?.ready === true), "fork child did not send ready message");
assert(messages.some((message) => message?.echo === "ok"), "fork child did not echo parent message");

const advancedChild = fork(childPath, [], { serialization: "advanced" });
const advancedMessages: any[] = [];
const advancedExit = new Promise<number | null>((resolve) => {
  advancedChild.on("message", (message) => {
    advancedMessages.push(message);
    if (message?.ready) {
      advancedChild.send({
        value: new Map<string, unknown>([
          ["bigint", 42n],
          ["bytes", new Uint8Array([1, 2, 3])],
        ]),
      });
    }
  });
  advancedChild.on("close", (closeCode) => resolve(closeCode));
});
const advancedCode = await advancedExit;
assert(advancedCode === 0, `advanced fork child exited with ${advancedCode}`);
const advancedEcho = advancedMessages.find((message) => message?.echo instanceof Map)?.echo;
assert(advancedEcho instanceof Map, "advanced fork did not echo a Map");
assert(advancedEcho.get("bigint") === 42n, "advanced fork BigInt mismatch");
const echoedBytes = advancedEcho.get("bytes");
assert(echoedBytes instanceof Uint8Array && echoedBytes[2] === 3, "advanced fork Uint8Array mismatch");

const socketChild = fork(childPath);
const socketMessages: any[] = [];
const socketExitPromise = new Promise<number | null>((resolve) => socketChild.on("close", (closeCode) => resolve(closeCode)));
await new Promise<void>((resolve, reject) => {
  socketChild.on("message", (message) => {
    socketMessages.push(message);
    if (message?.ready) resolve();
  });
  socketChild.on("error", reject);
});
const socketServer = createNetServer((socket) => {
  socketChild.send({ socketTest: true }, socket, (error: Error | null) => {
    if (error) socketChild.emit("error", error);
    socket.destroy();
  });
});
await new Promise<void>((resolve, reject) => {
  socketServer.once("error", reject);
  socketServer.listen(0, "127.0.0.1", () => resolve());
});
const socketAddress = socketServer.address();
if (socketAddress == null || typeof socketAddress === "string") throw new Error("socket handle server address mismatch");
const socketReply = await new Promise<string>((resolve, reject) => {
  const client = connectNet(socketAddress.port, "127.0.0.1");
  let data = "";
  client.setEncoding("utf8");
  client.once("error", reject);
  socketChild.once("error", reject);
  client.once("connect", () => client.write("from-parent-client"));
  client.on("data", (chunk) => { data += chunk; });
  client.on("end", () => resolve(data));
});
await new Promise<void>((resolve) => socketServer.close(() => resolve()));
const socketExit = await socketExitPromise;
assert(socketExit === 0, `socket handle child exited with ${socketExit}`);
assert(socketMessages.some((message) => message?.socketReceived === true), "fork socket handle was not received");
assert(socketMessages.some((message) => message?.socketData === "from-parent-client"), "fork socket handle data mismatch");
assert(socketReply === "from-child-socket", `fork socket handle reply mismatch: ${JSON.stringify(socketReply)}`);

const serverChild = fork(childPath);
const serverMessages: any[] = [];
const serverExitPromise = new Promise<number | null>((resolve) => serverChild.on("close", (closeCode) => resolve(closeCode)));
await new Promise<void>((resolve, reject) => {
  serverChild.on("message", (message) => {
    serverMessages.push(message);
    if (message?.ready) resolve();
  });
  serverChild.on("error", reject);
});
const parentServer = createNetServer();
await new Promise<void>((resolve, reject) => {
  parentServer.once("error", reject);
  parentServer.listen(0, "127.0.0.1", () => resolve());
});
const serverAddress = parentServer.address();
if (serverAddress == null || typeof serverAddress === "string") throw new Error("server handle address mismatch");
await new Promise<void>((resolve, reject) => {
  serverChild.send({ serverTest: true }, parentServer, (error: Error | null) => {
    if (error) reject(error);
    else resolve();
  });
});
await new Promise<void>((resolve) => parentServer.close(() => resolve()));
if (!serverMessages.some((message) => message?.serverReceived === true)) {
  await new Promise<void>((resolve, reject) => {
    const onMessage = (message: any) => {
      if (message?.serverReceived) resolve();
    };
    serverChild.on("message", onMessage);
    serverChild.on("error", reject);
  });
}
const serverReply = await new Promise<string>((resolve, reject) => {
  const client = connectNet(serverAddress.port, "127.0.0.1");
  let data = "";
  client.setEncoding("utf8");
  client.once("error", reject);
  client.on("data", (chunk) => { data += chunk; });
  client.on("end", () => resolve(data));
});
const serverExit = await serverExitPromise;
assert(serverExit === 0, `server handle child exited with ${serverExit}`);
assert(serverMessages.some((message) => message?.serverReceived === true), "fork server handle was not received");
assert(serverReply === "from-child-server", `fork server handle reply mismatch: ${JSON.stringify(serverReply)}`);

console.log("node child_process fork passed");
