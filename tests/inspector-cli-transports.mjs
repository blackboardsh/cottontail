import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.resolve(process.argv[2] ?? path.join(root, "zig-out/bin/cottontail"));
const inspectee = path.join(root, "tests/js/fixtures/cli-inspect/inspectee.js");
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-inspector-"));
const cleanEnvironment = { ...process.env };
delete cleanEnvironment.BUN_INSPECT;
delete cleanEnvironment.BUN_INSPECT_CONNECT_TO;
delete cleanEnvironment.BUN_INSPECT_NOTIFY;

function withTimeout(promise, label, milliseconds = 10_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function frame(message) {
  const body = Buffer.from(message);
  const output = Buffer.allocUnsafe(body.length + 4);
  output.writeUInt32BE(body.length, 0);
  body.copy(output, 4);
  return output;
}

function evaluateOverFramedSocket(socket, expression = "20 + 22") {
  return withTimeout(
    new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      socket.on("error", reject);
      socket.on("data", data => {
        buffered = buffered.length ? Buffer.concat([buffered, data]) : data;
        while (buffered.length >= 4) {
          const length = buffered.readUInt32BE(0);
          if (buffered.length < length + 4) return;
          const payload = buffered.toString("utf8", 4, length + 4);
          buffered = buffered.subarray(length + 4);
          const message = JSON.parse(payload);
          if (message.id === 1) resolve(message);
        }
      });
      socket.write(frame(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression },
      })));
    }),
    "framed inspector response",
  );
}

function spawnInspectee(args, options = {}) {
  const child = spawn(executable, [...args, inspectee], {
    cwd: root,
    env: options.env ?? cleanEnvironment,
    stdio: options.stdio ?? ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", chunk => {
    stderr += chunk;
  });
  child.inspectorStderr = () => stderr;
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once("close", resolve));
  child.kill("SIGTERM");
  await withTimeout(closed, "inspector child shutdown", 5_000);
}

function assertEvaluation(message, label) {
  assert.equal(message.result?.result?.type, "number", `${label}: result type`);
  assert.equal(message.result?.result?.value, 42, `${label}: result value`);
}

async function unixFramedTest() {
  const socketPath = path.join(temporaryDirectory, "framed.sock");
  const server = net.createServer();
  const connection = new Promise(resolve => server.once("connection", resolve));
  await listen(server, socketPath);
  const child = spawnInspectee([`--inspect=unix:${socketPath}`]);
  try {
    const socket = await withTimeout(connection, "Unix inspector connection");
    assertEvaluation(await evaluateOverFramedSocket(socket), "Unix inspector");
    socket.destroy();
  } catch (error) {
    error.message += `\n${child.inspectorStderr()}`;
    throw error;
  } finally {
    await stopChild(child);
    await closeServer(server);
  }
}

