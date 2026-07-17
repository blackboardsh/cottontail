import assert from "node:assert/strict";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls-cert.js";

const callableServer = net.Server();
assert.ok(callableServer instanceof net.Server);
assert.equal(net.Server.length, 2);
assert.equal(callableServer.connections, undefined);
assert.equal(callableServer.address(), null);

assert.deepEqual(net.SocketAddress.parse("192.168.257:7")?.toJSON(), {
  address: "192.168.1.1",
  port: 7,
  family: "ipv4",
  flowlabel: 0,
});
assert.deepEqual(net.SocketAddress.parse("[1:0::]:9")?.toJSON(), {
  address: "1::",
  port: 9,
  family: "ipv6",
  flowlabel: 0,
});
assert.equal(net.SocketAddress.parse("1.2.3.4:65536"), undefined);

const blockList = new net.BlockList();
blockList.addAddress("1.1.1.1");
blockList.addRange("10.0.0.2", "10.0.0.10");
blockList.addSubnet("2001:db8::", 48, "ipv6");
assert.equal(blockList.check("::ffff:1.1.1.1", "ipv6"), true);
assert.equal(blockList.check("::ffff:10.0.0.5", "ipv6"), true);
assert.equal(blockList.check("2001:db8:0:ffff::1", "ipv6"), true);
assert.equal(blockList.check("2001:db9::1", "ipv6"), false);
assert.deepEqual(blockList.rules, [
  "Subnet: IPv6 2001:db8::/48",
  "Range: IPv4 10.0.0.2-10.0.0.10",
  "Address: IPv4 1.1.1.1",
]);

assert.equal(tls.checkServerIdentity("api.example.com", {
  subject: { CN: "ignored.example.com" },
  subjectaltname: "DNS:*.example.com",
}), undefined);
assert.equal(tls.checkServerIdentity("deep.api.example.com", {
  subjectaltname: "DNS:*.example.com",
})?.code, "ERR_TLS_CERT_ALTNAME_INVALID");
assert.equal(tls.checkServerIdentity("127.0.0.1", {
  subjectaltname: "IP Address:127.0.0.1",
}), undefined);

const familyServer = net.createServer((socket) => socket.end("family-fallback"));
familyServer.listen(0, "127.0.0.1");
await once(familyServer, "listening");
const familyAddress = familyServer.address();
assert.ok(familyAddress && typeof familyAddress === "object");
const familyClient = net.connect({ host: "localhost", port: familyAddress.port });
familyClient.setEncoding("utf8");
let familyResponse = "";
familyClient.on("data", (chunk) => { familyResponse += chunk; });
await once(familyClient, "end");
familyServer.close();
await once(familyServer, "close");
assert.equal(familyResponse, "family-fallback");

const dropServer = net.createServer();
dropServer.maxConnections = 0;
dropServer.listen(0, "127.0.0.1");
await once(dropServer, "listening");
const dropAddress = dropServer.address();
assert.ok(dropAddress && typeof dropAddress === "object");
const dropped = once(dropServer, "drop");
const dropClient = net.connect({ host: "127.0.0.1", port: dropAddress.port });
await dropped;
dropServer.close();
await once(dropServer, "close");
dropClient.destroy();

assert.ok(tls.SecureContext({ cert, key }) instanceof tls.SecureContext);
assert.ok(tls.Server({ cert, key }) instanceof tls.Server);

const serverEvents: string[] = [];
const server = tls.createServer({ cert, key, ALPNProtocols: ["cottontail-source-port"] });
let acceptedSocket: tls.TLSSocket | undefined;
server.on("connection", (socket) => {
  assert.ok(socket instanceof tls.TLSSocket, "TLS connection must expose TLSSocket, not a detached net.Socket");
  acceptedSocket = socket;
  serverEvents.push("connection");
  socket.once("secure", () => serverEvents.push("secure"));
  socket.once("data", (chunk) => socket.end(`reply:${chunk.toString()}`));
});
server.on("secureConnection", (socket) => {
  serverEvents.push("secureConnection");
  assert.equal(socket, acceptedSocket);
  assert.equal(socket.alpnProtocol, "cottontail-source-port");
  assert.equal(socket.getCertificate().subject?.CN, "localhost");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

const clientEvents: string[] = [];
const client = tls.connect({
  host: "127.0.0.1",
  port: address.port,
  servername: "localhost",
  rejectUnauthorized: false,
  ALPNProtocols: ["cottontail-source-port"],
});
client.on("connect", () => clientEvents.push("connect"));
client.on("secure", () => clientEvents.push("secure"));
client.on("secureConnect", () => clientEvents.push("secureConnect"));
client.setEncoding("utf8");
let response = "";
client.on("data", (chunk) => { response += chunk; });
const clientEnded = once(client, "end");
client.write("queued-before-handshake");

await once(client, "secureConnect");
assert.equal(client.alpnProtocol, "cottontail-source-port");
assert.equal(client.getPeerCertificate().subject?.CN, "localhost");
assert.equal(client.getPeerX509Certificate()?.subject, "CN=localhost");
assert.equal(client.getProtocol()?.startsWith("TLSv1."), true);
assert.equal(client.getSession() instanceof Buffer, true);

let closeEmitted = false;
server.once("close", () => { closeEmitted = true; });
const serverClosed = once(server, "close");
server.close();
assert.equal(server.address(), null);
assert.equal(closeEmitted, false, "server close must drain its live TLS socket");

await clientEnded;
assert.equal(response, "reply:queued-before-handshake");
await serverClosed;
assert.equal(closeEmitted, true);
assert.deepEqual(serverEvents, ["connection", "secureConnection", "secure"]);
assert.deepEqual(clientEvents, ["connect", "secure", "secureConnect"]);

const renegotiationProbe = new tls.TLSSocket();
const renegotiationError = await new Promise<Error>((resolve) => {
  assert.equal(renegotiationProbe.renegotiate({}, resolve), false);
});
assert.equal((renegotiationError as Error & { code?: string }).code, "ERR_TLS_RENEGOTIATION_UNSUPPORTED");

console.log("node net/tls source port passed");
