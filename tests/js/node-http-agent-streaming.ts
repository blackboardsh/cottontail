import { expect, test } from "bun:test";
import http from "node:http";
import net from "node:net";
import { once } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";

async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

async function close(server: http.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function startGet(port: number, agent: http.Agent, path = "/") {
  let request: http.ClientRequest;
  const result = new Promise<{ body: string; socket: net.Socket }>((resolve, reject) => {
    request = http.get({ hostname: "127.0.0.1", port, path, agent }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ body, socket: request.socket! }));
    });
    request.on("error", reject);
  });
  return { request: request!, result };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("Agent exposes Node-compatible pool defaults and maxTotalSockets validation", () => {
  const agent = new http.Agent({
    defaultPort: 0,
    keepAliveMsecs: 0,
    maxSockets: 0,
    maxFreeSockets: 0,
  });

  expect(agent.defaultPort).toBe(80);
  expect(agent.keepAliveMsecs).toBe(1000);
  expect(agent.maxSockets).toBe(Infinity);
  expect(agent.maxFreeSockets).toBe(256);
  expect(Object.getPrototypeOf(agent.options)).toBeNull();
  expect(Object.getPrototypeOf(agent.requests)).toBeNull();
  expect(Object.getPrototypeOf(agent.sockets)).toBeNull();
  expect(Object.getPrototypeOf(agent.freeSockets)).toBeNull();
  expect(new http.Agent({ maxTotalSockets: 1.5 }).maxTotalSockets).toBe(1.5);
  expect(new http.Agent({ maxTotalSockets: Infinity }).maxTotalSockets).toBe(Infinity);

  for (const value of ["2", 0, -1, NaN]) {
    try {
      new http.Agent({ maxTotalSockets: value as number });
      throw new Error("constructor should have failed");
    } catch (error: any) {
      expect(error.code).toBe(typeof value === "number" ? "ERR_OUT_OF_RANGE" : "ERR_INVALID_ARG_TYPE");
    }
  }
});

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

test("Agent reserves asynchronous socket creation before applying pool limits", async () => {
  let createConnectionCount = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const server = http.createServer((_request, response) => {
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    setTimeout(() => {
      activeRequests -= 1;
      response.end("ok");
    }, 20);
  });
  const port = await listen(server);

  class DeferredAgent extends http.Agent {
    createSocket(request, options, callback) {
      setTimeout(() => super.createSocket(request, options, callback), 10);
      return undefined;
    }

    createConnection(options, callback) {
      createConnectionCount += 1;
      return super.createConnection(options, callback);
    }
  }

  const agent = new DeferredAgent({ keepAlive: true, maxSockets: 2, maxTotalSockets: 2 });
  try {
    const pending = Array.from({ length: 6 }, () => startGet(port, agent));
    const name = agent.getName({ host: "127.0.0.1", port });
    expect(agent.requests[name]?.length).toBe(4);
    expect(agent.requests[name]?.[0]).toBe(pending[2].request);
    expect(agent.totalSocketCount).toBe(0);

    const results = await withTimeout(Promise.all(pending.map(({ result }) => result)));
    expect(results.map(({ body }) => body)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok"]);
    expect(createConnectionCount).toBe(2);
    expect(maxActiveRequests).toBe(2);
    expect(Object.keys(agent.requests)).toEqual([]);
  } finally {
    agent.destroy();
    await close(server);
  }
});

test("Agent refreshes AsyncLocalStorage context when reusing a socket", async () => {
  const storage = new AsyncLocalStorage<string>();
  const server = http.createServer((_request, response) => response.end("ok"));
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

  const requestInStore = (expected: string) => storage.run(expected, () => {
    return new Promise<net.Socket>((resolve, reject) => {
      let contextError: Error | undefined;
      const checkContext = (event: string) => {
        const actual = storage.getStore();
        if (actual !== expected && contextError === undefined) {
          contextError = new Error(`${event}: expected ${expected}, received ${actual}`);
        }
      };
      const request = http.get({ hostname: "127.0.0.1", port, agent }, (response) => {
        checkContext("response");
        response.on("data", () => checkContext("data"));
        response.on("end", () => {
          checkContext("end");
          if (contextError) reject(contextError);
          else resolve(request.socket!);
        });
      });
      request.on("error", reject);
    });
  });

  try {
    const firstSocket = await withTimeout(requestInStore("first"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const secondSocket = await withTimeout(requestInStore("second"));
    expect(secondSocket).toBe(firstSocket);
  } finally {
    agent.destroy();
    await close(server);
  }
});

test("Agent applies FIFO and LIFO scheduling to reusable sockets", async () => {
  for (const scheduling of ["fifo", "lifo"] as const) {
    const heldResponses: http.ServerResponse[] = [];
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => { releaseReady = resolve; });
    const server = http.createServer((request, response) => {
      if (request.url === "/seed") {
        heldResponses.push(response);
        if (heldResponses.length === 3) releaseReady();
        return;
      }
      response.end("next");
    });
    const port = await listen(server);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 3, scheduling });
    try {
      const seed = Array.from({ length: 3 }, () => startGet(port, agent, "/seed").result);
      await withTimeout(ready);
      for (const response of heldResponses) response.end("seed");
      await withTimeout(Promise.all(seed));

      const name = agent.getName({ host: "127.0.0.1", port });
      const free = agent.freeSockets[name];
      expect(free.length).toBe(3);
      const expectedSocket = scheduling === "fifo" ? free[0] : free[free.length - 1];
      const next = await withTimeout(startGet(port, agent, "/next").result);
      expect(next.socket).toBe(expectedSocket);
    } finally {
      agent.destroy();
      await close(server);
    }
  }
});

