import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import httpDefault, * as http from "node:http";
import httpsDefault, * as https from "node:https";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-third-party-runtime-"));

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("fs string writes accept the legacy encoding overload", async () => {
  const target = path.join(root, "legacy-write.txt");
  const fd = fs.openSync(target, "w+");
  try {
    expect(fs.writeSync(fd, "sync", "utf8")).toBe(4);
    await new Promise<void>((resolve, reject) => {
      fs.write(fd, "-async", "utf8", error => error ? reject(error) : resolve());
    });
  } finally {
    fs.closeSync(fd);
  }
  expect(fs.readFileSync(target, "utf8")).toBe("sync-async");
});

test("HTTP named calls observe interceptors installed on default exports", () => {
  const originalHttp = { request: httpDefault.request, get: httpDefault.get };
  const originalHttps = { request: httpsDefault.request, get: httpsDefault.get };
  const values = {
    httpRequest: {},
    httpGet: {},
    httpsRequest: {},
    httpsGet: {},
  };

  try {
    httpDefault.request = (() => values.httpRequest) as typeof httpDefault.request;
    httpDefault.get = (() => values.httpGet) as typeof httpDefault.get;
    httpsDefault.request = (() => values.httpsRequest) as typeof httpsDefault.request;
    httpsDefault.get = (() => values.httpsGet) as typeof httpsDefault.get;

    expect(http.request({})).toBe(values.httpRequest);
    expect(http.get({})).toBe(values.httpGet);
    expect(https.request({})).toBe(values.httpsRequest);
    expect(https.get({})).toBe(values.httpsGet);
  } finally {
    httpDefault.request = originalHttp.request;
    httpDefault.get = originalHttp.get;
    httpsDefault.request = originalHttps.request;
    httpsDefault.get = originalHttps.get;
  }
});

test("IncomingMessage accepts a missing socket without ending the response", async () => {
  const message = new http.IncomingMessage(null as any);
  expect(message).toBeInstanceOf(http.IncomingMessage);
  expect(message.connection).toBe(message.socket);
  expect(message.complete).toBe(false);

  await Promise.resolve();
  expect(message.readableEnded).toBe(false);

  const body = new Promise<string>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    message.on("data", chunk => chunks.push(chunk));
    message.once("end", () => resolve(Buffer.concat(chunks).toString()));
    message.once("error", reject);
  });
  message.push(Buffer.from("intercepted"));
  message.push(null);
  message.complete = true;

  expect(await body).toBe("intercepted");
});

test("ClientRequest subclasses can synthesize an intercepted response", async () => {
  class InterceptedClientRequest extends http.ClientRequest {
    response: http.IncomingMessage;

    constructor(callback: (response: http.IncomingMessage) => void) {
      super({
        protocol: "http:",
        hostname: "interception.invalid",
        method: "GET",
        path: "/resource",
      }, callback);
      this.response = new http.IncomingMessage(this.socket as any);
    }

    end(...args: any[]) {
      const callback = args.find(value => typeof value === "function");
      Object.defineProperties(this, {
        writableFinished: { value: true },
        writableEnded: { value: true },
      });
      this.emit("finish");

      this.response.statusCode = 200;
      this.response.statusMessage = "OK";
      this.response.headers = { "content-type": "application/json" };
      this.response.rawHeaders = ["content-type", "application/json"];
      this.res = this.response;

      queueMicrotask(() => {
        this.emit("response", this.response);
        this.response.push(Buffer.from('{"source":"interceptor"}'));
        this.response.push(null);
        this.response.complete = true;
        callback?.();
      });
      return this;
    }
  }

  const body = await new Promise<string>((resolve, reject) => {
    const request = new InterceptedClientRequest(response => {
      const chunks: Uint8Array[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("end", () => resolve(Buffer.concat(chunks).toString()));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end();
  });

  expect(body).toBe('{"source":"interceptor"}');
});

test("global fetch can be intercepted and restored", async () => {
  const nativeFetch = globalThis.fetch;
  const requests: string[] = [];
  const interceptedFetch: typeof fetch = async input => {
    const request = new Request(input);
    requests.push(request.url);
    return Response.json({ intercepted: true });
  };

  globalThis.fetch = interceptedFetch;
  try {
    expect(globalThis.fetch).toBe(interceptedFetch);
    expect(await fetch("http://localhost/intercepted").then(response => response.json())).toEqual({ intercepted: true });
    expect(requests).toEqual(["http://localhost/intercepted"]);
  } finally {
    globalThis.fetch = nativeFetch;
  }

  expect(globalThis.fetch).toBe(nativeFetch);
});

test("zlib constructors called as methods return stream instances", async () => {
  const gzip = zlib.Gzip();
  expect(gzip).not.toBe(zlib);
  expect(gzip).toBeInstanceOf(zlib.Gzip);

  const chunks: Uint8Array[] = [];
  gzip.on("data", chunk => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    gzip.once("end", resolve);
    gzip.once("error", reject);
    gzip.end("callable constructor");
  });

  expect(zlib.gunzipSync(Buffer.concat(chunks)).toString()).toBe("callable constructor");
});
