import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { Duplex, PassThrough, Readable, Transform, Writable, finished } from "node:stream";
import { buffer, text } from "node:stream/consumers";

test("stream constructors use current defaults and validate defaultEncoding", () => {
  const readable = new Readable({ read() {} });
  const writable = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

  expect(readable.readableHighWaterMark).toBe(64 * 1024);
  expect(writable.writableHighWaterMark).toBe(64 * 1024);
  expect(new Readable({ objectMode: true, read() {} }).readableHighWaterMark).toBe(16);
  expect(new Writable({ objectMode: true, write(_chunk, _encoding, callback) { callback(); } })
    .writableHighWaterMark).toBe(16);

  for (const StreamCtor of [Readable, Writable]) {
    assert.throws(
      () => new StreamCtor({ defaultEncoding: "not-an-encoding" }),
      { code: "ERR_UNKNOWN_ENCODING" },
    );
  }
});

test("stream constructors preallocate Node event slots without reporting placeholder listeners", () => {
  const expected = new Map([
    [Readable, ["close", "error", "data", "end", "readable"]],
    [Writable, ["close", "error", "prefinish", "finish", "drain"]],
    [Duplex, ["close", "error", "prefinish", "finish", "drain", "data", "end", "readable"]],
    [Transform, ["close", "error", "prefinish", "finish", "drain", "data", "end", "readable"]],
    [PassThrough, ["close", "error", "prefinish", "finish", "drain", "data", "end", "readable"]],
  ]);

  for (const [StreamConstructor, eventSlots] of expected) {
    const stream = StreamConstructor({});
    expect(Reflect.ownKeys(stream._events)).toEqual(eventSlots);
    expect(stream.eventNames()).toEqual(
      StreamConstructor === Transform || StreamConstructor === PassThrough ? ["prefinish"] : [],
    );
  }
});

test("writable accepts ArrayBufferView chunks and passes null to a successful end callback", async () => {
  const received: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      received.push(chunk);
      callback();
    },
  });
  const source = Uint8Array.from([0x61, 0x62, 0x63, 0x64]);

  writable.write(new DataView(source.buffer, 1, 2) as never);
  const callbackError = await new Promise<Error | null>((resolve) => {
    writable.end(new Uint16Array(Uint8Array.from([0x65, 0x66]).buffer) as never, resolve);
  });

  expect(callbackError).toBeNull();
  expect(received.every(Buffer.isBuffer)).toBe(true);
  expect(Buffer.concat(received).toString()).toBe("bcef");
});

test("writable async disposal destroys unfinished streams without surfacing AbortError", async () => {
  const writable = new Writable({ write(_chunk, _encoding, _callback) {} });
  writable.write("pending");

  await writable[Symbol.asyncDispose]();

  expect(writable.destroyed).toBe(true);
});

test("finished tolerates legacy close-after-EOF ordering but preserves premature close errors", async () => {
  const legacy = new Readable({ read() {} });
  const legacyDone = new Promise<void>((resolve, reject) => {
    finished(legacy, (error) => error ? reject(error) : resolve());
  });
  legacy.push("tail");
  legacy.push(null);
  Object.defineProperty(legacy, "readableEnded", { value: true, configurable: true });
  legacy.emit("close");
  legacy.resume();
  await legacyDone;

  const incomplete = new Readable({ read() {} });
  const incompleteDone = new Promise<Error | undefined>((resolve) => finished(incomplete, resolve));
  incomplete.push("tail");
  incomplete.push(null);
  incomplete.destroy();
  expect((await incompleteDone)?.code).toBe("ERR_STREAM_PREMATURE_CLOSE");
});

test("stream consumers decode split UTF-8 and reject locked or object-valued text streams", async () => {
  const encoded = Uint8Array.from([0xe2, 0x82, 0xac]);
  expect(await text(Readable.from([encoded.subarray(0, 1), encoded.subarray(1)]))).toBe("\u20ac");

  await assert.rejects(text(Readable.from([{ value: 1 }])), { code: "ERR_INVALID_ARG_TYPE" });

  const web = new ReadableStream({ start(controller) { controller.close(); } });
  const reader = web.getReader();
  try {
    await assert.rejects(text(web), { code: "ERR_INVALID_STATE" });
  } finally {
    reader.releaseLock();
  }
});

test("Readable Web adapters preserve byte content in both directions", async () => {
  const web = Readable.toWeb(Readable.from([Buffer.from("web"), Uint8Array.from([0x21])]));
  expect((await buffer(web)).toString()).toBe("web!");

  const node = Readable.fromWeb(new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from([0x6e, 0x6f, 0x64, 0x65]));
      controller.close();
    },
  }));
  expect(await text(node)).toBe("node");
});
