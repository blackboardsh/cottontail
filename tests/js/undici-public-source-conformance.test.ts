import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";

const undici = require("node:undici");
const servers = new Set<Server>();
const agents = new Set<any>();
const eventSources = new Set<any>();

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}`, host: `127.0.0.1:${address.port}` };
}

function trackedAgent(options?: object) {
  const agent = new undici.MockAgent(options);
  agents.add(agent);
  return agent;
}

function trackedEventSource(url: string, init?: object) {
  const source = new undici.EventSource(url, init);
  eventSources.add(source);
  return source;
}

function timeout<T>(promise: Promise<T>, milliseconds = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), milliseconds)),
  ]);
}

afterEach(async () => {
  for (const source of eventSources) source.close();
  eventSources.clear();
  for (const agent of agents) await Promise.resolve(agent.destroy()).catch(() => {});
  agents.clear();
  for (const server of servers) {
    server.closeAllConnections?.();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  servers.clear();
});

describe("Undici mock dispatchers", () => {
  test("matches origin, path, query, method, headers, and request body", async () => {
    const origin = "http://mock.example";
    const agent = trackedAgent();
    agent.disableNetConnect();
    const pool = agent.get(origin);
    pool.intercept({
      path: "/items",
      query: { b: "2", a: "1" },
      method: "post",
      headers: { "x-token": /^abc-/ },
      body: (body: string) => body === "payload",
    })
      .defaultReplyHeaders({ "x-default": "yes" })
      .defaultReplyTrailers({ "x-trailer": "done" })
      .replyContentLength()
      .reply(async (options: any) => ({
        statusCode: 201,
        data: { method: options.method, body: options.body },
        responseOptions: { headers: { "x-reply": "yes" } },
      }))
      .times(2);

    expect(agent.pendingInterceptors()).toHaveLength(1);
    for (let invocation = 0; invocation < 2; invocation++) {
      const response = await undici.request(`${origin}/items?a=1&b=2`, {
        dispatcher: agent,
        method: "POST",
        headers: { "x-token": "abc-123" },
        body: "payload",
      });
      expect(response.statusCode).toBe(201);
      expect(response.headers["x-default"]).toBe("yes");
      expect(response.headers["x-reply"]).toBe("yes");
      expect(Number(response.headers["content-length"])).toBeGreaterThan(0);
      expect(response.trailers["x-trailer"]).toBe("done");
      expect(await response.body.json()).toEqual({ method: "POST", body: "payload" });
      expect(agent.pendingInterceptors()).toHaveLength(invocation === 0 ? 1 : 0);
    }
    expect(() => agent.assertNoPendingInterceptors()).not.toThrow();
    await expect(undici.request(`${origin}/items?a=1&b=2`, { dispatcher: agent })).rejects.toMatchObject({
      name: "MockNotMatchedError",
      code: "UND_MOCK_ERR_MOCK_NOT_MATCHED",
    });
  });

  test("supports reply errors, delays, aborts, persistence, and interceptor validation", async () => {
    const origin = "http://mock.example";
    const agent = trackedAgent();
    agent.disableNetConnect();
    const pool = agent.get(origin);
    const expected = new Error("synthetic failure");
    pool.intercept({ path: "/error" }).replyWithError(expected);
    await expect(undici.request(`${origin}/error`, { dispatcher: agent })).rejects.toBe(expected);

    const controller = new AbortController();
    pool.intercept({ path: "/slow" }).reply(200, "late").delay(500);
    const delayed = undici.request(`${origin}/slow`, { dispatcher: agent, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(delayed).rejects.toMatchObject({ name: "AbortError", code: "UND_ERR_ABORTED" });

    pool.intercept({ path: "/persistent" }).reply(200, "again").persist();
    expect(await (await undici.request(`${origin}/persistent`, { dispatcher: agent })).body.text()).toBe("again");
    expect(await (await undici.request(`${origin}/persistent`, { dispatcher: agent })).body.text()).toBe("again");
    expect(agent.pendingInterceptors()).toHaveLength(0);
    expect(() => pool.intercept({ path: "/invalid" }).reply(200).times(0)).toThrow("repeatTimes");
    expect(() => pool.intercept({ path: "/invalid-delay" }).reply(200).delay(-1)).toThrow("waitInMs");
  });

  test("gates real networking by host and can deactivate mocking", async () => {
    let requests = 0;
    const { url, host } = await listen((_request, response) => {
      requests++;
      response.end("network");
    });
    const agent = trackedAgent();
    agent.disableNetConnect();
    await expect(undici.request(url, { dispatcher: agent })).rejects.toMatchObject({
      code: "UND_MOCK_ERR_MOCK_NOT_MATCHED",
    });
    expect(requests).toBe(0);

    agent.enableNetConnect(host);
    expect(await (await undici.request(url, { dispatcher: agent })).body.text()).toBe("network");
    expect(requests).toBe(1);

    agent.disableNetConnect();
    agent.deactivate();
    expect(await (await undici.request(url, { dispatcher: agent })).body.text()).toBe("network");
    expect(requests).toBe(2);
    agent.activate();
  });

  test("shares regular-expression origin interceptors and exposes MockClient mode", async () => {
    const agent = trackedAgent({ connections: 1 });
    agent.disableNetConnect();
    const matcher = agent.get(/^http:\/\/service-[0-9]+\.example$/);
    expect(matcher).toBeInstanceOf(undici.MockClient);
    matcher.intercept({ path: "/health" }).reply(200, "ok").persist();
    expect(await (await undici.request("http://service-1.example/health", { dispatcher: agent })).body.text()).toBe("ok");
    expect(await (await undici.request("http://service-2.example/health", { dispatcher: agent })).body.text()).toBe("ok");
    await expect(undici.request("http://other.example/health", { dispatcher: agent })).rejects.toMatchObject({
      code: "UND_MOCK_ERR_MOCK_NOT_MATCHED",
    });
  });

  test("routes fetch and both dispatch handler generations through interceptors", async () => {
    const origin = "http://mock.example";
    const agent = trackedAgent({ connections: 1 });
    agent.disableNetConnect();
    const client = agent.get(origin);
    client.intercept({ path: "/fetch" }).reply(200, { mocked: true }, { headers: { "content-type": "application/json" } });
    expect(await (await undici.fetch(`${origin}/fetch`, { dispatcher: agent })).json()).toEqual({ mocked: true });

    client.intercept({ path: "/dispatch" }).reply(206, "chunk");
    const events: string[] = [];
    await timeout(new Promise<void>((resolve, reject) => {
      client.dispatch({ path: "/dispatch" }, {
        onRequestStart() { events.push("request"); },
        onResponseStart(controller: any, statusCode: number) {
          events.push(`headers:${statusCode}`);
          controller.pause();
          queueMicrotask(() => controller.resume());
        },
        onResponseData(_controller: any, chunk: Uint8Array) { events.push(`data:${Buffer.from(chunk)}`); },
        onResponseEnd() { events.push("end"); resolve(); },
        onResponseError(_controller: any, error: Error) { reject(error); },
      });
    }));
    expect(events).toEqual(["request", "headers:206", "data:chunk", "end"]);
  });

  test("forced disposal aborts a delayed intercepted request", async () => {
    const origin = "http://mock.example";
    const agent = trackedAgent();
    agent.disableNetConnect();
    agent.get(origin).intercept({ path: "/delayed" }).reply(200, "late").delay(5000);
    const pending = undici.request(`${origin}/delayed`, { dispatcher: agent });
    await Promise.resolve();
    const destroying = agent.destroy();
    await expect(pending).rejects.toMatchObject({ code: "UND_ERR_DESTROYED" });
    await destroying;
  });
});

describe("Undici EventSource", () => {
  test("exposes Web-compatible state, handler, and constructor contracts", () => {
    expect(undici.EventSource.CONNECTING).toBe(0);
    expect(undici.EventSource.OPEN).toBe(1);
    expect(undici.EventSource.CLOSED).toBe(2);
    expect(undici.EventSource.prototype.CONNECTING).toBe(0);
    expect(() => new undici.EventSource()).toThrow();
    expect(() => new undici.EventSource("file:///tmp/events")).toThrow();
  });

  test("incrementally parses BOM, CRLF, comments, ids, multiline data, and custom events", async () => {
    const { url } = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      const payload = Buffer.from("\uFEFF: comment\r\nretry: 5\r\nid: event-1\r\nevent: custom\r\ndata: first\r\ndata: second\r\n\r\n");
      response.write(payload.subarray(0, 1));
      response.write(payload.subarray(1, 4));
      response.end(payload.subarray(4));
    });
    const source = trackedEventSource(url, { withCredentials: true });
    let opened = false;
    source.onopen = () => { opened = true; };
    const event: any = await timeout(new Promise(resolve => {
      source.addEventListener("custom", (value: any) => {
        source.close();
        resolve(value);
      });
    }));
    expect(opened).toBe(true);
    expect(event.data).toBe("first\nsecond");
    expect(event.lastEventId).toBe("event-1");
    expect(event.origin).toBe(new URL(url).origin);
    expect(source.url).toBe(`${url}/`);
    expect(source.withCredentials).toBe(true);
    expect(source.readyState).toBe(undici.EventSource.CLOSED);
  });

  test("reconnects using retry and Last-Event-ID", async () => {
    let requests = 0;
    let reconnectId: string | undefined;
    const { url } = await listen((request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests === 1) {
        response.end("retry: 5\nid: first-id\ndata: first\n\n");
      } else {
        reconnectId = request.headers["last-event-id"] as string | undefined;
        response.end("data: second\n\n");
      }
    });
    const source = trackedEventSource(url);
    const messages: string[] = [];
    let errors = 0;
    source.onerror = () => { errors++; };
    await timeout(new Promise<void>(resolve => {
      source.onmessage = (event: any) => {
        messages.push(event.data);
        if (event.data === "second") {
          source.close();
          resolve();
        }
      };
    }));
    expect(messages).toEqual(["first", "second"]);
    expect(reconnectId).toBe("first-id");
    expect(requests).toBe(2);
    expect(errors).toBeGreaterThanOrEqual(1);
  });

  test("fails permanently for invalid status or MIME type", async () => {
    let requests = 0;
    const { url } = await listen((_request, response) => {
      requests++;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("data: ignored\n\n");
    });
    const source = trackedEventSource(url);
    await timeout(new Promise<void>(resolve => { source.onerror = () => resolve(); }));
    expect(source.readyState).toBe(undici.EventSource.CLOSED);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(requests).toBe(1);
  });

  test("uses a supplied dispatcher and close prevents reconnection", async () => {
    const origin = "http://events.example";
    const agent = trackedAgent();
    agent.disableNetConnect();
    agent.get(origin).intercept({ path: "/stream", headers: { accept: "text/event-stream" } })
      .reply(200, "retry: 1\nid: mocked\ndata: hello\n\n", { headers: { "content-type": "text/event-stream" } });
    const source = trackedEventSource(`${origin}/stream`, { dispatcher: agent });
    const event: any = await timeout(new Promise(resolve => {
      source.onmessage = (value: any) => {
        source.close();
        resolve(value);
      };
    }));
    expect(event.data).toBe("hello");
    expect(event.lastEventId).toBe("mocked");
    expect(source.readyState).toBe(undici.EventSource.CLOSED);
    expect(agent.pendingInterceptors()).toHaveLength(0);
  });
});
