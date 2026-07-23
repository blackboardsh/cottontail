import net, { Server, Socket, TCP, _createServerHandle, connect, createConnection, createServer, isIP, isIPv4, isIPv6 } from "node:net";
import { EADDRINUSE } from "node:constants";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(typeof net.connect === "function", "default net.connect missing");
assert(typeof connect === "function", "named connect missing");
assert(createConnection === connect, "createConnection should alias connect");
assert(typeof Socket === "function", "Socket constructor missing");
assert(typeof TCP === "function", "TCP constructor missing");
assert(isIP("127.0.0.1") === 4, "isIP IPv4 mismatch");
assert(isIPv4("127.0.0.1") === true, "isIPv4 mismatch");
assert(isIPv6("::1") === true, "isIPv6 mismatch");

const socket = new Socket();
assert(socket.ref() === socket, "Socket.ref should return socket");
assert(socket.unref() === socket, "Socket.unref should return socket");
assert(socket.setNoDelay() === socket, "Socket.setNoDelay should return socket before connect");
assert(socket.setNoDelay(false) === socket, "Socket.setNoDelay(false) should return socket before connect");
assert(socket.setKeepAlive() === socket, "Socket.setKeepAlive should return socket before connect");
assert(socket.setKeepAlive(true, 1000) === socket, "Socket.setKeepAlive(true, delay) should return socket before connect");
assert(socket.setTimeout(0) === socket, "Socket.setTimeout should return socket");
assert(socket.timeout === 0, "Socket.setTimeout should store timeout");

const timeoutSocket = new Socket();
let timeoutFired = false;
timeoutSocket.setTimeout(10, () => {
  timeoutFired = true;
});
await new Promise<void>((resolve) => setTimeout(resolve, 30));
assert(timeoutFired, "Socket timeout callback should fire");
timeoutSocket.destroy();

const server = createServer((serverSocket) => {
  assert(serverSocket instanceof Socket, "server connection should be a Socket");
  assert(serverSocket.setNoDelay(false) === serverSocket, "server setNoDelay should return socket");
  assert(serverSocket.setKeepAlive(false) === serverSocket, "server setKeepAlive should return socket");
  serverSocket.setEncoding("utf8");
  serverSocket.on("data", (chunk) => {
    assert(chunk === "ping", "server should receive client payload");
    serverSocket.write("pong");
    serverSocket.end();
  });
});
assert(server instanceof Server, "createServer should return Server");

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve());
});
const address = server.address();
assert(address && address.port > 0, "server should report a bound port");
assert(address.address === "127.0.0.1", "server should bind requested address");

const conflictingServer = createServer();
const addressInUseError = new Promise<any>((resolve) => conflictingServer.once("error", resolve));
conflictingServer.listen(address.port, "127.0.0.1");
const bindError = await addressInUseError;
assert(bindError.code === "EADDRINUSE", "duplicate listen error code mismatch");
assert(bindError.errno === -EADDRINUSE, "duplicate listen errno mismatch");

const client = connect(address.port, "127.0.0.1");
const received = await new Promise<string>((resolve, reject) => {
  let data = "";
  client.setEncoding("utf8");
  client.once("error", reject);
  client.on("connect", () => {
    assert(client.remotePort === address.port, "client remote port mismatch");
    assert(client.localPort > 0, "client local port should be set");
    assert(client.setNoDelay(true) === client, "client setNoDelay should return socket");
    assert(client.setKeepAlive(true, 1000) === client, "client setKeepAlive should return socket");
    assert(client.setTimeout(1000) === client, "client setTimeout should return socket");
    client.write("ping");
    client.end();
  });
  client.on("data", (chunk) => {
    data += chunk;
  });
  client.on("end", () => resolve(data));
});
assert(received === "pong", "client should receive server response");
assert(client.bytesWritten === 4, "client bytesWritten mismatch");
assert(client.bytesRead === 4, "client bytesRead mismatch");

await new Promise<void>((resolve) => server.close(() => resolve()));

const pauseServer = createServer((serverSocket) => {
  serverSocket.write("held");
  setTimeout(() => serverSocket.end("done"), 5);
});
await new Promise<void>((resolve, reject) => {
  pauseServer.once("error", reject);
  pauseServer.listen(0, "127.0.0.1", () => resolve());
});
const pauseAddress = pauseServer.address();
assert(pauseAddress && typeof pauseAddress !== "string", "pause server address mismatch");
const pauseClient = connect(pauseAddress.port, "127.0.0.1");
pauseClient.setEncoding("utf8");
pauseClient.pause();
let pausedData = "";
pauseClient.on("data", (chunk) => {
  pausedData += chunk;
});
await new Promise<void>((resolve, reject) => {
  pauseClient.once("connect", () => resolve());
  pauseClient.once("error", reject);
});
await new Promise<void>((resolve) => setTimeout(resolve, 30));
assert(pausedData === "", "Socket.pause should defer data events");
const resumedData = await new Promise<string>((resolve, reject) => {
  pauseClient.once("end", () => resolve(pausedData));
  pauseClient.once("error", reject);
  pauseClient.resume();
});
assert(resumedData === "helddone", `Socket.resume data mismatch: ${JSON.stringify(resumedData)}`);
await new Promise<void>((resolve) => pauseServer.close(() => resolve()));

