import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";
import https from "node:https";
import { cert, key } from "./fixtures/tls-cert.js";

async function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let body = "";
  stream.setEncoding?.("utf8");
  stream.on("data", chunk => { body += chunk; });
  await once(stream, "end");
  return body;
}

const versions: string[] = [];
const server = http2.createSecureServer({ allowHTTP1: true, cert, key }, (request, response) => {
  versions.push(request.httpVersion);
  response.setHeader("x-http-version", request.httpVersion);
  response.end(request.httpVersion === "2.0" ? "http2" : "http1");
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");

function requestHttp1(path: string, ALPNProtocols?: string[]) {
  return new Promise<{ body: string; alpn: string | false }>((resolve, reject) => {
    const request = https.get({
      host: "127.0.0.1",
      port: address.port,
      path,
      ALPNProtocols,
      rejectUnauthorized: false,
    }, async response => {
      try {
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers["x-http-version"], "1.1");
        resolve({ body: await collect(response), alpn: response.socket.alpnProtocol });
      } catch (error) {
        reject(error);
      }
    });
    request.once("error", reject);
  });
}

const http1Result = await requestHttp1("/http1", ["http/1.1"]);
assert.deepEqual(http1Result, { body: "http1", alpn: "http/1.1" });
const noAlpnResult = await requestHttp1("/no-alpn");
assert.deepEqual(noAlpnResult, { body: "http1", alpn: "http/1.1" });

const client = http2.connect(`https://127.0.0.1:${address.port}`, { rejectUnauthorized: false });
await once(client, "connect");
assert.equal(client.alpnProtocol, "h2");
const http2Request = client.request({ ":path": "/http2" });
let http2Headers;
http2Request.once("response", headers => { http2Headers = headers; });
assert.equal(await collect(http2Request), "http2");
assert.equal(http2Headers?.["x-http-version"], "2.0");
client.close();
await once(client, "close");

assert.deepEqual(versions, ["1.1", "1.1", "2.0"]);
server.close();
await once(server, "close");

console.log("node http2 allowHTTP1 fallback passed");
