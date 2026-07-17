import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";

const servers = new Set<Server>();

async function listen(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
}

afterEach(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  servers.clear();
});

describe("fetch source transport", () => {
  test("resolves response headers while a streaming upload is still open", async () => {
    let releaseUpload!: () => void;
    const uploadReleased = new Promise<void>(resolve => { releaseUpload = resolve; });
    let firstChunk!: () => void;
    const sawFirstChunk = new Promise<void>(resolve => { firstChunk = resolve; });
    const { url } = await listen((request, response) => {
      request.once("data", () => {
        firstChunk();
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("accepted");
      });
    });

    let sentFirst = false;
    const body = new ReadableStream({
      async pull(controller) {
        if (!sentFirst) {
          sentFirst = true;
          controller.enqueue(Buffer.from("first"));
          return;
        }
        await uploadReleased;
        controller.enqueue(Buffer.from("second"));
        controller.close();
      },
    });
    const responsePromise = fetch(url, { method: "POST", body, duplex: "half" } as RequestInit);
    await sawFirstChunk;
    const response = await responsePromise;
    expect(await response.text()).toBe("accepted");
    expect(body.locked).toBe(true);
    releaseUpload();
  });

  test("streams response chunks in order and propagates abort to body reads", async () => {
    let finish!: () => void;
    const allowFinish = new Promise<void>(resolve => { finish = resolve; });
    const { url } = await listen(async (_request, response) => {
      response.writeHead(200);
      response.write("one");
      await allowFinish;
      response.end("two");
    });
    const response = await fetch(url);
    const reader = response.body!.getReader();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("one");
    finish();
    expect(Buffer.from((await reader.read()).value!).toString()).toBe("two");
    expect((await reader.read()).done).toBe(true);

    const hanging = await listen((_request, response) => {
      response.writeHead(200);
      response.write("started");
    });
    const controller = new AbortController();
    const abortedResponse = await fetch(hanging.url, { signal: controller.signal });
    controller.abort();
    await expect(abortedResponse.text()).rejects.toMatchObject({
      name: "AbortError",
      message: "The operation was aborted.",
    });
  });

  test("rewrites redirect requests and decodes only the final response", async () => {
    let finalRequest: { method?: string; authorization?: string; contentType?: string; body: string } | undefined;
    const destination = await listen((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        finalRequest = {
          method: request.method,
          authorization: request.headers.authorization,
          contentType: request.headers["content-type"],
          body,
        };
        response.writeHead(200, { "content-encoding": "gzip" });
        response.end(gzipSync("redirected"));
      });
    });
    const source = await listen((_request, response) => {
      response.writeHead(302, {
        location: destination.url,
        "content-encoding": "gzip",
      });
      response.end();
    });

    const response = await fetch(source.url, {
      method: "POST",
      headers: { authorization: "secret" },
      body: "payload",
    });
    expect(await response.text()).toBe("redirected");
    expect(response.redirected).toBe(true);
    expect(finalRequest).toEqual({ method: "GET", authorization: undefined, contentType: undefined, body: "" });

    await expect(fetch(source.url, { redirect: "error" })).rejects.toMatchObject({ code: "UnexpectedRedirect" });
  });

  test("uses an HTTP proxy in-process and reuses keepalive connections", async () => {
    let proxyTarget = "";
    const proxy = await listen((request, response) => {
      proxyTarget = request.url ?? "";
      response.end("proxied");
    });
    const proxied = await fetch("http://example.invalid/resource?q=1", { proxy: proxy.url } as RequestInit);
    expect(await proxied.text()).toBe("proxied");
    expect(proxyTarget).toBe("http://example.invalid/resource?q=1");

    let connections = 0;
    const origin = await listen((_request, response) => response.end("ok"));
    origin.server.on("connection", () => { connections += 1; });
    expect(await (await fetch(origin.url)).text()).toBe("ok");
    expect(await (await fetch(origin.url)).text()).toBe("ok");
    expect(connections).toBe(1);
  });
});

describe("node:undici source port", () => {
  test("captures startup Web primitives and exposes request bodies as Node streams", async () => {
    const originals = {
      Response,
      Request,
      Headers,
      FormData,
      File,
    };
    Object.assign(globalThis, {
      Response: 42,
      Request: 42,
      Headers: 42,
      FormData: 42,
      File: 42,
    });
    const undici = require("node:undici");
    expect(undici.Response).toBe(originals.Response);
    expect(undici.Request).toBe(originals.Request);
    expect(undici.Headers).toBe(originals.Headers);
    expect(undici.FormData).toBe(originals.FormData);
    expect(undici.File).toBe(originals.File);
    Object.assign(globalThis, originals);

    const { url } = await listen((request, response) => {
      if (request.url === "/failure") {
        response.writeHead(404);
        response.end("missing");
        return;
      }
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ method: request.method, body, query: request.url }));
      });
    });
    const result = await undici.request(`${url}/echo`, {
      method: "POST",
      body: "hello",
      query: { a: "1" },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBeInstanceOf(require("node:stream").Readable);
    expect(await result.body.json()).toEqual({ method: "POST", body: "hello", query: "/echo?a=1" });
    expect(result.body.bodyUsed).toBe(true);
    await expect(result.body.text()).rejects.toThrow("unusable");
    await expect(undici.request(`${url}/failure`, { throwOnError: true })).rejects.toThrow(
      "Request failed with status code 404",
    );
    await expect(undici.request(url, { method: "GET", body: "no" })).rejects.toThrow(
      "Body not allowed for GET or HEAD requests",
    );
  });

  test("streams request bodies and enforces headers and body timeouts", async () => {
    const undici = require("node:undici");
    const { url } = await listen((request, response) => {
      if (request.url === "/headers-timeout") return;
      if (request.url === "/body-timeout") {
        response.writeHead(200);
        response.write("first");
        return;
      }
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => response.end(body));
    });

    async function* upload() {
      yield Buffer.from("streamed-");
      await Promise.resolve();
      yield Buffer.from("body");
    }
    const streamed = await undici.request(`${url}/upload`, { method: "POST", body: upload() });
    expect(await streamed.body.text()).toBe("streamed-body");

    await expect(undici.request(`${url}/headers-timeout`, { headersTimeout: 20 })).rejects.toMatchObject({
      name: "HeadersTimeoutError",
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    const partial = await undici.request(`${url}/body-timeout`, { bodyTimeout: 20 });
    await expect(partial.body.text()).rejects.toMatchObject({
      name: "BodyTimeoutError",
      code: "UND_ERR_BODY_TIMEOUT",
    });
  });

  test("implements cookie and MIME helpers", () => {
    const undici = require("undici");
    const headers = new undici.Headers({ cookie: "a=1; b=two" });
    expect(undici.getCookies(headers)).toEqual({ a: "1", b: "two" });
    undici.setCookie(headers, { name: "sid", value: "abc", httpOnly: true, path: "/" });
    expect(undici.getSetCookies(headers)[0]).toMatchObject({ name: "sid", value: "abc", httpOnly: true, path: "/" });
    undici.deleteCookie(headers, "sid");
    expect(undici.getSetCookies(headers)).toHaveLength(2);

    const mime = undici.parseMIMEType("Text/HTML; charset=utf-8");
    expect(mime.essence).toBe("text/html");
    expect(mime.parameters.get("charset")).toBe("utf-8");
    expect(undici.serializeAMimeType(mime)).toBe("text/html;charset=utf-8");
  });
});
