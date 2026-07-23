import { ok, strictEqual } from "node:assert/strict";
import { createRequire } from "node:module";
import * as dgram from "node:dgram";

const require = createRequire(import.meta.url);
const requiredDgram = require("dgram");

strictEqual(requiredDgram.createSocket, dgram.createSocket, "require dgram createSocket mismatch");
strictEqual(typeof dgram.Socket, "function", "dgram Socket should be exported");
strictEqual(typeof dgram.createSocket, "function", "dgram createSocket should be exported");
strictEqual(typeof dgram._createSocketHandle, "function", "dgram _createSocketHandle should be exported");

const handle = dgram._createSocketHandle("udp4");
ok(Number.isInteger(handle.fd) && handle.fd >= 0, "_createSocketHandle should return a native fd");
cottontail.udpSocketClose(handle.fd);

function bind(socket: dgram.Socket, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, address, () => resolve());
  });
}

function close(socket: dgram.Socket): Promise<void> {
  return new Promise((resolve) => socket.close(() => resolve()));
}

function connect(socket: dgram.Socket, port: number, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, address, () => resolve());
  });
}

const server = dgram.createSocket("udp4");
const client = dgram.createSocket({ type: "udp4" });

await bind(server, 0, "127.0.0.1");
const address = server.address();
strictEqual(address.address, "127.0.0.1", "dgram server address mismatch");
strictEqual(address.family, "IPv4", "dgram server family mismatch");
ok(address.port > 0, "dgram server should bind to an ephemeral port");
strictEqual(server.setBroadcast(true), undefined, "dgram setBroadcast return mismatch");
strictEqual(server.setTTL(64), 64, "dgram setTTL return mismatch");
strictEqual(server.setMulticastTTL(32), 32, "dgram setMulticastTTL return mismatch");
strictEqual(server.setMulticastLoopback(true), true, "dgram setMulticastLoopback return mismatch");
strictEqual(server.setRecvBufferSize(65536), undefined, "dgram setRecvBufferSize return mismatch");
strictEqual(server.setSendBufferSize(65536), undefined, "dgram setSendBufferSize return mismatch");
ok(server.getRecvBufferSize() > 0, "dgram getRecvBufferSize mismatch");
ok(server.getSendBufferSize() > 0, "dgram getSendBufferSize mismatch");
server.addMembership("224.0.0.114");
server.dropMembership("224.0.0.114");

const received = new Promise<{ message: Buffer; rinfo: dgram.RemoteInfo }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for UDP message")), 1000);
  server.once("message", (message, rinfo) => {
    clearTimeout(timer);
    resolve({ message, rinfo });
  });
});

await new Promise<void>((resolve, reject) => {
  client.send(Buffer.from("cottontail udp"), address.port, "127.0.0.1", (error, bytes) => {
    if (error) reject(error);
    else {
      strictEqual(bytes, "cottontail udp".length, "dgram send byte count mismatch");
      resolve();
    }
  });
});

const packet = await received;
strictEqual(packet.message.toString(), "cottontail udp", "dgram message mismatch");
strictEqual(packet.rinfo.address, "127.0.0.1", "dgram rinfo address mismatch");
strictEqual(packet.rinfo.family, "IPv4", "dgram rinfo family mismatch");
strictEqual(packet.rinfo.size, "cottontail udp".length, "dgram rinfo size mismatch");
ok(packet.rinfo.port > 0, "dgram rinfo port mismatch");

await connect(client, address.port, "127.0.0.1");
strictEqual(client.remoteAddress().address, "127.0.0.1", "dgram remoteAddress mismatch");
client.disconnect();

await close(client);
await close(server);

console.log("node dgram surface passed");
