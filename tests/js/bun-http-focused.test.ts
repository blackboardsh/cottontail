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

function requestNativeHttpText(url, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, {
      method: "POST",
      headers: {
        connection: "close",
        "content-length": String(body.byteLength),
      },
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(Buffer.from(chunk)));
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
      response.once("error", reject);
    });
    request.setTimeout(3000, () => request.destroy(new Error("native HTTP request timed out")));
    request.once("error", reject);
    request.end(body);
  });
}

function withTimeout(promise, message, timeout = 3000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeout);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readRawHttpResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = value => {
      cleanup();
      resolve(value);
    };
    const onData = chunk => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const head = buffered.subarray(0, headerEnd).toString();
      const contentLength = Number(/\r\ncontent-length:\s*(\d+)/i.exec(`\r\n${head}`)?.[1] ?? 0);
      const bodyStart = headerEnd + 4;
      if (buffered.byteLength - bodyStart < contentLength) return;
      finish({ head, body: buffered.subarray(bodyStart, bodyStart + contentLength).toString() });
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before the HTTP response completed"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("raw HTTP response timed out"));
    }, 3000);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
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
    async closeGracefully() {
      server.close();
      await once(server, "close");
    },
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
    expect(server.pendingRequests).toBe(0);
  }
});

test("graceful stop tracks an in-process fetch as pending", async () => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      started.resolve();
      await release.promise;
      return new Response("complete");
    },
  });

  try {
    const response = fetch(server.url);
    await started.promise;
    expect(server.pendingRequests).toBe(1);

    let stopResolved = false;
    const stopped = server.stop();
    stopped.then(() => { stopResolved = true; });
    await Bun.sleep(10);
    expect(stopResolved).toBe(false);

    release.resolve();
    expect(await response.then(result => result.text())).toBe("complete");
    await stopped;
    expect(server.pendingRequests).toBe(0);
  } finally {
    release.resolve();
    await server.stop(true);
  }
});

test("Bun.serve graceful stop waits for in-flight native and Node-backed requests", async () => {
  for (const nodeBacked of [false, true]) {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...(nodeBacked ? { websocket: { message() {} } } : {}),
      async fetch() {
        started.resolve();
        await release.promise;
        return new Response(nodeBacked ? "node-backed" : "native", {
          headers: { connection: "close" },
        });
      },
    });

    try {
      expect(server.protocol).toBe("http");
      expect(server.address).toEqual({
        address: "127.0.0.1",
        family: "IPv4",
        port: server.port,
      });

      const response = getNativeHttpText(server.url);
      await started.promise;
      expect(server.pendingRequests).toBe(1);

      let stopResolved = false;
      const stopped = server.stop();
      expect(server.stop()).toBe(stopped);
      stopped.then(() => { stopResolved = true; });
      await Bun.sleep(10);
      expect(stopResolved).toBe(false);

      release.resolve();
      expect(await response).toBe(nodeBacked ? "node-backed" : "native");
      await stopped;
      expect(server.pendingRequests).toBe(0);
    } finally {
      release.resolve();
      await server.stop(true);
    }
  }
});

test("Bun.serve force stop aborts native and Node-backed requests", async () => {
  for (const nodeBacked of [false, true]) {
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...(nodeBacked ? { websocket: { message() {} } } : {}),
      async fetch() {
        started.resolve();
        await release.promise;
        return new Response("too late");
      },
    });

    const requestError = getNativeHttpText(server.url).then(
      () => null,
      error => error,
    );
    try {
      await started.promise;
      expect(server.pendingRequests).toBe(1);
      await server.stop(true);
      expect(server.pendingRequests).toBe(0);
      expect(await requestError).toBeInstanceOf(Error);
    } finally {
      release.resolve();
      await server.stop(true);
    }
  }
});

test("Bun.serve closeIdleConnections retires idle native and Node-backed sockets", async () => {
  for (const nodeBacked of [false, true]) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      ...(nodeBacked ? { websocket: { message() {} } } : {}),
      fetch: () => new Response("ok"),
    });
    const socket = net.connect(server.port, server.hostname);
    socket.on("error", () => {});
    try {
      await once(socket, "connect");
      await Bun.sleep(10);
      const closed = once(socket, "close");
      server.closeIdleConnections();
      await closed;
    } finally {
      socket.destroy();
      await server.stop(true);
    }
  }
});

