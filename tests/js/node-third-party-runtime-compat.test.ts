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

test("IncomingMessage accepts a missing socket", () => {
  const message = new http.IncomingMessage(null as any);
  expect(message).toBeInstanceOf(http.IncomingMessage);
  expect(message.connection).toBe(message.socket);
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
