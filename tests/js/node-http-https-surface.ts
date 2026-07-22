import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { createRequire } from "node:module";
import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import { createHash } from "node:crypto";
import { connect as connectNet, createServer as createNetServer } from "node:net";
import { cert, key } from "./fixtures/tls-cert.js";

const require = createRequire(import.meta.url);
const requiredHttp = require("http");
const requiredHttps = require("node:https");

const expectedHttpFunctions = [
  "_connectionListener",
  "createServer",
  "get",
  "request",
  "setMaxIdleHTTPParsers",
  "validateHeaderName",
  "validateHeaderValue",
];

for (const name of expectedHttpFunctions) {
  strictEqual(typeof (http as Record<string, unknown>)[name], "function", `http.${name} should be exported`);
}

for (const name of ["Agent", "ClientRequest", "IncomingMessage", "OutgoingMessage", "Server", "ServerResponse", "WebSocket"]) {
  strictEqual(typeof (http as Record<string, unknown>)[name], "function", `http.${name} should be exported`);
}

strictEqual(requiredHttp.createServer, http.createServer, "require http createServer mismatch");
strictEqual(requiredHttps.request, https.request, "require https request mismatch");
strictEqual(http.STATUS_CODES[200], "OK", "http STATUS_CODES mismatch");
ok(http.METHODS.includes("GET"), "http METHODS should include GET");
strictEqual(typeof http.globalAgent.getName, "function", "http globalAgent mismatch");
strictEqual(typeof http.maxHeaderSize, "number", "http maxHeaderSize mismatch");
http.validateHeaderName("x-cottontail");
http.validateHeaderValue("x-cottontail", "ok");
throws(() => http.validateHeaderName("bad header"), /valid HTTP token/, "invalid header name should throw");
throws(() => http.validateHeaderValue("x-test", "bad\nvalue"), /Invalid value/, "invalid header value should throw");

strictEqual(typeof https.Agent, "function", "https Agent should be exported");
strictEqual(typeof https.Server, "function", "https Server should be exported");
strictEqual(typeof https.createServer, "function", "https createServer should be exported");
strictEqual(typeof https.get, "function", "https get should be exported");
strictEqual(typeof https.globalAgent.getName, "function", "https globalAgent mismatch");

const agentServer = createNetServer((socket) => {
  socket.end("agent-ok");
});
await new Promise<void>((resolve, reject) => {
  agentServer.once("error", reject);
  agentServer.listen(0, "127.0.0.1", () => resolve());
});
const agentAddress = agentServer.address();
if (agentAddress == null || typeof agentAddress === "string") throw new Error("agent net server address should be an object");
const agentSocket = http.globalAgent.createConnection({ host: "127.0.0.1", port: agentAddress.port });
agentSocket.setEncoding("utf8");
const agentPayload = await new Promise<string>((resolve, reject) => {
  let data = "";
  agentSocket.once("error", reject);
  agentSocket.on("data", (chunk) => {
    data += chunk;
  });
  agentSocket.on("end", () => resolve(data));
});
strictEqual(agentPayload, "agent-ok", "http.Agent.createConnection should return connected net socket");
await new Promise<void>((resolve) => agentServer.close(() => resolve()));

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/get") {
      res.setHeader("x-reply", "get");
      res.end("get-ok");
      return;
    }
    if (req.method === "GET" && req.url === "/server-trailers") {
      res.setHeader("Trailer", "X-Server-Trailer");
      res.write("server-");
      res.addTrailers({ "X-Server-Trailer": "done" });
      res.end("trailers");
      return;
    }
    strictEqual(req.method, "POST", "server request method mismatch");
    strictEqual(req.url, "/roundtrip?ok=1", "server request url mismatch");
    strictEqual(req.headers["x-cottontail"], "yes", "server request header mismatch");
    res.statusCode = 201;
    res.statusMessage = "Created";
    res.setHeader("content-type", "text/plain");
    res.setHeader("x-reply", "done");
    res.end(`echo:${body}`);
  });
});

