import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { Writable } from "node:stream";
import { brotliCompressSync, deflateRawSync, gzipSync, zstdCompressSync } from "node:zlib";

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

  test("decodes gzip, raw deflate, Brotli, and Zstd through a backpressured body stream", async () => {
    const content = Buffer.from("streamed decoded content\n".repeat(20_000));
    const encodings = new Map([
      ["/gzip", ["gzip", gzipSync(content)]],
      ["/deflate", ["deflate", deflateRawSync(content)]],
      ["/br", ["br", brotliCompressSync(content)]],
      ["/zstd", ["zstd", zstdCompressSync(content)]],
    ] as const);
    const { url } = await listen((request, response) => {
      const [encoding, compressed] = encodings.get(request.url ?? "")!;
      response.writeHead(200, {
        "content-encoding": encoding,
        "content-length": compressed.byteLength,
      });
      const split = Math.max(1, Math.floor(compressed.byteLength / 3));
      response.write(compressed.subarray(0, split));
      response.write(compressed.subarray(split, split * 2));
      response.end(compressed.subarray(split * 2));
    });

    for (const path of encodings.keys()) {
      const reader = (await fetch(`${url}${path}`)).body!.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        chunks.push(result.value);
      }
      expect(Buffer.concat(chunks)).toEqual(content);
      expect(chunks.length).toBeGreaterThan(1);
    }
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

  test("honors dispatcher and writable backpressure and waits for graceful close", async () => {
    const undici = require("node:undici");
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>(resolve => { releaseResponse = resolve; });
    const { url } = await listen(async (request, response) => {
      if (request.url === "/delayed") {
        response.writeHead(200);
        response.write("first");
        await responseReleased;
        response.end("second");
        return;
      }
      response.end("dispatcher-body");
    });

    const streamed: Buffer[] = [];
    const result = await undici.stream(url, {}, () => new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        setTimeout(() => {
          streamed.push(Buffer.from(chunk));
          callback();
        }, 1);
      },
    }));
    expect(Buffer.concat(streamed).toString()).toBe("dispatcher-body");
    expect(result.trailers).toBeDefined();

    const client = new undici.Client(url);
    let resume!: () => void;
    const dispatched: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      client.dispatch({ path: "/" }, {
        onConnect() {},
        onHeaders(_status, _headers, resumeRequest) {
          resume = resumeRequest;
          queueMicrotask(resume);
          return false;
        },
        onData(chunk) {
          dispatched.push(Buffer.from(chunk));
          queueMicrotask(resume);
          return false;
        },
        onComplete() { resolve(); },
        onError(error) { reject(error); },
      });
    });
    expect(Buffer.concat(dispatched).toString()).toBe("dispatcher-body");

    const delayed = await client.request({ path: "/delayed" });
    let closed = false;
    const closing = client.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    releaseResponse();
    expect(await delayed.body.text()).toBe("firstsecond");
    await closing;
    expect(closed).toBe(true);
  });

  test("implements duplex pipeline", async () => {
    const undici = require("node:undici");
    const { url } = await listen((request, response) => request.pipe(response));

    const duplex = undici.pipeline(url, { method: "POST" }, ({ body }) => body);
    duplex.end("pipeline-body");
    const pipelineChunks: Buffer[] = [];
    for await (const chunk of duplex) pipelineChunks.push(Buffer.from(chunk));
    expect(Buffer.concat(pipelineChunks).toString()).toBe("pipeline-body");
  });

  test("implements CONNECT with a live socket", async () => {
    const undici = require("node:undici");
    const { server, url } = await listen((_request, response) => response.end());

    server.once("connect", (request, socket) => {
      expect(request.url).toBe("example.test:443");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\nconnected");
    });
    const connected = await undici.connect(url, { path: "example.test:443" });
    expect(connected.statusCode).toBe(200);
    expect(Buffer.from((await once(connected.socket, "data"))[0]).toString()).toBe("connected");
    connected.socket.destroy();
  });

  test("implements Upgrade with a live socket", async () => {
    const undici = require("node:undici");
    const { server, url } = await listen((_request, response) => response.end());
    server.once("upgrade", (request, socket) => {
      expect(request.headers.upgrade).toBe("cottontail");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: cottontail\r\n\r\nupgraded",
      );
    });
    const upgraded = await undici.upgrade(`${url}/upgrade`, { upgrade: "cottontail" });
    expect(upgraded.statusCode).toBe(101);
    expect(Buffer.from((await once(upgraded.socket, "data"))[0]).toString()).toBe("upgraded");
    upgraded.socket.destroy();
  });

  test("aborts active bodies during forced dispatcher disposal", async () => {
    const undici = require("node:undici");
    const hanging = await listen((_request, response) => {
      response.writeHead(200);
      response.write("partial");
    });
    const agent = new undici.Agent();
    const pending = await agent.request({ origin: hanging.url, path: "/" });
    const consuming = pending.body.text();
    const destroying = agent.destroy();
    await expect(consuming).rejects.toMatchObject({ code: "UND_ERR_DESTROYED" });
    await destroying;
  });
});
