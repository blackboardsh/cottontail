import assert from "node:assert/strict";
import { once } from "node:events";
import http2 from "node:http2";

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 2000);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const server = http2.createServer();
server.listen(0);
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address === "object");
const port = address.port;

const cases: [string, unknown, object?][] = [
  ["string", `http://localhost:${port}`],
  ["URL", new URL(`http://localhost:${port}`)],
  ["authority object", { protocol: "http:", hostname: "localhost", port }],
  ["split options", { port }, { protocol: "http:" }],
  ["split hostname", { port, hostname: "127.0.0.1" }, { protocol: "http:" }],
];

for (const [label, authority, options] of cases) {
  const client = http2.connect(authority as string, options);
  await withTimeout(once(client, "connect"), `${label} connect`);
  client.close();
  await withTimeout(once(client, "close"), `${label} close`);
}

server.close();
await once(server, "close");
console.log("node http2 URL formats passed");