test("Bun.serve graceful stop waits for upgraded WebSockets", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, activeServer) {
      if (activeServer.upgrade(request)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: {
      message() {},
    },
  });
  const client = new WebSocket(server.url.href.replace(/^http/, "ws"));
  try {
    await new Promise((resolve, reject) => {
      client.addEventListener("open", resolve, { once: true });
      client.addEventListener("error", reject, { once: true });
    });
    expect(server.pendingWebSockets).toBe(1);

    let stopResolved = false;
    const stopped = server.stop();
    stopped.then(() => { stopResolved = true; });
    await Bun.sleep(10);
    expect(stopResolved).toBe(false);

    const closed = new Promise(resolve => client.addEventListener("close", resolve, { once: true }));
    client.close();
    await closed;
    await stopped;
    expect(server.pendingWebSockets).toBe(0);
  } finally {
    client.close();
    await server.stop(true);
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

test("native Bun.serve streams partial Content-Length and chunked request bodies", async () => {
  for (const framing of ["content-length", "chunked"]) {
    const dispatched = Promise.withResolvers();
    const firstChunk = Promise.withResolvers();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        dispatched.resolve();
        const chunks = [];
        for await (const chunk of request.body) {
          chunks.push(Buffer.from(chunk));
          firstChunk.resolve(Buffer.concat(chunks).toString());
        }
        return new Response(Buffer.concat(chunks));
      },
    });
    const socket = net.connect(server.port, server.hostname);
    socket.on("error", () => {});
    try {
      await once(socket, "connect");
      const response = readRawHttpResponse(socket);
      if (framing === "content-length") {
        socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 11\r\n\r\nhello");
      } else {
        socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n");
      }

      await withTimeout(dispatched.promise, `${framing} request was not dispatched from headers`);
      expect(await withTimeout(firstChunk.promise, `${framing} first body chunk was not streamed`)).toBe("hello");
      socket.write(framing === "content-length" ? " world" : "6\r\n world\r\n0\r\n\r\n");

      const result = await response;
      expect(result.head).toStartWith("HTTP/1.1 200");
      expect(result.body).toBe("hello world");
    } finally {
      socket.destroy();
      await server.stop(true);
    }
  }
});

test("native Bun.serve aborts the request body and signal when an upload disconnects", async () => {
  const firstChunk = Promise.withResolvers();
  const observed = Promise.withResolvers();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 16 * 1024 * 1024 * 1024,
    async fetch(request) {
      let bodyError;
      try {
        for await (const chunk of request.body) firstChunk.resolve(chunk.byteLength);
      } catch (error) {
        bodyError = error;
      }
      observed.resolve({
        bodyErrorName: bodyError?.name,
        signalAborted: request.signal.aborted,
        signalReasonCode: request.signal.reason?.code,
      });
      return new Response("disconnected");
    },
  });
  const socket = net.connect(server.port, server.hostname);
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1048576\r\n\r\n");
    socket.write(Buffer.alloc(32 * 1024, 0x61));
    expect(await withTimeout(firstChunk.promise, "partial upload was not streamed")).toBeGreaterThan(0);
    socket.end();

    expect(await withTimeout(observed.promise, "upload disconnect was not propagated")).toEqual({
      bodyErrorName: "AbortError",
      signalAborted: true,
      signalReasonCode: "ECONNRESET",
    });
  } finally {
    socket.destroy();
    await server.stop(true);
  }
});

test("native Bun.serve errors an unread pending body read after responding", async () => {
  const readResult = Promise.withResolvers();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      request.body.getReader().read().then(
        value => readResult.resolve({ value }),
        error => readResult.resolve({ error }),
      );
      return new Response("ok");
    },
  });
  const socket = net.connect(server.port, server.hostname);
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    const response = readRawHttpResponse(socket);
    socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: 65536\r\n\r\n");

    expect((await withTimeout(readResult.promise, "pending request body read did not settle")).error?.name).toBe("AbortError");
    expect((await response).body).toBe("ok");
  } finally {
    socket.destroy();
    await server.stop(true);
  }
});

test("native Bun.serve retains a lazy request URL after request finalization", async () => {
  const captured = Promise.withResolvers();
  const longPath = `/${"segment/".repeat(1024)}done?value=1`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      captured.resolve(request);
      return new Response("ok");
    },
  });
  try {
    expect(await getNativeHttpText(`${server.url.origin}${longPath}`)).toBe("ok");
    const request = await captured.promise;
    expect(request.url).toBe(`${server.url.origin}${longPath}`);
  } finally {
    await server.stop(true);
  }
});

