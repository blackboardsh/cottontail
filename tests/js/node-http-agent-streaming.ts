import { expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

async function close(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("Agent.createSocket supports asynchronous agent subclasses and option precedence", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  const port = await listen(server);
  let observedMarker;

  class AsyncAgent extends http.Agent {
    createSocket(request, options, callback) {
      queueMicrotask(() => super.createSocket(request, options, callback));
      return undefined;
    }

    createConnection(options, callback) {
      observedMarker = options.marker;
      return super.createConnection(options, callback);
    }
  }

  const agent = new AsyncAgent({ marker: "agent" });
  try {
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, marker: "request", agent }, resolve);
      request.on("error", reject);
    });
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    await once(response, "end");
    expect(body).toBe("ok");
    expect(observedMarker).toBe("agent");
  } finally {
    agent.destroy();
    await close(server);
  }
});

test("request handlers run after headers without buffering the declared body", async () => {
  const server = http.createServer((_request, response) => response.end("early"));
  const port = await listen(server);
  const socket = net.connect(port, "127.0.0.1");
  try {
    await once(socket, "connect");
    let wire = "";
    socket.on("data", (chunk) => { wire += String(chunk); });
    const ended = new Promise<void>((resolve) => {
      socket.once("end", resolve);
      socket.once("close", resolve);
    });
    socket.write(
      "POST / HTTP/1.1\r\n" +
      `Host: 127.0.0.1:${port}\r\n` +
      "Content-Length: 10485760\r\n" +
      "Connection: close\r\n\r\n",
    );
    await ended;
    expect(wire).toContain("early");
  } finally {
    socket.destroy();
    await close(server);
  }
});

test("http.maxHeaderSize also covers Bun.serve's in-process fetch path", async () => {
  const original = http.maxHeaderSize;
  http.maxHeaderSize = 1024;
  using server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  try {
    const accepted = await fetch(server.url, { headers: { "x-small": "x".repeat(128) } });
    const rejected = await fetch(server.url, { headers: { "x-large": "x".repeat(2048) } });
    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(431);
  } finally {
    http.maxHeaderSize = original;
  }
});