test("Agent enforces maxTotalSockets while making progress across origins", async () => {
  const createServer = () => http.createServer((_request, response) => {
    setTimeout(() => response.end("ok"), 15);
  });
  const firstServer = createServer();
  const secondServer = createServer();
  const firstPort = await listen(firstServer);
  const secondPort = await listen(secondServer);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 2, maxTotalSockets: 2 });
  let maxObservedSockets = 0;
  try {
    const pending = [
      ...Array.from({ length: 4 }, () => startGet(firstPort, agent)),
      ...Array.from({ length: 4 }, () => startGet(secondPort, agent)),
    ];
    for (const { request } of pending) {
      request.on("socket", () => {
        maxObservedSockets = Math.max(maxObservedSockets, agent.totalSocketCount);
      });
    }

    const results = await withTimeout(Promise.all(pending.map(({ result }) => result)));
    expect(results).toHaveLength(8);
    expect(maxObservedSockets).toBe(2);
    expect(agent.totalSocketCount).toBeLessThanOrEqual(2);
    expect(Object.keys(agent.requests)).toEqual([]);
  } finally {
    agent.destroy();
    await Promise.all([close(firstServer), close(secondServer)]);
  }
});

test("Agent timeout evicts an idle keep-alive socket", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, timeout: 40 });
  try {
    const freeEvent = once(agent, "free");
    await withTimeout(startGet(port, agent).result);
    const [socket] = await withTimeout(freeEvent) as [net.Socket];
    const name = agent.getName({ host: "127.0.0.1", port });
    expect(agent.freeSockets[name]).toContain(socket);
    expect(socket.timeout).toBe(40);
    await withTimeout(once(socket, "close"));
    expect(agent.freeSockets[name]).toBeUndefined();
    expect(agent.totalSocketCount).toBe(0);
  } finally {
    agent.destroy();
    await close(server);
  }
});

test("Agent.destroy does not discard requests waiting for a socket", async () => {
  let requestCount = 0;
  let markFirstRequest!: () => void;
  const firstRequest = new Promise<void>((resolve) => { markFirstRequest = resolve; });
  const server = http.createServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      markFirstRequest();
      return;
    }
    response.end("queued");
  });
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const first = startGet(port, agent);
  void first.result.catch(() => {});
  try {
    await withTimeout(firstRequest);
    const second = startGet(port, agent);
    const name = agent.getName({ host: "127.0.0.1", port });
    expect(agent.requests[name]?.length).toBe(1);

    agent.destroy();
    const result = await withTimeout(second.result);
    expect(result.body).toBe("queued");
    expect(Object.keys(agent.requests)).toEqual([]);
  } finally {
    first.request.destroy();
    agent.destroy();
    await close(server);
  }
});

test("Agent removes upgraded sockets from pool accounting before handoff", async () => {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Connection: upgrade\r\n" +
        "Upgrade: test\r\n\r\n" +
        "upgrade-head",
      );
    });
  });
  const port = await listen(server as unknown as http.Server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const result = await withTimeout(new Promise<{ socket: net.Socket; head: Buffer }>((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port,
        agent,
        headers: { Connection: "upgrade", Upgrade: "test" },
      });
      request.once("upgrade", (_response, socket, head) => resolve({ socket, head }));
      request.once("error", reject);
      request.end();
    }));

    expect(result.head.toString()).toBe("upgrade-head");
    expect(agent.totalSocketCount).toBe(0);
    expect(Object.keys(agent.sockets)).toEqual([]);
    expect(Object.keys(agent.freeSockets)).toEqual([]);
    result.socket.destroy();
  } finally {
    agent.destroy();
    await close(server as unknown as http.Server);
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