await listen(server, 0, "127.0.0.1");
const address = server.address();
if (address == null || typeof address === "string") throw new Error("http server address should be an object");
ok(address.port > 0, "http server should receive a port");

const clientRequest = http.request(`http://127.0.0.1:${address.port}/roundtrip?ok=1`);
strictEqual(clientRequest instanceof http.ClientRequest, true, "http.request should return a ClientRequest");
clientRequest.abort();

const postBody = await new Promise<string>((resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1",
    port: address.port,
    path: "/roundtrip?ok=1",
    method: "POST",
    headers: { "x-cottontail": "yes" },
  }, (res) => {
    strictEqual(res.statusCode, 201, "http server status mismatch");
    strictEqual(res.statusMessage, "Created", "http server status message mismatch");
    strictEqual(res.headers["x-reply"], "done", "http server response header mismatch");
    let data = "";
    res.on("data", (chunk) => {
      data += chunk.toString();
    });
    res.on("end", () => resolve(data));
  });
  req.once("error", reject);
  req.end("payload");
});
strictEqual(postBody, "echo:payload", "http server response body mismatch");

let continueSeen = false;
const continueBody = await new Promise<string>((resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1",
    port: address.port,
    path: "/roundtrip?ok=1",
    method: "POST",
    headers: { "x-cottontail": "yes", Expect: "100-continue" },
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk.toString(); });
    res.on("end", () => resolve(data));
  });
  req.once("continue", () => { continueSeen = true; });
  req.once("error", reject);
  req.end("continue-payload");
});
strictEqual(continueSeen, true, "http client should emit continue for 100-continue");
strictEqual(continueBody, "echo:continue-payload", "http 100-continue body mismatch");

const getResponseText = await new Promise<string>((resolve, reject) => {
  const req = http.get(`http://127.0.0.1:${address.port}/get`, (res) => {
    strictEqual(res.statusCode, 200, "http get status mismatch");
    strictEqual(res.headers["x-reply"], "get", "http get response header mismatch");
    let data = "";
    res.on("data", (chunk) => {
      data += chunk.toString();
    });
    res.on("end", () => resolve(data));
  });
  req.once("error", reject);
});
strictEqual(getResponseText, "get-ok", "http server get response mismatch");

const keepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const keepAliveRequests: http.ClientRequest[] = [];
async function keepAliveGet() {
  return await new Promise<string>((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1",
      port: address.port,
      path: "/get",
      agent: keepAliveAgent,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
    });
    keepAliveRequests.push(req);
    req.once("error", reject);
  });
}
strictEqual(await keepAliveGet(), "get-ok", "http keep-alive first response mismatch");
strictEqual(await keepAliveGet(), "get-ok", "http keep-alive second response mismatch");
strictEqual(keepAliveRequests[0].reusedSocket, false, "first http keep-alive request should not reuse a socket");
strictEqual(keepAliveRequests[1].reusedSocket, true, "second http keep-alive request should reuse the agent socket");
keepAliveAgent.destroy();

const serverTrailerBody = await new Promise<string>((resolve, reject) => {
  const req = http.get(`http://127.0.0.1:${address.port}/server-trailers`, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk.toString(); });
    res.on("end", () => {
      strictEqual(res.trailers["x-server-trailer"], "done", "http server response trailers mismatch");
      resolve(data);
    });
  });
  req.once("error", reject);
});
strictEqual(serverTrailerBody, "server-trailers", "http server trailer body mismatch");

