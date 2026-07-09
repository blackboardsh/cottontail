import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { createRequire } from "node:module";
import * as http from "node:http";
import * as https from "node:https";

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

for (const name of ["Agent", "ClientRequest", "IncomingMessage", "OutgoingMessage", "Server", "ServerResponse"]) {
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

const directServer = (server as unknown as { _native: { fetch(input: string, init?: RequestInit): Promise<Response> } })._native;
const postResponse = await directServer.fetch(`http://127.0.0.1:${address.port}/roundtrip?ok=1`, {
  method: "POST",
  headers: { "x-cottontail": "yes" },
  body: "payload",
});
strictEqual(postResponse.status, 201, "http server status mismatch");
strictEqual(postResponse.headers.get("x-reply"), "done", "http server response header mismatch");
strictEqual(await postResponse.text(), "echo:payload", "http server response body mismatch");

const getResponse = await directServer.fetch(`http://127.0.0.1:${address.port}/get`);
strictEqual(getResponse.headers.get("x-reply"), "get", "http get response header mismatch");
strictEqual(getResponse.status, 200, "http get status mismatch");
const getResponseText = await getResponse.text();
strictEqual(getResponseText, "get-ok", "http server get response mismatch");

deepStrictEqual(http._connectionListener.call({ emit: (event: string, value: unknown) => [event, value] }, "socket"), undefined);
http.setMaxIdleHTTPParsers(12);
await close(server);

console.log("node http https surface passed");
