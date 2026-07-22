import { expect, test } from "bun:test";
import { once } from "node:events";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { cert, key } from "./fixtures/tls-cert.js";

async function listen(server: https.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as net.AddressInfo).port;
}

async function close(server: https.Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  });
}

async function get(port: number, agent: https.Agent) {
  return await new Promise<{ response: http.IncomingMessage; socket: any }>((resolve, reject) => {
    const request = https.get({ host: "127.0.0.1", port, agent }, (response) => {
      const socket = response.socket;
      response.resume();
      response.on("end", () => resolve({ response, socket }));
    });
    request.on("error", reject);
  });
}

test("HTTPS Agent exposes Node-compatible constructor and pool keys", () => {
  const agent = (https.Agent as any)();
  expect(agent).toBeInstanceOf(https.Agent);
  expect(agent.maxCachedSessions).toBe(100);
  expect(agent.getName()).toBe("localhost::::::::::::::::::::::");
  expect(agent.getName({})).toBe("localhost::::::::::::::::::::::");

  expect(agent.getName({
    host: "0.0.0.0",
    port: 443,
    localAddress: "192.168.1.1",
    ca: "ca",
    cert: "cert",
    clientCertEngine: "dynamic",
    ciphers: "ciphers",
    crl: [Buffer.from("c"), Buffer.from("r"), Buffer.from("l")],
    dhparam: "dhparam",
    ecdhCurve: "ecdhCurve",
    honorCipherOrder: false,
    key: "key",
    pfx: "pfx",
    rejectUnauthorized: false,
    secureOptions: 0,
    secureProtocol: "secureProtocol",
    servername: "localhost",
    sessionIdContext: "sessionIdContext",
    sigalgs: "sigalgs",
    privateKeyIdentifier: "privateKeyIdentifier",
    privateKeyEngine: "privateKeyEngine",
  })).toBe(
    "0.0.0.0:443:192.168.1.1:ca:cert:dynamic:ciphers:key:pfx:false:localhost:" +
    "::secureProtocol:c,r,l:false:ecdhCurve:dhparam:0:sessionIdContext:" +
    '"sigalgs":privateKeyIdentifier:privateKeyEngine',
  );
});

test("HTTPS Agent session cache updates in place, evicts FIFO, and can be disabled", () => {
  const agent = new https.Agent({ maxCachedSessions: 2 }) as any;
  const first = Buffer.from("first");
  const updated = Buffer.from("updated");
  const second = Buffer.from("second");
  const third = Buffer.from("third");

  agent._cacheSession("one", first);
  agent._cacheSession("two", second);
  agent._cacheSession("one", updated);
  expect(agent._sessionCache.list).toEqual(["one", "two"]);
  expect(agent._getSession("one")).toBe(updated);

  agent._cacheSession("three", third);
  expect(agent._sessionCache.list).toEqual(["two", "three"]);
  expect(agent._getSession("one")).toBeUndefined();
  agent._evictSession("two");
  expect(agent._sessionCache.list).toEqual(["three"]);

  const disabled = new https.Agent({ maxCachedSessions: 0 }) as any;
  disabled._cacheSession("ignored", first);
  expect(disabled._sessionCache.list).toEqual([]);
  expect(disabled._getSession("ignored")).toBeUndefined();
});

test("HTTPS Agent propagates its pool key and injects cached sessions", async () => {
  const server = https.createServer({ cert, key }, (_request, response) => {
    response.setHeader("Connection", "close");
    response.end("ok");
  });
  const port = await listen(server);
  const suppliedKeys: string[] = [];
  const suppliedSessions: Array<Buffer | undefined> = [];

  class InspectingAgent extends https.Agent {
    createConnection(...args: any[]) {
      const options = args.find((value) => value && typeof value === "object") ?? {};
      suppliedKeys.push(options._agentKey);
      const socket = super.createConnection(...args);
      suppliedSessions.push(socket._session == null ? undefined : Buffer.from(socket._session));
      return socket;
    }
  }

  const agent = new InspectingAgent({ rejectUnauthorized: false, maxCachedSessions: 1 });
  try {
    const first = await get(port, agent);
    const cacheKey = agent.getName({
      ...agent.options,
      host: "127.0.0.1",
      hostname: "127.0.0.1",
      port,
      protocol: "https:",
      secureEndpoint: true,
    });
    const cached = (agent as any)._getSession(cacheKey);
    expect(Buffer.isBuffer(cached)).toBe(true);
    expect(cached.equals(first.socket.getSession())).toBe(true);

    await get(port, agent);
    expect(suppliedKeys).toEqual([cacheKey, cacheKey]);
    expect(suppliedSessions[0]).toBeUndefined();
    expect(suppliedSessions[1]?.equals(cached)).toBe(true);
  } finally {
    agent.destroy();
    await close(server);
  }
});

test("HTTPS Agent.createConnection supports Node's legacy signatures without mutation", async () => {
  const server = https.createServer({ cert, key }, (_request, response) => {
    response.setHeader("Connection", "close");
    response.end("direct");
  });
  const port = await listen(server);
  const agent = new https.Agent();

  const requestThrough = (create: () => any) => new Promise<string>((resolve, reject) => {
    const socket = create();
    let wire = "";
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("data", (chunk) => { wire += chunk; });
    socket.on("end", () => resolve(wire));
    socket.on("secureConnect", () => {
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
  });

  const options = Object.freeze({ rejectUnauthorized: false });
  try {
    const results = await Promise.all([
      requestThrough(() => agent.createConnection({ port, host: "127.0.0.1", rejectUnauthorized: false })),
      requestThrough(() => (agent.createConnection as any)(port, { host: "127.0.0.1", rejectUnauthorized: false })),
      requestThrough(() => (agent.createConnection as any)(port, "127.0.0.1", options)),
    ]);
    for (const wire of results) {
      expect(wire).toContain("HTTP/1.1 200 OK");
      expect(wire).toContain("direct");
    }
    expect(options).toEqual({ rejectUnauthorized: false });
  } finally {
    agent.destroy();
    await close(server);
  }
});
