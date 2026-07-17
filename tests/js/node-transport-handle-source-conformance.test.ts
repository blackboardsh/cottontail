import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, unlinkSync } from "node:fs";
import * as http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

const httpCommon = require("_http_common");
const { HTTPParser } = process.binding("http_parser") as any;

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      assert.ok(address && typeof address === "object");
      resolve(address.port);
    });
  });
}

test("Socket._handle is stable from pending connect through native attachment", async () => {
  const server = net.createServer(socket => socket.end());
  const port = await listen(server);
  const socket = net.connect(port, "127.0.0.1");
  const connected = once(socket, "connect");
  const closed = once(socket, "close");
  const handle = (socket as any)._handle;

  assert.ok(handle);
  assert.strictEqual(handle.fd, -1);
  assert.strictEqual(handle.hasRef(), true);
  handle.unref();
  assert.strictEqual(handle.hasRef(), false);
  handle.ref();
  assert.strictEqual(handle.hasRef(), true);

  await connected;
  assert.strictEqual((socket as any)._handle, handle);
  assert.ok(handle.fd >= 0);

  await closed;
  assert.strictEqual((socket as any)._handle, null);
  await new Promise<void>(resolve => server.close(() => resolve()));
});

test("HTTPParser.consume accepts a pending Socket._handle", async () => {
  const server = net.createServer(socket => {
    socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
    setTimeout(() => {
      socket.write("1\r\n\n\r\n");
      setTimeout(() => {
        socket.write("1\r\n\n\r\n");
        setImmediate(() => socket.destroy());
      }, 25);
    }, 25);
  });
  const port = await listen(server);
  const socket = net.connect(port, "127.0.0.1");
  const closed = once(socket, "close");
  const handle = (socket as any)._handle;
  const parser = new HTTPParser(HTTPParser.RESPONSE, false);
  let executeCalls = 0;
  let headersCompleteCalls = 0;
  let bodyCalls = 0;
  let timeoutCalls = 0;

  parser.initialize(HTTPParser.RESPONSE, {}, 0, 0);
  parser[HTTPParser.kOnExecute] = () => { executeCalls += 1; };
  parser[HTTPParser.kOnHeadersComplete] = () => { headersCompleteCalls += 1; };
  parser[HTTPParser.kOnBody] = () => { bodyCalls += 1; };
  parser[HTTPParser.kOnTimeout] = () => { timeoutCalls += 1; };
  parser.consume(handle);

  await closed;
  parser.unconsume();
  parser.close();
  await new Promise<void>(resolve => server.close(() => resolve()));

  assert.ok(executeCalls >= 3);
  assert.strictEqual(headersCompleteCalls, 1);
  assert.strictEqual(bodyCalls, 2);
  assert.strictEqual(timeoutCalls, 0);
});

test("setMaxIdleHTTPParsers separates type and range validation", () => {
  const invalidTypes = [Symbol(), {}, [], () => {}, 1n, true, "1", null, undefined];
  for (const value of invalidTypes) {
    assert.throws(() => http.setMaxIdleHTTPParsers(value as never), { code: "ERR_INVALID_ARG_TYPE" });
  }

  for (const value of [-1, -Infinity, NaN, 0, 1.1]) {
    assert.throws(() => http.setMaxIdleHTTPParsers(value), { code: "ERR_OUT_OF_RANGE" });
  }

  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    http.setMaxIdleHTTPParsers(value);
    assert.strictEqual(httpCommon.parsers.max, value);
  }
  http.setMaxIdleHTTPParsers(1000);
});

test("closing a Unix server removes its owned socket path", async () => {
  if (process.platform === "win32") return;
  const path = join(tmpdir(), `cottontail-net-close-${process.pid}-${Date.now()}.sock`);
  try { unlinkSync(path); } catch {}
  const server = net.createServer(socket => socket.end());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  assert.strictEqual(existsSync(path), true);
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.strictEqual(existsSync(path), false);
});
