import assert from "node:assert/strict";
import { once } from "node:events";
import net, { Socket, TCP } from "node:net";
import { Duplex } from "node:stream";
import { test } from "bun:test";

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

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

test("Socket is a Duplex and cork batches writes through _writev", async () => {
  let received = Buffer.alloc(0);
  const server = net.createServer(socket => {
    socket.on("data", chunk => {
      received = Buffer.concat([received, chunk]);
      if (received.byteLength === 8) socket.end();
    });
  });
  const port = await listen(server);
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");

  assert.ok(socket instanceof Duplex);
  assert.strictEqual(socket.listenerCount("end"), 1);
  const originalWritev = (socket as any)._writev;
  let writevCalls = 0;
  let writevChunks = 0;
  (socket as any)._writev = function(chunks: unknown[], callback: (error?: Error | null) => void) {
    writevCalls += 1;
    writevChunks += chunks.length;
    return originalWritev.call(this, chunks, callback);
  };

  const callbacks: string[] = [];
  socket.cork();
  assert.strictEqual(socket.write("one", () => callbacks.push("one")), true);
  assert.strictEqual(socket.write(Buffer.from("twø"), () => callbacks.push("two")), true);
  assert.strictEqual(socket.writableCorked, 1);
  assert.strictEqual(socket.writableLength, 7);
  assert.strictEqual(socket.bytesWritten, 7);
  socket.uncork();
  socket.end("!", () => callbacks.push("end"));

  await once(socket, "close");
  await close(server);
  assert.strictEqual(received.toString(), "onetwø!");
  assert.strictEqual(writevCalls, 1);
  assert.strictEqual(writevChunks, 2);
  assert.deepStrictEqual(callbacks, ["one", "two", "end"]);
  assert.strictEqual(socket.bytesWritten, 8);
});

test("corked _writev preserves backpressure until native writable readiness", async () => {
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const chunkCount = 32;
  let received = 0;
  const server = net.createServer({ pauseOnConnect: true }, socket => {
    socket.on("data", data => { received += data.byteLength; });
    socket.on("end", () => socket.end());
    setTimeout(() => socket.resume(), 30);
  });
  const port = await listen(server);
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");

  const originalWritev = (socket as any)._writev;
  let writevCalls = 0;
  (socket as any)._writev = function(chunks: unknown[], callback: (error?: Error | null) => void) {
    writevCalls += 1;
    return originalWritev.call(this, chunks, callback);
  };

  socket.cork();
  let sawBackpressure = false;
  for (let index = 0; index < chunkCount; index += 1) {
    if (!socket.write(chunk)) sawBackpressure = true;
  }
  assert.strictEqual(sawBackpressure, true);
  assert.strictEqual(socket.writableNeedDrain, true);
  assert.strictEqual(socket.bytesWritten, chunk.byteLength * chunkCount);
  const drained = once(socket, "drain");
  socket.uncork();
  await drained;
  assert.strictEqual(socket.writableNeedDrain, false);
  assert.strictEqual(socket.writableLength, 0);
  socket.end();

  await once(socket, "close");
  await close(server);
  assert.strictEqual(writevCalls, 1);
  assert.strictEqual(received, chunk.byteLength * chunkCount);
}, 10_000);

test("allowHalfOpen keeps writes valid after peer FIN and orders stream completion", async () => {
  let request = "";
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    socket.setEncoding("utf8");
    socket.on("data", chunk => { request += chunk; });
    socket.end("peer-fin");
  });
  const port = await listen(server);
  const socket = net.connect({ port, host: "127.0.0.1", allowHalfOpen: true });
  const events: string[] = [];
  for (const event of ["end", "finish", "close"] as const) socket.on(event, () => events.push(event));
  socket.resume();
  socket.once("end", () => {
    assert.strictEqual(socket.writable, true);
    socket.end("after-fin");
  });

  await once(socket, "close");
  await close(server);
  assert.strictEqual(request, "after-fin");
  assert.ok(events.indexOf("end") < events.indexOf("finish"));
  assert.ok(events.indexOf("finish") < events.indexOf("close"));
});

