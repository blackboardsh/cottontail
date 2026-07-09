import net, { Socket, connect, createConnection, isIP, isIPv4, isIPv6 } from "node:net";

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

console.log("node net passed");
