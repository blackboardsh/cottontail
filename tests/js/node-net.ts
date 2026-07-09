import net, { Server, Socket, connect, createConnection, createServer, isIP, isIPv4, isIPv6 } from "node:net";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(typeof net.connect === "function", "default net.connect missing");
assert(typeof connect === "function", "named connect missing");
assert(createConnection === connect, "createConnection should alias connect");
assert(typeof Socket === "function", "Socket constructor missing");
assert(isIP("127.0.0.1") === 4, "isIP IPv4 mismatch");
assert(isIPv4("127.0.0.1") === true, "isIPv4 mismatch");
assert(isIPv6("::1") === true, "isIPv6 mismatch");

const socket = new Socket();
assert(socket.ref() === socket, "Socket.ref should return socket");
assert(socket.unref() === socket, "Socket.unref should return socket");

const server = createServer((serverSocket) => {
  assert(serverSocket instanceof Socket, "server connection should be a Socket");
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

const client = connect(address.port, "127.0.0.1");
const received = await new Promise<string>((resolve, reject) => {
  let data = "";
  client.setEncoding("utf8");
  client.once("error", reject);
  client.on("connect", () => {
    assert(client.remotePort === address.port, "client remote port mismatch");
    assert(client.localPort > 0, "client local port should be set");
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

console.log("node net passed");
