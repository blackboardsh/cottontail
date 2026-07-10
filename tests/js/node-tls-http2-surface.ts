import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createRequire } from "node:module";
import * as tls from "node:tls";
import * as http2 from "node:http2";
import { cert, key } from "./fixtures/tls-cert.js";

const require = createRequire(import.meta.url);
const requiredTls = require("tls");
const requiredHttp2 = require("node:http2");

strictEqual(requiredTls.checkServerIdentity, tls.checkServerIdentity, "require tls mismatch");
strictEqual(requiredHttp2.getPackedSettings, http2.getPackedSettings, "require http2 mismatch");

strictEqual(tls.CLIENT_RENEG_LIMIT, 3, "tls CLIENT_RENEG_LIMIT mismatch");
strictEqual(tls.CLIENT_RENEG_WINDOW, 600, "tls CLIENT_RENEG_WINDOW mismatch");
strictEqual(tls.DEFAULT_MIN_VERSION, "TLSv1.2", "tls DEFAULT_MIN_VERSION mismatch");
strictEqual(tls.DEFAULT_MAX_VERSION, "TLSv1.3", "tls DEFAULT_MAX_VERSION mismatch");
strictEqual(tls.DEFAULT_ECDH_CURVE, "auto", "tls DEFAULT_ECDH_CURVE mismatch");
ok(tls.DEFAULT_CIPHERS.includes("TLS_AES_256_GCM_SHA384"), "tls DEFAULT_CIPHERS mismatch");
strictEqual(typeof tls.Server, "function", "tls Server should be exported");
strictEqual(typeof tls.TLSSocket, "function", "tls TLSSocket should be exported");
strictEqual(typeof tls.connect, "function", "tls connect should be exported");
strictEqual(typeof tls.createServer, "function", "tls createServer should be exported");
strictEqual(typeof tls.getCiphers, "function", "tls getCiphers should be exported");
strictEqual(new tls.TLSSocket().encrypted, true, "tls TLSSocket encrypted mismatch");
strictEqual(new tls.TLSSocket().renegotiate({}), true, "tls TLSSocket renegotiate return mismatch");
let renegotiateTypeError = false;
try {
  new tls.TLSSocket().renegotiate(null as never);
} catch {
  renegotiateTypeError = true;
}
strictEqual(renegotiateTypeError, true, "tls TLSSocket renegotiate options validation mismatch");
strictEqual(tls.createServer() instanceof tls.Server, true, "tls createServer class mismatch");
const ciphers = tls.getCiphers();
strictEqual(Array.isArray(ciphers), true, "tls getCiphers should return an array");
ok(ciphers.length > 0, "tls getCiphers should expose default ciphers");
ok(ciphers.every((cipher) => cipher === cipher.toLowerCase()), "tls getCiphers should return lower-case names");
ok(ciphers.includes("ecdhe-rsa-aes128-gcm-sha256"), "tls getCiphers should include default ECDHE RSA AES-GCM cipher");

strictEqual(tls.checkServerIdentity("example.com", { subjectaltname: "DNS:example.com" }), undefined, "tls SAN exact mismatch");
strictEqual(tls.checkServerIdentity("a.example.com", { subjectaltname: "DNS:*.example.com" }), undefined, "tls SAN wildcard mismatch");
strictEqual(tls.checkServerIdentity("example.com", { subject: { CN: "example.com" } }), undefined, "tls CN fallback mismatch");
const mismatch = tls.checkServerIdentity("example.com", { subjectaltname: "DNS:other.com" });
strictEqual(mismatch?.code, "ERR_TLS_CERT_ALTNAME_INVALID", "tls SAN mismatch error code");
ok(String(mismatch?.message).includes("other.com"), "tls SAN mismatch message");

const alpn: { ALPNProtocols?: Buffer } = {};
tls.convertALPNProtocols(["h2", "http/1.1"], alpn);
strictEqual(alpn.ALPNProtocols?.toString("hex"), "02683208687474702f312e31", "tls ALPN encoding mismatch");