const trailerServer = createNetServer((socket) => {
  socket.once("data", () => {
    socket.end([
      "HTTP/1.1 200 OK",
      "Transfer-Encoding: chunked",
      "Trailer: X-Trailer",
      "",
      "5",
      "hello",
      "0",
      "X-Trailer: done",
      "",
      "",
    ].join("\r\n"));
  });
});
await listen(trailerServer as unknown as http.Server, 0, "127.0.0.1");
const trailerAddress = trailerServer.address();
if (trailerAddress == null || typeof trailerAddress === "string") throw new Error("trailer server address should be an object");
const trailerBody = await new Promise<string>((resolve, reject) => {
  const req = http.get(`http://127.0.0.1:${trailerAddress.port}/trailers`, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk.toString(); });
    res.on("end", () => {
      strictEqual(res.trailers["x-trailer"], "done", "http response trailers mismatch");
      deepStrictEqual(res.rawTrailers, ["X-Trailer", "done"], "http response rawTrailers mismatch");
      resolve(data);
    });
  });
  req.once("error", reject);
});
strictEqual(trailerBody, "hello", "http chunked trailer body mismatch");
await close(trailerServer as unknown as http.Server);

const headerEdgeServer = createNetServer((socket) => {
  socket.once("data", () => {
    socket.end([
      "HTTP/1.1 200 OK",
      "Set-Cookie: a=1",
      "Set-Cookie: b=2",
      "X-Multi: one",
      "X-Multi: two",
      "Content-Length: 4",
      "",
      "edge",
    ].join("\r\n"));
  });
});
await listen(headerEdgeServer as unknown as http.Server, 0, "127.0.0.1");
const headerEdgeAddress = headerEdgeServer.address();
if (headerEdgeAddress == null || typeof headerEdgeAddress === "string") throw new Error("header edge server address should be an object");
const headerEdgeBody = await new Promise<string>((resolve, reject) => {
  const req = http.get(`http://127.0.0.1:${headerEdgeAddress.port}/headers`, (res) => {
    strictEqual(res.httpVersion, "1.1", "http response version mismatch");
    deepStrictEqual(res.headers["set-cookie"], ["a=1", "b=2"], "http set-cookie response header mismatch");
    strictEqual(res.headers["x-multi"], "one, two", "http duplicate response header mismatch");
    strictEqual(res.headers["content-length"], "4", "http content-length header mismatch");
    let data = "";
    res.on("data", (chunk) => { data += chunk.toString(); });
    res.on("end", () => resolve(data));
  });
  req.once("error", reject);
});
strictEqual(headerEdgeBody, "edge", "http header edge body mismatch");
await close(headerEdgeServer as unknown as http.Server);

deepStrictEqual(http._connectionListener.call({ emit: (event: string, value: unknown) => [event, value] }, "socket"), undefined);
http.setMaxIdleHTTPParsers(12);

server.once("upgrade", (req, socket, head) => {
  strictEqual(req.url, "/upgrade", "http upgrade request url mismatch");
  strictEqual(head.byteLength, 0, "http upgrade head mismatch");
  socket.end([
    "HTTP/1.1 101 Switching Protocols",
    "Connection: Upgrade",
    "Upgrade: cottontail",
    "",
    "upgraded",
  ].join("\r\n"));
});
const upgradeText = await new Promise<string>((resolve, reject) => {
  const socket = connectNet(address.port, "127.0.0.1");
  let data = "";
  socket.setEncoding("utf8");
  socket.once("error", reject);
  socket.once("connect", () => {
    socket.write([
      "GET /upgrade HTTP/1.1",
      `Host: 127.0.0.1:${address.port}`,
      "Connection: Upgrade",
      "Upgrade: cottontail",
      "",
      "",
    ].join("\r\n"));
  });
  socket.on("data", (chunk) => { data += chunk; });
  socket.on("end", () => resolve(data));
});
ok(upgradeText.includes("101 Switching Protocols"), "http upgrade response status mismatch");
ok(upgradeText.endsWith("upgraded"), "http upgrade response body mismatch");