async function tcpFramedTest() {
  const server = net.createServer();
  const connection = new Promise(resolve => server.once("connection", resolve));
  await listen(server, { host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  const child = spawnInspectee([`--inspect=tcp://127.0.0.1:${port}`]);
  try {
    const socket = await withTimeout(connection, "TCP inspector connection");
    assertEvaluation(await evaluateOverFramedSocket(socket), "TCP inspector");
    socket.destroy();
  } catch (error) {
    error.message += `\n${child.inspectorStderr()}`;
    throw error;
  } finally {
    await stopChild(child);
    await closeServer(server);
  }
}

async function inheritedFdTest() {
  const server = net.createServer();
  const accepted = new Promise(resolve => server.once("connection", resolve));
  await listen(server, { host: "127.0.0.1", port: 0 });
  const inherited = net.connect(server.address().port, "127.0.0.1");
  await withTimeout(new Promise((resolve, reject) => {
    inherited.once("connect", resolve);
    inherited.once("error", reject);
  }), "fd setup connection");
  const peer = await withTimeout(accepted, "fd accepted connection");
  const child = spawnInspectee(["--inspect=fd:3"], {
    stdio: ["ignore", "ignore", "pipe", inherited],
  });
  try {
    assertEvaluation(await evaluateOverFramedSocket(peer), "fd inspector");
  } catch (error) {
    error.message += `\n${child.inspectorStderr()}`;
    throw error;
  } finally {
    await stopChild(child);
    inherited.destroy();
    peer.destroy();
    await closeServer(server);
  }
}

async function connectAndNotifyTest(notifyTransport) {
  const inspectorPath = path.join(temporaryDirectory, `connect-to-${notifyTransport}.sock`);
  const inspectorServer = net.createServer();
  const notifyServer = net.createServer();
  const inspectorConnection = new Promise(resolve => inspectorServer.once("connection", resolve));
  const notification = new Promise((resolve, reject) => {
    notifyServer.once("connection", socket => {
      socket.once("error", reject);
      socket.once("data", data => {
        resolve(data.toString());
        socket.destroy();
      });
    });
  });
  await listen(inspectorServer, inspectorPath);
  let notifyAddress;
  if (notifyTransport === "unix") {
    const notifyPath = path.join(temporaryDirectory, "notify.sock");
    await listen(notifyServer, notifyPath);
    notifyAddress = `unix://${notifyPath}`;
  } else {
    await listen(notifyServer, { host: "127.0.0.1", port: 0 });
    notifyAddress = `tcp://127.0.0.1:${notifyServer.address().port}`;
  }
  const child = spawnInspectee([], {
    env: {
      ...cleanEnvironment,
      BUN_INSPECT: "",
      BUN_INSPECT_CONNECT_TO: inspectorPath,
      BUN_INSPECT_NOTIFY: notifyAddress,
    },
  });
  try {
    const socket = await withTimeout(inspectorConnection, `BUN_INSPECT_CONNECT_TO ${notifyTransport} connection`);
    const [message, notified] = await Promise.all([
      evaluateOverFramedSocket(socket),
      withTimeout(notification, `BUN_INSPECT_NOTIFY ${notifyTransport}`),
    ]);
    assertEvaluation(message, `BUN_INSPECT_CONNECT_TO ${notifyTransport}`);
    assert.equal(notified, "1", `BUN_INSPECT_NOTIFY ${notifyTransport} payload`);
    socket.destroy();
  } catch (error) {
    error.message += `\n${child.inspectorStderr()}`;
    throw error;
  } finally {
    await stopChild(child);
    await closeServer(inspectorServer);
    await closeServer(notifyServer);
  }
}

function websocketFrame(message) {
  const payload = Buffer.from(message);
  assert.ok(payload.length < 126, "test request must use a short WebSocket frame");
  const mask = Buffer.from([0x13, 0x37, 0x42, 0x99]);
  const output = Buffer.allocUnsafe(payload.length + 6);
  output[0] = 0x81;
  output[1] = 0x80 | payload.length;
  mask.copy(output, 2);
  for (let index = 0; index < payload.length; index++)
    output[index + 6] = payload[index] ^ mask[index & 3];
  return output;
}

async function connectUnixEventually(socketPath) {
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", error => {
          socket.destroy();
          reject(error);
        });
      });
    } catch {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error("ws+unix inspector socket did not appear");
}

async function websocketUnixTest() {
  const socketPath = path.join(temporaryDirectory, "websocket.sock");
  const child = spawnInspectee([`--inspect=ws+unix://${socketPath}`]);
  let socket;
  try {
    socket = await withTimeout(connectUnixEventually(socketPath), "ws+unix connection");
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    let resolveUpgrade;
    let rejectRequest;
    const upgrade = new Promise((resolve, reject) => {
      resolveUpgrade = resolve;
      rejectRequest = reject;
    });
    const response = new Promise((resolve, reject) => {
      const fail = error => {
        rejectRequest(error);
        reject(error);
      };
      socket.on("error", fail);
      socket.on("data", data => {
        buffered = buffered.length ? Buffer.concat([buffered, data]) : data;
        if (!upgraded) {
          const headerEnd = buffered.indexOf("\r\n\r\n");
          if (headerEnd < 0) return;
          const headers = buffered.toString("latin1", 0, headerEnd);
          assert.match(headers, /^HTTP\/1\.1 101 /);
          buffered = buffered.subarray(headerEnd + 4);
          upgraded = true;
          resolveUpgrade();
        }
        while (upgraded && buffered.length >= 2) {
          let length = buffered[1] & 0x7f;
          let headerLength = 2;
          if (length === 126) {
            if (buffered.length < 4) return;
            length = buffered.readUInt16BE(2);
            headerLength = 4;
          } else if (length === 127) {
            if (buffered.length < 10) return;
            length = Number(buffered.readBigUInt64BE(2));
            headerLength = 10;
          }
          if (buffered.length < headerLength + length) return;
          const opcode = buffered[0] & 0x0f;
          const payload = buffered.toString("utf8", headerLength, headerLength + length);
          buffered = buffered.subarray(headerLength + length);
          if (opcode === 1) {
            const message = JSON.parse(payload);
            if (message.id === 1) resolve(message);
          }
        }
      });
    });
    socket.write(
      "GET /any-inspector-path HTTP/1.1\r\n" +
      "Host: localhost\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
    );
    await withTimeout(upgrade, "ws+unix WebSocket upgrade");
    socket.write(websocketFrame(JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "20 + 22" },
    })));
    assertEvaluation(await withTimeout(response, "ws+unix inspector response"), "ws+unix inspector");
  } catch (error) {
    error.message += `\n${child.inspectorStderr()}`;
    throw error;
  } finally {
    socket?.destroy();
    await stopChild(child);
    fs.rmSync(socketPath, { force: true });
  }
}

try {
  await unixFramedTest();
  await tcpFramedTest();
  await inheritedFdTest();
  await connectAndNotifyTest("unix");
  await connectAndNotifyTest("tcp");
  await websocketUnixTest();
  console.log("inspector CLI transports passed");
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