test("Socket adopts a raw TCP client handle", async () => {
  const listener = new TCP();
  assert.strictEqual(listener.bind("127.0.0.1", 0), 0);
  const address: { address?: string; port?: number } = {};
  assert.strictEqual(listener.getsockname(address), 0);
  assert.ok(address.port);

  let adopted: Socket | undefined;
  const accepted = new Promise<void>((resolve, reject) => {
    listener.onconnection = (status: number | Error, handle?: InstanceType<typeof TCP>) => {
      if (status instanceof Error || status !== 0 || handle == null) {
        reject(status instanceof Error ? status : new Error(`accept failed: ${status}`));
        return;
      }
      try {
        adopted = new Socket({ handle } as never);
        assert.strictEqual((adopted as any)._handle, handle);
        assert.strictEqual(handle.owner, adopted);
        adopted.once("error", reject);
        adopted.once("data", chunk => adopted!.end(`raw:${chunk}`));
        adopted.once("close", () => resolve());
        adopted.resume();
      } catch (error) {
        reject(error);
      }
    };
  });
  assert.strictEqual(listener.listen(), 0);

  const client = net.connect(address.port!, "127.0.0.1");
  let response = "";
  client.setEncoding("utf8");
  client.on("data", chunk => { response += chunk; });
  client.end("ping");
  await Promise.all([accepted, once(client, "close")]);
  listener.close();

  assert.strictEqual(response, "raw:ping");
  assert.strictEqual(adopted?.destroyed, true);
});

test("Socket transfers ownership of an existing Socket handle", async () => {
  let originalClosed = false;
  const server = net.createServer(original => {
    const handle = (original as any)._handle;
    const adopted = new Socket({ handle } as never);
    original.once("close", () => { originalClosed = true; });
    assert.strictEqual((adopted as any)._handle, handle);
    assert.strictEqual(handle.owner, adopted);
    adopted.once("data", chunk => adopted.end(`adopted:${chunk}`));
    adopted.resume();
  });
  const port = await listen(server);
  const client = net.connect(port, "127.0.0.1");
  let response = "";
  client.setEncoding("utf8");
  client.on("data", chunk => { response += chunk; });
  client.end("ping");

  await once(client, "close");
  await close(server);
  assert.strictEqual(response, "adopted:ping");
  assert.strictEqual(originalClosed, true);
});

// Drive the native read/EOF seam synchronously so this does not depend on
// whether the OS delivers a payload and its FIN in the same polling batch.
function socketWithRecordedWrites(options: net.SocketConstructorOpts = {}) {
  const socket = new Socket(options);
  const writes: string[] = [];
  (socket as any)._write = (chunk: Buffer, _encoding: string, callback: () => void) => {
    writes.push(String(chunk));
    callback();
  };
  (socket as any)._final = (callback: () => void) => callback();
  return { socket, writes };
}

for (const attachAfterEof of [false, true]) {
  test(`coalesced data and EOF preserve replies with ${attachAfterEof ? "immediate resume" : "a flowing listener"}`, async () => {
    const { socket, writes } = socketWithRecordedWrites();
    const closed = once(socket, "close");
    const received: string[] = [];
    const reply = (chunk: Buffer) => {
      received.push(String(chunk));
      socket.end(`reply:${chunk}`);
    };
    try {
      if (!attachAfterEof) socket.once("data", reply);
      (socket as any)._emitData(Buffer.from("ping"));
      (socket as any)._emitEnd();
      assert.strictEqual(socket.writableEnded, false);
      if (attachAfterEof) {
        socket.once("data", reply);
        socket.resume();
      }
      await closed;
      assert.deepStrictEqual(received, ["ping"]);
      assert.deepStrictEqual(writes, ["reply:ping"]);
      assert.strictEqual(socket.destroyed, true);
    } finally {
      socket.destroy();
    }
  });
}

test("coalesced EOF still closes a paused socket with unconsumed data", async () => {
  const { socket, writes } = socketWithRecordedWrites();
  const closed = once(socket, "close");
  socket.pause();
  (socket as any)._emitData(Buffer.from("unconsumed"));
  (socket as any)._emitEnd();
  await closed;
  assert.strictEqual(socket.destroyed, true);
  assert.deepStrictEqual(writes, []);
});

