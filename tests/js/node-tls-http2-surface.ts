import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { createRequire } from "node:module";
import * as tls from "node:tls";
import * as http2 from "node:http2";

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

console.log("node tls http2 surface passed");
