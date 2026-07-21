import { expect, test } from "bun:test";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls-cert.js";

function getNativeHttpText(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
      response.once("error", reject);
    });
    request.setTimeout(3000, () => request.destroy(new Error("native HTTP request timed out")));
    request.once("error", reject);
  });
}

async function createForwardProxy(useTls = false) {
  const requests = [];
  const sockets = new Set();
  const handler = clientSocket => {
    sockets.add(clientSocket);
    clientSocket.on("error", () => {});
    clientSocket.once("close", () => sockets.delete(clientSocket));
    clientSocket.once("data", data => {
      const request = data.toString();
      requests.push(request);
      const [method, target] = request.split(" ");
      let hostname;
      let port;
      let path = "";
      if (method === "CONNECT") {
        const separator = target.lastIndexOf(":");
        hostname = target.slice(0, separator);
        port = Number(target.slice(separator + 1));
      } else {
        const url = new URL(target);
        hostname = url.hostname;
        port = Number(url.port || 80);
        path = `${url.pathname}${url.search}`;
      }

      const upstream = net.connect(port, hostname, () => {
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        if (method === "CONNECT") {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        } else {
          upstream.write(`${method} ${path} HTTP/1.1\r\n`);
          upstream.write(data.slice(request.indexOf("\r\n") + 2));
        }
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
  };
  const server = useTls
    ? tls.createServer({ cert, key }, handler)
    : net.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    requests,
    url: `${useTls ? "https" : "http"}://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
}

test("Request and Response JSON errors use Bun's stable message", async () => {
  for (const body of [
    new Request("http://localhost", { method: "POST", body: new Uint8Array([0xfd]) }),
    new Response(new Uint8Array([0xfd])),
  ]) {
    let error;
    try {
      await body.json();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SyntaxError);
    expect(error.message).toBe("Failed to parse JSON");
  }
});

test("Bun.serve uncaught handler diagnostics include the source line", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, `${import.meta.dir}/fixtures/bun-http-handler-error.js`],
    stdout: "ignore",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([child.stderr.text(), child.exited]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain('throw new Error("focused HTTP handler failure");');
});

test("force-stopping an in-process server rejects the active fetch", async () => {
  for (let index = 0; index < 3; index += 1) {
    let server;
    server = Bun.serve({
      port: 0,
      fetch() {
        server.stop(true);
        return new Response("late response");
      },
    });

    let error;
    try {
      await fetch(server.url);
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("ECONNRESET");
  }
});

test("native Bun.serve dispatches a nested request while its outer handler is pending", async () => {
  let server;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/inner") return new Response("inner");
      return new Response(`outer:${await getNativeHttpText(new URL("/inner", server.url))}`);
    },
  });
  try {
    expect(await getNativeHttpText(new URL("/outer", server.url))).toBe("outer:inner");
  } finally {
    await server.stop(true);
  }
});

test("native Bun.serve streams response chunks before the body completes", async () => {
  const releaseTail = Promise.withResolvers();
  const firstChunk = Promise.withResolvers();
  using server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue("first");
          await releaseTail.promise;
          controller.enqueue("second");
          controller.close();
        },
      }));
    },
  });

  const completed = new Promise((resolve, reject) => {
    const chunks = [];
    const request = http.get(server.url, response => {
      response.on("data", chunk => {
        chunks.push(Buffer.from(chunk));
        firstChunk.resolve();
      });
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
      response.once("error", reject);
    });
    request.setTimeout(3000, () => request.destroy(new Error("streaming response timed out")));
    request.once("error", reject);
  });

  await firstChunk.promise;
  releaseTail.resolve();
  expect(await completed).toBe("firstsecond");
});

test("in-process fetch enforces maxRequestBodySize before dispatch", async () => {
  let calls = 0;
  using server = Bun.serve({
    port: 0,
    maxRequestBodySize: 10,
    fetch() {
      calls += 1;
      return new Response("ok");
    },
  });

  expect((await fetch(server.url, { method: "POST", body: "a".repeat(10) })).status).toBe(200);
  expect((await fetch(server.url, { method: "POST", body: "a".repeat(11) })).status).toBe(413);
  expect(calls).toBe(1);
});

test("an unread in-process request body is aborted after the response", async () => {
  const readResult = Promise.withResolvers();
  using server = Bun.serve({
    port: 0,
    fetch(request) {
      request.body.getReader().read().then(
        (value) => readResult.resolve({ value }),
        (error) => readResult.resolve({ error }),
      );
      return new Response("ok");
    },
  });

  expect(await fetch(server.url, { method: "POST", body: "x".repeat(64 * 1024) }).then((response) => response.text())).toBe("ok");
  const result = await readResult.promise;
  expect(result.error?.name).toBe("AbortError");
});

test("aborting before streamed response headers cancels the server stream", async () => {
  const handlerStarted = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  using server = Bun.serve({
    port: 0,
    async fetch() {
      setTimeout(handlerStarted.resolve, 0);
      return new Response(new ReadableStream({
        pull() {
          return cancelled.promise;
        },
        cancel() {
          cancelled.resolve();
        },
      }));
    },
  });

  const controller = new AbortController();
  const request = fetch(server.url, { signal: controller.signal });
  await handlerStarted.promise;
  controller.abort();

  let error;
  try {
    await request;
  } catch (caught) {
    error = caught;
  }
  expect(error?.name).toBe("AbortError");
  await cancelled.promise;
});

test("Bun.serve idleTimeout aborts a stalled response body", async () => {
  using server = Bun.serve({
    port: 0,
    idleTimeout: 1,
    fetch() {
      return new Response(new ReadableStream({
        async pull(controller) {
          controller.enqueue("first");
          await Bun.sleep(1200);
          controller.enqueue("late");
          controller.close();
        },
      }));
    },
  });

  const response = await fetch(server.url);
  let error;
  try {
    await response.text();
  } catch (caught) {
    error = caught;
  }
  expect(error?.code).toBe("ECONNRESET");
  expect(error?.message).toBe("The socket connection was closed unexpectedly.");
});

test("in-process TLS keepalive peers are stable and separated by config", async () => {
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch(request, activeServer) {
      return new Response(String(activeServer.requestIP(request)?.port ?? 0));
    },
  });

  const firstConfig = { ca: cert, rejectUnauthorized: false };
  const secondConfig = { ca: cert, rejectUnauthorized: false, serverName: "localhost" };
  const first = await fetch(server.url, { tls: firstConfig, keepalive: true }).then((response) => response.text());
  const repeated = await fetch(server.url, { tls: firstConfig, keepalive: true }).then((response) => response.text());
  const separate = await fetch(server.url, { tls: secondConfig, keepalive: true }).then((response) => response.text());

  expect(repeated).toBe(first);
  expect(separate).not.toBe(first);
});

test("Bun.connect settles before a plain HTTP peer rejects TLS", async () => {
  let requests = 0;
  using server = Bun.serve({
    port: 0,
    fetch() {
      requests += 1;
      return new Response("unexpected");
    },
  });
  const closed = Promise.withResolvers();
  const socket = await Bun.connect({
    hostname: server.hostname,
    port: server.port,
    tls: true,
    socket: {
      close() {
        closed.resolve();
      },
    },
  });

  await closed.promise;
  expect(socket).toBeDefined();
  expect(requests).toBe(0);
});

test("Bun TLS sockets expose local and peer X509 certificates", async () => {
  const accepted = Promise.withResolvers();
  const connected = Promise.withResolvers();
  using listener = await Bun.listen({
    hostname: "localhost",
    port: 0,
    tls: { cert, key },
    socket: {
      handshake(socket) {
        accepted.resolve(socket);
      },
    },
  });
  await Bun.connect({
    hostname: listener.hostname,
    port: listener.port,
    tls: { ca: cert, rejectUnauthorized: false },
    socket: {
      handshake(socket) {
        connected.resolve(socket);
      },
    },
  });

  await using serverSocket = await accepted.promise;
  await using clientSocket = await connected.promise;
  expect(serverSocket.getX509Certificate().checkHost("localhost")).toBe("localhost");
  expect(clientSocket.getPeerX509Certificate().checkHost("localhost")).toBe("localhost");
});

test("fetch validates proxy protocols and honors NO_PROXY for explicit proxies", async () => {
  let protocolError;
  try {
    await fetch("http://127.0.0.1:1", { proxy: "ftp://example.com" });
  } catch (error) {
    protocolError = error;
  }
  expect(protocolError?.code).toBe("UnsupportedProxyProtocol");

  using origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("direct"),
  });
  const previous = process.env.NO_PROXY;
  process.env.NO_PROXY = "127.0.0.1";
  try {
    const response = await fetch(origin.url, { proxy: "http://127.0.0.1:1" });
    expect(await response.text()).toBe("direct");
  } finally {
    if (previous == null) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previous;
  }
});

test("fetch proxies HTTP and HTTPS targets through HTTP and TLS proxies", async () => {
  using httpOrigin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: request => request.text().then(body => new Response(body || "ok")),
  });
  using httpsOrigin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch: request => request.text().then(body => new Response(body || "ok")),
  });

  for (const proxyTls of [false, true]) {
    const proxy = await createForwardProxy(proxyTls);
    try {
      for (const origin of [httpOrigin, httpsOrigin]) {
        for (const body of [undefined, "payload"]) {
          let response;
          try {
            response = await fetch(origin.url, {
              method: body == null ? "GET" : "POST",
              body,
              proxy: proxy.url,
              keepalive: false,
              tls: { ca: cert, rejectUnauthorized: false },
            });
          } catch (error) {
            throw new Error(
              `${proxyTls ? "HTTPS" : "HTTP"} proxy to ${origin === httpsOrigin ? "HTTPS" : "HTTP"} origin ` +
              `${body == null ? "GET" : "POST"}: ${error?.message ?? error}`,
            );
          }
          expect(response.status).toBe(200);
          let responseText;
          try {
            responseText = await response.text();
          } catch (error) {
            throw new Error(
              `${proxyTls ? "HTTPS" : "HTTP"} proxy to ${origin === httpsOrigin ? "HTTPS" : "HTTP"} origin ` +
              `${body == null ? "GET" : "POST"} body: ${error?.message ?? error}`,
            );
          }
          expect(responseText).toBe(body ?? "ok");
        }
      }
    } finally {
      await proxy.close();
    }
  }
});

test("proxy object headers override URL proxy credentials", async () => {
  const proxy = await createForwardProxy();
  using origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  try {
    const authenticatedProxy = proxy.url.replace("http://", "http://url-user:url-password@");
    const response = await fetch(origin.url, {
      proxy: {
        url: authenticatedProxy,
        headers: {
          "Proxy-Authorization": "Bearer explicit-token",
          "X-Proxy-Test": "present",
        },
      },
      keepalive: false,
    });
    expect(await response.text()).toBe("ok");
    const request = proxy.requests[0].toLowerCase();
    expect(request).toContain("proxy-authorization: bearer explicit-token");
    expect(request).toContain("x-proxy-test: present");
    expect(request.match(/proxy-authorization:/g)?.length).toBe(1);
  } finally {
    await proxy.close();
  }
});

test("node:http completes a length-delimited response forwarded by a proxy", async () => {
  const proxy = await createForwardProxy();
  using origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("ok"),
  });
  try {
    const lifecycleEvents = [];
    const response = await new Promise((resolve, reject) => {
      const proxyUrl = new URL(proxy.url);
      const request = http.request({
        hostname: proxyUrl.hostname,
        port: proxyUrl.port,
        method: "GET",
        path: origin.url.href,
        headers: { Connection: "close" },
        agent: false,
      }, response => {
        const body = new ReadableStream({
          start(controller) {
            response.on("data", chunk => {
              lifecycleEvents.push(`data:${chunk.byteLength}`);
              controller.enqueue(chunk);
            });
            response.once("aborted", () => {
              lifecycleEvents.push(`aborted:${response.complete}`);
              controller.error(new Error(lifecycleEvents.join(",")));
            });
            response.once("error", error => {
              lifecycleEvents.push(`error:${error.message}:${response.complete}`);
              controller.error(new Error(lifecycleEvents.join(",")));
            });
            response.once("end", () => {
              lifecycleEvents.push(`end:${response.complete}`);
              controller.close();
            });
            response.resume();
          },
        });
        resolve(new Response(body, { status: response.statusCode }));
      });
      request.once("error", reject);
      request.end();
    });
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw new Error(`${error?.message ?? error}; lifecycle=${lifecycleEvents.join(",")}`);
    }
    expect(text).toBe("ok");
  } finally {
    await proxy.close();
  }
});

test("node:http promptly rejects an invalid request method prefix", async () => {
  const server = http.createServer(() => {
    throw new Error("invalid bytes must not dispatch a request");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    const result = await new Promise(resolve => {
      const socket = net.connect(address.port, "127.0.0.1", () => {
        socket.write(new Uint8Array([0x16, 0x03, 0x01, 0x00, 0x00]));
      });
      let response = "";
      socket.on("data", chunk => { response += chunk.toString(); });
      socket.once("close", () => resolve(response));
    });
    expect(result).toStartWith("HTTP/1.1 400 Bad Request");
  } finally {
    server.close();
    await once(server, "close");
  }
});