server.once("connect", (req, socket, head) => {
  strictEqual(req.url, "example.test:443", "http CONNECT request url mismatch");
  strictEqual(head.byteLength, 0, "http CONNECT head mismatch");
  socket.end("HTTP/1.1 200 Connection Established\r\n\r\nconnected");
});
const connectText = await new Promise<string>((resolve, reject) => {
  const socket = connectNet(address.port, "127.0.0.1");
  let data = "";
  socket.setEncoding("utf8");
  socket.once("error", reject);
  socket.once("connect", () => {
    socket.write([
      "CONNECT example.test:443 HTTP/1.1",
      `Host: 127.0.0.1:${address.port}`,
      "",
      "",
    ].join("\r\n"));
  });
  socket.on("data", (chunk) => { data += chunk; });
  socket.on("end", () => resolve(data));
});
ok(connectText.includes("200 Connection Established"), "http CONNECT response mismatch");
ok(connectText.endsWith("connected"), "http CONNECT tunnel payload mismatch");

server.once("upgrade", (req, socket, head) => {
  strictEqual(req.url, "/client-upgrade", "http client upgrade request url mismatch");
  strictEqual(head.byteLength, 0, "http client upgrade request head mismatch");
  socket.end([
    "HTTP/1.1 101 Switching Protocols",
    "Connection: Upgrade",
    "Upgrade: cottontail",
    "",
    "client-upgraded",
  ].join("\r\n"));
});
const clientUpgradeHead = await new Promise<string>((resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1",
    port: address.port,
    path: "/client-upgrade",
    headers: { Connection: "Upgrade", Upgrade: "cottontail" },
  });
  req.once("upgrade", (res, socket, head) => {
    strictEqual(res.statusCode, 101, "http client upgrade status mismatch");
    socket.destroy();
    resolve(head.toString());
  });
  req.once("error", reject);
  req.end();
});
strictEqual(clientUpgradeHead, "client-upgraded", "http client upgrade head mismatch");

server.once("connect", (req, socket, head) => {
  strictEqual(req.url, "example.test:443", "http client CONNECT request url mismatch");
  strictEqual(head.byteLength, 0, "http client CONNECT head mismatch");
  socket.end("HTTP/1.1 200 Connection Established\r\n\r\nclient-connected");
});
const clientConnectHead = await new Promise<string>((resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1",
    port: address.port,
    method: "CONNECT",
    path: "example.test:443",
  });
  req.once("connect", (res, socket, head) => {
    strictEqual(res.statusCode, 200, "http client CONNECT status mismatch");
    socket.destroy();
    resolve(head.toString());
  });
  req.once("error", reject);
  req.end();
});
strictEqual(clientConnectHead, "client-connected", "http client CONNECT head mismatch");

const timeoutServer = createNetServer(() => {});
await listen(timeoutServer as unknown as http.Server, 0, "127.0.0.1");
const timeoutAddress = timeoutServer.address();
if (timeoutAddress == null || typeof timeoutAddress === "string") throw new Error("timeout server address should be an object");
let clientTimedOut = false;
await new Promise<void>((resolve, reject) => {
  const req = http.request({
    host: "127.0.0.1",
    port: timeoutAddress.port,
    path: "/timeout",
  });
  const fail = setTimeout(() => reject(new Error("http request timeout did not fire")), 1000);
  req.setTimeout(30, () => {
    clientTimedOut = true;
    clearTimeout(fail);
    req.destroy();
    resolve();
  });
  req.once("error", reject);
  req.end();
});
strictEqual(clientTimedOut, true, "http request setTimeout callback mismatch");
await close(timeoutServer as unknown as http.Server);

await close(server);

function websocketAccept(key: string) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function unmaskedWebSocketTextFrame(text: string) {
  const payload = Buffer.from(text);
  if (payload.byteLength >= 126) throw new Error("test frame too large");
  return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
}