test("native Bun.serve releases bounded long-URL and request-body state", async () => {
  const requests = [];
  const payload = Buffer.alloc(128 * 1024, 0x61);
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(new WeakRef(request));
      const pathname = new URL(request.url).pathname;
      if (pathname === "/buffer") return new Response(String((await request.arrayBuffer()).byteLength));
      if (pathname === "/partial") {
        const { value } = await request.body.getReader().read();
        return new Response(String(value.byteLength));
      }
      if (pathname === "/echo") return new Response(request.body);
      return new Response("ignored");
    },
  });

  const suffix = `?${"long-url-state".repeat(256)}`;
  for (let round = 0; round < 2; round += 1) {
    const [ignored, buffered, partial, echoed] = await Promise.all([
      requestNativeHttpText(`${server.url.origin}/ignore${suffix}`, payload),
      requestNativeHttpText(`${server.url.origin}/buffer${suffix}`, payload),
      requestNativeHttpText(`${server.url.origin}/partial${suffix}`, payload),
      requestNativeHttpText(`${server.url.origin}/echo${suffix}`, payload),
    ]);
    expect(ignored).toBe("ignored");
    expect(buffered).toBe(String(payload.byteLength));
    expect(Number(partial)).toBeGreaterThan(0);
    expect(echoed).toBe(payload.toString());
  }

  await Bun.sleep(0);
  expect(server.pendingRequests).toBe(0);
  Bun.gc(true);
  await Bun.sleep(0);
  Bun.gc(true);
  expect(requests.some(request => request.deref() === undefined)).toBe(true);
});

test("native Bun.serve rejects an oversized declared body before dispatch", async () => {
  let calls = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 10,
    fetch() {
      calls += 1;
      return new Response("unexpected");
    },
  });
  const socket = net.connect(server.port, server.hostname);
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    const response = readRawHttpResponse(socket);
    socket.write("POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 11\r\n\r\n");

    const result = await response;
    expect(result.head).toStartWith("HTTP/1.1 413");
    expect(result.body).toBe("Payload Too Large");
    expect(calls).toBe(0);
  } finally {
    socket.destroy();
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

test("native Bun.serve reports stream errors without replacing started headers", async () => {
  let errorHandlerCalls = 0;
  const diagnostics = [];
  const originalConsoleError = console.error;
  console.error = (...args) => diagnostics.push(args.map(String).join(" "));
  try {
    using server = Bun.serve({
      port: 0,
      error() {
        errorHandlerCalls += 1;
        return new Response("replacement", { status: 555 });
      },
      fetch() {
        return new Response(new ReadableStream({
          pull() {
            throw new Error("focused stream failure");
          },
        }), {
          status: 402,
          headers: { "x-started": "true" },
        });
      },
    });

    const result = await new Promise((resolve, reject) => {
      const request = http.get(server.url, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.once("end", () => resolve({
          status: response.statusCode,
          started: response.headers["x-started"],
          body: Buffer.concat(chunks).toString(),
        }));
        response.once("error", reject);
      });
      request.setTimeout(3000, () => request.destroy(new Error("stream error response timed out")));
      request.once("error", reject);
    });

    expect(result).toEqual({ status: 402, started: "true", body: "" });
    expect(errorHandlerCalls).toBe(0);
    expect(diagnostics.some(line => line.includes("error: focused stream failure"))).toBe(true);
  } finally {
    console.error = originalConsoleError;
  }
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

test("Bun.serve server.timeout overrides the response idle timeout", async () => {
  using server = Bun.serve({
    port: 0,
    idleTimeout: 1,
    fetch(request, activeServer) {
      activeServer.timeout(request, 0);
      return new Response(new ReadableStream({
        async pull(controller) {
          controller.enqueue("first");
          await Bun.sleep(1200);
          controller.enqueue("second");
          controller.close();
        },
      }));
    },
  });

  expect(await fetch(server.url).then(response => response.text())).toBe("firstsecond");
  expect(() => server.timeout(new Request(server.url), "1")).toThrow("timeout() requires a number");
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

test("an unconsumed empty HTTPS proxy response releases its CONNECT tunnel", async () => {
  const proxy = await createForwardProxy();
  let closed = false;
  using origin = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert, key },
    fetch: () => new Response(""),
  });
  try {
    const response = await fetch(origin.url, {
      proxy: {
        url: proxy.url,
        headers: { "X-Proxy-Tunnel": "present" },
      },
      keepalive: false,
      tls: { ca: cert, rejectUnauthorized: false },
    });
    expect(response.status).toBe(200);
    expect(proxy.requests[0].toLowerCase()).toContain("x-proxy-tunnel: present");
    await withTimeout(proxy.closeGracefully(), "CONNECT tunnel remained open after an empty response");
    closed = true;
  } finally {
    if (!closed) await proxy.close();
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