const backpressureServer = createServer((serverSocket) => {
  serverSocket.on("data", () => {});
});
await new Promise<void>((resolve, reject) => {
  backpressureServer.once("error", reject);
  backpressureServer.listen(0, "127.0.0.1", () => resolve());
});
const backpressureAddress = backpressureServer.address();
assert(backpressureAddress && typeof backpressureAddress !== "string", "backpressure server address mismatch");
const backpressureClient = connect({ port: backpressureAddress.port, host: "127.0.0.1", highWaterMark: 2 });
await new Promise<void>((resolve, reject) => {
  backpressureClient.once("connect", () => resolve());
  backpressureClient.once("error", reject);
});
const acceptedBackpressure = backpressureClient.write("abcd");
assert(acceptedBackpressure === false, "Socket.write should report backpressure over highWaterMark");
assert(backpressureClient.writableNeedDrain === true, "Socket writableNeedDrain mismatch");
await new Promise<void>((resolve) => backpressureClient.once("drain", () => resolve()));
assert(backpressureClient.writableNeedDrain === false, "Socket writableNeedDrain should reset after drain");
assert(backpressureClient.writableLength === 0, "Socket writableLength should drain to zero");
backpressureClient.end();
await new Promise<void>((resolve) => backpressureServer.close(() => resolve()));

const ipcDir = "/tmp";
const ipcPath = `${ipcDir}/node-net-${Date.now()}.sock`;
try { cottontail.unlinkSync?.(ipcPath); } catch {}
const ipcServer = createServer((serverSocket) => {
  assert(serverSocket.remoteFamily === "Unix", "IPC server socket remote family mismatch");
  serverSocket.setEncoding("utf8");
  serverSocket.on("data", (chunk) => {
    assert(chunk === "ipc-ping", "IPC server payload mismatch");
    serverSocket.end("ipc-pong");
  });
});
await new Promise<void>((resolve, reject) => {
  ipcServer.once("error", reject);
  ipcServer.listen(ipcPath, () => resolve());
});
assert(ipcServer.address() === ipcPath, "IPC server address should be socket path");
const ipcClient = createConnection({ path: ipcPath });
const ipcResponse = await new Promise<string>((resolve, reject) => {
  let data = "";
  ipcClient.setEncoding("utf8");
  ipcClient.once("error", reject);
  ipcClient.once("connect", () => {
    assert(ipcClient.readyState === "open", "IPC client readyState mismatch");
    assert(ipcClient.remoteFamily === "Unix", "IPC client remote family mismatch");
    ipcClient.setNoDelay();
    ipcClient.setKeepAlive();
    ipcClient.write("ipc-ping");
  });
  ipcClient.on("data", (chunk) => {
    data += chunk;
  });
  ipcClient.on("end", () => resolve(data));
});
assert(ipcResponse === "ipc-pong", "IPC client response mismatch");
await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
assert(!cottontail.existsSync?.(ipcPath), "IPC socket path should be removed on close");

const handle = _createServerHandle("127.0.0.1", 0, 4);
assert(handle instanceof TCP, "_createServerHandle should return a TCP handle");
const sockname: { address?: string; family?: string; port?: number } = {};
assert(handle.getsockname(sockname) === 0, "TCP.getsockname should return 0");
assert(sockname.address === "127.0.0.1", "TCP.getsockname address mismatch");
assert(sockname.family === "IPv4", "TCP.getsockname family mismatch");
assert((sockname.port ?? 0) > 0, "TCP.getsockname port mismatch");
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("TCP handle did not accept a connection")), 1000);
  handle.onconnection = (error, clientHandle) => {
    try {
      assert(error === 0, "TCP onconnection error mismatch");
      assert(clientHandle instanceof TCP, "TCP onconnection handle mismatch");
      clientHandle.close();
      handle.close();
      clearTimeout(timer);
      resolve();
    } catch (assertionError) {
      clearTimeout(timer);
      reject(assertionError);
    }
  };
  assert(handle.listen(128) === 0, "TCP.listen should return 0");
  const handleClient = connect(sockname.port, "127.0.0.1");
  handleClient.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  handleClient.once("connect", () => handleClient.end());
});

console.log("node net passed");