function readMaskedClientTextFrame(buffer: Buffer) {
  if (buffer.byteLength < 6) return null;
  const opcode = buffer[0] & 0x0f;
  const length = buffer[1] & 0x7f;
  const maskOffset = 2;
  const payloadOffset = maskOffset + 4;
  if (buffer.byteLength < payloadOffset + length) return null;
  const mask = buffer.subarray(maskOffset, payloadOffset);
  const payload = Buffer.from(buffer.subarray(payloadOffset, payloadOffset + length));
  for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index % 4];
  return { opcode, text: payload.toString("utf8"), consumed: payloadOffset + length };
}

const websocketServer = createNetServer((socket) => {
  let upgraded = false;
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    if (!upgraded) {
      const text = buffer.toString("latin1");
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const keyLine = text.split("\r\n").find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
      const key = keyLine?.split(":").slice(1).join(":").trim();
      if (!key) throw new Error("missing websocket key");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
        "",
        "",
      ].join("\r\n"));
      buffer = buffer.subarray(headerEnd + 4);
      upgraded = true;
    }
    const frame = readMaskedClientTextFrame(buffer);
    if (!frame) return;
    buffer = buffer.subarray(frame.consumed);
    if (frame.opcode !== 0x1) return;
    strictEqual(frame.text, "ws-ping", "websocket server payload mismatch");
    socket.write(unmaskedWebSocketTextFrame("ws-pong"));
  });
});
await listen(websocketServer as unknown as http.Server, 0, "127.0.0.1");
const websocketAddress = websocketServer.address();
if (websocketAddress == null || typeof websocketAddress === "string") throw new Error("websocket server address should be an object");
const websocketPayload = await new Promise<string>((resolve, reject) => {
  const ws = new http.WebSocket(`ws://127.0.0.1:${websocketAddress.port}/socket`);
  ws.binaryType = "arraybuffer";
  ws.addEventListener("open", () => ws.send("ws-ping"));
  ws.addEventListener("message", (event) => {
    resolve(String(event.data));
    ws.close();
  });
  ws.addEventListener("error", (event) => reject(event.error ?? new Error(event.message ?? "websocket error")));
});
strictEqual(websocketPayload, "ws-pong", "websocket response payload mismatch");
await close(websocketServer as unknown as http.Server);

const httpsServer = https.createServer({ cert, key }, (req, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk.toString();
  });
  req.on("end", () => {
    strictEqual(req.url, "/secure", "https request url mismatch");
    res.statusCode = 202;
    res.setHeader("x-secure", "yes");
    res.end(`secure:${body}`);
  });
});
await listen(httpsServer as unknown as http.Server, 0, "127.0.0.1");
const httpsAddress = httpsServer.address();
if (httpsAddress == null || typeof httpsAddress === "string") throw new Error("https server address should be an object");
const httpsBody = await new Promise<string>((resolve, reject) => {
  const req = https.request({
    host: "127.0.0.1",
    port: httpsAddress.port,
    path: "/secure",
    method: "POST",
    rejectUnauthorized: false,
  }, (res) => {
    strictEqual(res.statusCode, 202, "https status mismatch");
    strictEqual(res.headers["x-secure"], "yes", "https response header mismatch");
    let data = "";
    res.on("data", (chunk) => {
      data += chunk.toString();
    });
    res.on("end", () => resolve(data));
  });
  req.once("error", reject);
  req.end("payload");
});
strictEqual(httpsBody, "secure:payload", "https response body mismatch");

const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
const httpsKeepAliveRequests: http.ClientRequest[] = [];
async function httpsKeepAliveGet() {
  return await new Promise<string>((resolve, reject) => {
    const req = https.get({
      host: "127.0.0.1",
      port: httpsAddress.port,
      path: "/secure",
      agent: httpsKeepAliveAgent,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk.toString(); });
      res.on("end", () => resolve(data));
    });
    httpsKeepAliveRequests.push(req as unknown as http.ClientRequest);
    req.once("error", reject);
  });
}
strictEqual(await httpsKeepAliveGet(), "secure:", "https keep-alive first response mismatch");
strictEqual(await httpsKeepAliveGet(), "secure:", "https keep-alive second response mismatch");
strictEqual(httpsKeepAliveRequests[0].reusedSocket, false, "first https keep-alive request should not reuse a socket");
strictEqual(httpsKeepAliveRequests[1].reusedSocket, true, "second https keep-alive request should reuse the agent socket");
httpsKeepAliveAgent.destroy();