const context = tls.createSecureContext({ ca: tls.rootCertificates[0] });
strictEqual(context instanceof tls.SecureContext, true, "tls SecureContext mismatch");
ok(Array.isArray(context.context.ca), "tls SecureContext should normalize CA certificates");
ok(Array.isArray(tls.rootCertificates), "tls rootCertificates should be an array");
ok(tls.rootCertificates.length > 0, "tls rootCertificates should load system roots");
ok(tls.getCACertificates().length > 0, "tls getCACertificates should return default roots");
tls.setDefaultCACertificates([tls.rootCertificates[0]]);
strictEqual(tls.getCACertificates("default").length, 1, "tls setDefaultCACertificates mismatch");

const tlsServer = tls.createServer({ cert, key }, (socket) => {
  const localCert = socket.getCertificate();
  strictEqual(localCert.subject?.CN, "localhost", "tls server local certificate subject mismatch");
  ok(localCert.raw?.byteLength > 0, "tls server local certificate raw DER missing");
  deepStrictEqual(socket.getPeerCertificate(), {}, "tls server should not have a client peer certificate");
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    strictEqual(chunk, "tls-ping", "tls server payload mismatch");
    socket.end("tls-pong");
  });
});
await new Promise<void>((resolve, reject) => {
  tlsServer.once("error", reject);
  tlsServer.listen(0, "127.0.0.1", () => resolve());
});
const tlsAddress = tlsServer.address();
if (tlsAddress == null || typeof tlsAddress === "string") throw new Error("tls server address should be an object");
const tlsClient = tls.connect({
  host: "127.0.0.1",
  port: tlsAddress.port,
  servername: "localhost",
  rejectUnauthorized: false,
});
tlsClient.setEncoding("utf8");
const tlsPayload = await new Promise<string>((resolve, reject) => {
  let data = "";
  tlsClient.once("error", reject);
  tlsClient.once("secureConnect", () => {
    ok(tlsClient.getProtocol(), "tls client protocol missing");
    ok(tlsClient.getCipher()?.name, "tls client cipher missing");
    const peerCert = tlsClient.getPeerCertificate();
    strictEqual(peerCert.subject?.CN, "localhost", "tls client peer certificate subject mismatch");
    ok(String(peerCert.subjectaltname).includes("DNS:localhost"), "tls client peer certificate SAN missing");
    ok(peerCert.raw?.byteLength > 0, "tls client peer certificate raw DER missing");
    ok((tlsClient.getSession()?.byteLength ?? 0) > 0, "tls client session bytes missing");
    strictEqual(tlsClient.isSessionReused(), false, "tls first connection should not report reused session");
    tlsClient.write("tls-ping");
  });
  tlsClient.on("data", (chunk) => {
    data += chunk;
  });
  tlsClient.on("end", () => resolve(data));
});
strictEqual(tlsPayload, "tls-pong", "tls client payload mismatch");
await new Promise<void>((resolve) => tlsServer.close(() => resolve()));

strictEqual(typeof http2.Http2ServerRequest, "function", "http2 Http2ServerRequest should be exported");
strictEqual(typeof http2.Http2ServerResponse, "function", "http2 Http2ServerResponse should be exported");
strictEqual(typeof http2.connect, "function", "http2 connect should be exported");
strictEqual(typeof http2.createServer, "function", "http2 createServer should be exported");
strictEqual(typeof http2.createSecureServer, "function", "http2 createSecureServer should be exported");
strictEqual(typeof http2.performServerHandshake, "function", "http2 performServerHandshake should be exported");
strictEqual(typeof http2.sensitiveHeaders, "symbol", "http2 sensitiveHeaders should be a symbol");
strictEqual(http2.constants.NGHTTP2_SETTINGS_HEADER_TABLE_SIZE, 1, "http2 setting constant mismatch");
strictEqual(http2.constants.HTTP2_HEADER_METHOD, ":method", "http2 header constant mismatch");
strictEqual(http2.constants.HTTP2_METHOD_GET, "GET", "http2 method constant mismatch");