test("empty EOF closes a socket without an explicit resume", async () => {
  const { socket } = socketWithRecordedWrites();
  const closed = once(socket, "close");
  (socket as any)._emitEnd();
  await closed;
  assert.strictEqual(socket.destroyed, true);
});

for (const buffered of [false, true]) {
  test(`allowHalfOpen preserves delayed replies after ${buffered ? "buffered" : "empty"} EOF`, async () => {
    const { socket, writes } = socketWithRecordedWrites({ allowHalfOpen: true });
    const closed = once(socket, "close");
    try {
      if (buffered) (socket as any)._emitData(Buffer.from("held"));
      (socket as any)._emitEnd();
      await new Promise<void>(resolve => process.nextTick(resolve));
      assert.strictEqual(socket.writableEnded, false);
      assert.strictEqual(socket.destroyed, false);
      const received: string[] = [];
      socket.on("data", chunk => received.push(String(chunk)));
      socket.resume();
      socket.end("late-reply");
      await closed;
      assert.deepStrictEqual(received, buffered ? ["held"] : []);
      assert.deepStrictEqual(writes, ["late-reply"]);
      assert.strictEqual(socket.destroyed, true);
    } finally {
      socket.destroy();
    }
  });
}

test("deferred EOF cleanup cannot end a reused socket", async () => {
  const { socket } = socketWithRecordedWrites();
  try {
    socket.pause();
    (socket as any)._emitData(Buffer.from("old"));
    (socket as any)._emitEnd();
    socket.destroy();
    (socket as any)._resetCompletedConnection();
    (socket as any)._emitData(Buffer.from("new"));
    await new Promise<void>(resolve => process.nextTick(resolve));
    assert.strictEqual(socket.destroyed, false);
    assert.strictEqual(socket.writableEnded, false);
    assert.strictEqual((socket as any)._readEndSignaled, false);
  } finally {
    socket.destroy();
  }
});

test("a prior connection's EOF finish listener cannot destroy a reused socket", async () => {
  const { socket } = socketWithRecordedWrites();
  try {
    socket.pause();
    (socket as any)._final = (_callback: () => void) => {};
    (socket as any)._emitData(Buffer.from("old"));
    (socket as any)._emitEnd();
    await new Promise<void>(resolve => process.nextTick(resolve));
    assert.strictEqual(socket.writableEnded, true);
    assert.strictEqual(socket.writableFinished, false);
    assert.strictEqual(socket.listenerCount("finish"), 1);
    socket.destroy();
    (socket as any)._resetCompletedConnection();
    (socket as any)._final = (callback: () => void) => callback();
    (socket as any)._emitData(Buffer.from("new"));
    const finished = once(socket, "finish");
    socket.end();
    await finished;
    assert.strictEqual(socket.writableFinished, true);
    assert.strictEqual(socket.destroyed, false);
    assert.strictEqual((socket as any)._readEndSignaled, false);
  } finally {
    socket.destroy();
  }
});

test("Socket write validation and prototype bytesWritten match Node", () => {
  assert.strictEqual((Socket.prototype as any).bytesWritten, undefined);
  const socket = new Socket();
  assert.throws(() => socket.write(null as never), {
    code: "ERR_STREAM_NULL_VALUES",
    message: "May not write null values to stream",
  });
  assert.throws(() => socket.write(true as never), {
    code: "ERR_INVALID_ARG_TYPE",
    message: 'The "chunk" argument must be of type string, Buffer, TypedArray, or DataView. Received type boolean (true)',
  });
  socket.destroy();
});

test("destroy before connect fails the active write with the socket error", async () => {
  const server = net.createServer();
  const port = await listen(server);
  const socket = new Socket();
  const closed = once(socket, "close");
  socket.connect(port, "127.0.0.1");
  assert.strictEqual(socket.connecting, true);
  const writeError = new Promise<(Error & { code?: string }) | undefined>(resolve => {
    socket.write("pending", error => resolve(error ?? undefined));
  });
  socket.destroy();

  assert.strictEqual((await writeError)?.code, "ERR_SOCKET_CLOSED_BEFORE_CONNECTION");
  await closed;
  await close(server);
});