httpsServer.once("upgrade", (req, socket, head) => {
  strictEqual(req.url, "/secure-upgrade", "https upgrade request url mismatch");
  strictEqual(head.byteLength, 0, "https upgrade request head mismatch");
  socket.end([
    "HTTP/1.1 101 Switching Protocols",
    "Connection: Upgrade",
    "Upgrade: cottontail",
    "",
    "secure-upgraded",
  ].join("\r\n"));
});
const httpsUpgradeHead = await new Promise<string>((resolve, reject) => {
  const req = https.request({
    host: "127.0.0.1",
    port: httpsAddress.port,
    path: "/secure-upgrade",
    rejectUnauthorized: false,
    headers: { Connection: "Upgrade", Upgrade: "cottontail" },
  });
  req.once("upgrade", (res, socket, head) => {
    strictEqual(res.statusCode, 101, "https upgrade status mismatch");
    socket.destroy();
    resolve(head.toString());
  });
  req.once("error", reject);
  req.end();
});
strictEqual(httpsUpgradeHead, "secure-upgraded", "https upgrade response head mismatch");

httpsServer.once("connect", (req, socket, head) => {
  strictEqual(req.url, "secure.example:443", "https CONNECT request url mismatch");
  strictEqual(head.byteLength, 0, "https CONNECT request head mismatch");
  socket.end("HTTP/1.1 200 Connection Established\r\n\r\nsecure-connected");
});
const httpsConnectHead = await new Promise<string>((resolve, reject) => {
  const req = https.request({
    host: "127.0.0.1",
    port: httpsAddress.port,
    method: "CONNECT",
    path: "secure.example:443",
    rejectUnauthorized: false,
  });
  req.once("connect", (res, socket, head) => {
    strictEqual(res.statusCode, 200, "https CONNECT status mismatch");
    socket.destroy();
    resolve(head.toString());
  });
  req.once("error", reject);
  req.end();
});
strictEqual(httpsConnectHead, "secure-connected", "https CONNECT response head mismatch");

await close(httpsServer as unknown as http.Server);

const httpsTrailerServer = tls.createServer({ cert, key }, (socket) => {
  socket.once("data", () => {
    socket.end([
      "HTTP/1.1 200 OK",
      "Transfer-Encoding: chunked",
      "Trailer: X-Secure-Trailer",
      "",
      "6",
      "secure",
      "0",
      "X-Secure-Trailer: yes",
      "",
      "",
    ].join("\r\n"));
  });
});
await listen(httpsTrailerServer as unknown as http.Server, 0, "127.0.0.1");
const httpsTrailerAddress = httpsTrailerServer.address();
if (httpsTrailerAddress == null || typeof httpsTrailerAddress === "string") throw new Error("https trailer server address should be an object");
const httpsTrailerBody = await new Promise<string>((resolve, reject) => {
  const req = https.get({
    host: "127.0.0.1",
    port: httpsTrailerAddress.port,
    path: "/trailers",
    rejectUnauthorized: false,
  }, (res) => {
    let data = "";
    res.on("data", (chunk) => { data += chunk.toString(); });
    res.on("end", () => {
      strictEqual(res.trailers["x-secure-trailer"], "yes", "https response trailers mismatch");
      deepStrictEqual(res.rawTrailers, ["X-Secure-Trailer", "yes"], "https response rawTrailers mismatch");
      resolve(data);
    });
  });
  req.once("error", reject);
});
strictEqual(httpsTrailerBody, "secure", "https chunked trailer body mismatch");
await close(httpsTrailerServer as unknown as http.Server);

console.log("node http https surface passed");