const defaults = http2.getDefaultSettings();
strictEqual(defaults.headerTableSize, 4096, "http2 default headerTableSize mismatch");
strictEqual(defaults.enablePush, true, "http2 default enablePush mismatch");
strictEqual(defaults.maxFrameSize, 16384, "http2 default maxFrameSize mismatch");

const packed = http2.getPackedSettings({
  headerTableSize: 4096,
  enablePush: false,
  initialWindowSize: 65535,
  maxFrameSize: 16384,
});
strictEqual(Buffer.from(packed).toString("hex"), "00010000100000020000000000040000ffff000500004000", "http2 packed settings mismatch");
deepStrictEqual(
  http2.getUnpackedSettings(packed),
  {
    headerTableSize: 4096,
    enablePush: false,
    initialWindowSize: 65535,
    maxFrameSize: 16384,
  },
  "http2 unpacked settings mismatch",
);

const packedHeaderList = http2.getPackedSettings({ maxHeaderListSize: 1000, enableConnectProtocol: true });
deepStrictEqual(
  http2.getUnpackedSettings(packedHeaderList),
  { maxHeaderSize: 1000, maxHeaderListSize: 1000, enableConnectProtocol: true },
  "http2 maxHeaderListSize unpack mismatch",
);

const h2Server = http2.createServer();
h2Server.on("stream", (stream, headers) => {
  let body = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    body += chunk;
  });
  stream.on("end", () => {
    strictEqual(headers[":path"], "/h2", "http2 server path mismatch");
    strictEqual(body, "h2-ping", "http2 server body mismatch");
    stream.respond({ ":status": 200, "x-h2": "yes" });
    stream.end("h2-pong");
  });
});
await new Promise<void>((resolve, reject) => {
  h2Server.once("error", reject);
  h2Server.listen(0, "127.0.0.1", () => resolve());
});
const h2Address = h2Server.address();
if (h2Address == null || typeof h2Address === "string") throw new Error("http2 server address should be an object");
const h2Payload = await new Promise<string>((resolve, reject) => {
  const session = http2.connect(`http://127.0.0.1:${h2Address.port}`);
  session.once("error", reject);
  session.once("connect", () => {
    const req = session.request({ ":method": "POST", ":path": "/h2", ":authority": "127.0.0.1" });
    let data = "";
    req.setEncoding("utf8");
    req.once("response", (headers) => {
      strictEqual(headers[":status"], "200", "http2 response status mismatch");
      strictEqual(headers["x-h2"], "yes", "http2 response header mismatch");
    });
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      session.close();
      resolve(data);
    });
    req.end("h2-ping");
  });
});
strictEqual(h2Payload, "h2-pong", "http2 response body mismatch");
await new Promise<void>((resolve) => h2Server.close(() => resolve()));

const h2SecureServer = http2.createSecureServer({ cert, key }, (stream) => {
  stream.respond({ ":status": 200 });
  stream.end("h2s-ok");
});
await new Promise<void>((resolve, reject) => {
  h2SecureServer.once("error", reject);
  h2SecureServer.listen(0, "127.0.0.1", () => resolve());
});
const h2SecureAddress = h2SecureServer.address();
if (h2SecureAddress == null || typeof h2SecureAddress === "string") throw new Error("secure http2 server address should be an object");
const h2SecurePayload = await new Promise<string>((resolve, reject) => {
  const session = http2.connect(`https://127.0.0.1:${h2SecureAddress.port}`, { rejectUnauthorized: false });
  session.once("error", reject);
  session.once("connect", () => {
    const req = session.request({ ":path": "/" });
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      session.close();
      resolve(data);
    });
    req.end();
  });
});
strictEqual(h2SecurePayload, "h2s-ok", "secure http2 response body mismatch");
await new Promise<void>((resolve) => h2SecureServer.close(() => resolve()));

console.log("node tls http2 surface passed");
