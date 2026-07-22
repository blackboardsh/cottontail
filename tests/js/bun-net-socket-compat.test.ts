import { expect, test } from "bun:test";
import { createSocketPair } from "bun:internal-for-testing";
import { closeSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const tlsFixtures = join(
  import.meta.dir,
  "fixtures",
);
const tls = {
  cert: await Bun.file(join(tlsFixtures, "bun-socket-cert.pem")).text(),
  key: await Bun.file(join(tlsFixtures, "bun-socket-cert.key")).text(),
};

function withTimeout<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("socket test timed out")), milliseconds);
      timer.unref?.();
    }),
  ]);
}

test("Bun.listen and Bun.connect exchange TCP data", async () => {
  const received = Promise.withResolvers<string>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data) {
        socket.end(`echo:${data}`);
      },
    },
  });

  try {
    const client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open(socket) {
          expect(socket.write(new Uint8Array([0x78, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x79]), 1, 5)).toBe(5);
        },
        data(socket, data) {
          received.resolve(data.toString());
          socket.end();
        },
        error(_socket, error) {
          received.reject(error);
        },
      },
    });
    expect(await withTimeout(received.promise)).toBe("echo:hello");
    client.end();
  } finally {
    server.stop(true);
  }
});

test("pending TCP connect progresses while JavaScript is synchronously blocked", async () => {
  const callback = Promise.withResolvers<string>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  let client: Bun.Socket | undefined;
  const timer = setTimeout(() => callback.reject(new Error("connect callback did not beat the expired timer")), 250);

  try {
    const connecting = Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open() {
          return new Error("connect callback completed");
        },
        error(_socket, error) {
          clearTimeout(timer);
          callback.resolve(error.message);
        },
        data() {},
      },
    });
    Bun.sleepSync(500);
    client = await connecting;
    expect(await callback.promise).toBe("connect callback completed");
  } finally {
    clearTimeout(timer);
    client?.end();
    server.stop(true);
  }
});

test("Bun.connect with an existing fd observes its asynchronous open event", async () => {
  const [socketFd, peerFd] = createSocketPair();
  const opened = Promise.withResolvers<Bun.Socket>();
  let socket: Bun.Socket | undefined;

  try {
    socket = await Bun.connect({
      fd: socketFd,
      socket: {
        open(connected) {
          opened.resolve(connected);
        },
        data() {},
      },
    });
    expect(await opened.promise).toBe(socket);
  } finally {
    socket?.terminate();
    closeSync(peerFd);
  }
});

test.skipIf(process.platform === "win32")("Bun.listen and Bun.connect exchange Unix socket data", async () => {
  const path = `/tmp/cottontail-bun-net-${process.pid}-${Date.now()}.sock`;
  const received = Promise.withResolvers<string>();
  const server = Bun.listen({
    unix: path,
    socket: {
      data(socket, data) {
        socket.end(`unix:${data}`);
      },
    },
  });

  try {
    const client = await Bun.connect({
      unix: path,
      socket: {
        open(socket) {
          socket.write("hello");
        },
        data(socket, data) {
          received.resolve(data.toString());
          socket.end();
        },
        error(_socket, error) {
          received.reject(error);
        },
      },
    });
    expect(await withTimeout(received.promise)).toBe("unix:hello");
    client.end();
  } finally {
    server.stop(true);
    try { unlinkSync(path); } catch {}
  }
});

test("Bun sockets validate handlers and binaryType", () => {
  expect(() => Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {} as any,
  })).toThrow('Expected at least "data" or "drain" callback');
  expect(() => Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data: 1 } as any,
  })).toThrow('Expected "onData" callback to be a function');
  expect(() => Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, binaryType: "nodebuffer" } as any,
  })).toThrow('SocketHandler.binaryType must be "arraybuffer", "buffer", or "uint8array"');
});

test("listener and socket reload replace handlers on an active connection", async () => {
  const completed = Promise.withResolvers<void>();
  const events: string[] = [];
  let serverSocketData: object | undefined;
  const initialData = { generation: 1 };
  const nextData = { generation: 2 };
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    data: initialData,
    socket: {
      data(socket, data) {
        serverSocketData = socket.data;
        events.push(`server-old:${Buffer.isBuffer(data)}:${data}`);
        expect(server.reload({
          socket: {
            binaryType: "uint8array",
            data(reloadedSocket, reloadedData) {
              events.push(`server-new:${reloadedData.constructor.name}:${Buffer.from(reloadedData).toString()}`);
              reloadedSocket.end("ack-two");
            },
          },
        })).toBeUndefined();
        server.data = nextData;
        socket.write("ack-one");
      },
    },
  });

  let client: Bun.Socket | undefined;
  try {
    client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        open(socket) {
          socket.write("one");
        },
        data(socket, data) {
          events.push(`client-old:${Buffer.isBuffer(data)}:${data}`);
          expect(socket.reload({
            socket: {
              binaryType: "arraybuffer",
              data(reloadedSocket, reloadedData) {
                events.push(`client-new:${reloadedData.constructor.name}:${Buffer.from(reloadedData).toString()}`);
                reloadedSocket.end();
                completed.resolve();
              },
            },
          })).toBeUndefined();
          socket.write("two");
        },
      },
    });
    await withTimeout(completed.promise);
    expect(events).toEqual([
      "server-old:true:one",
      "client-old:true:ack-one",
      "server-new:Uint8Array:two",
      "client-new:ArrayBuffer:ack-two",
    ]);
    expect(serverSocketData).toBe(initialData);
    expect(server.data).toBe(nextData);
  } finally {
    client?.terminate();
    server.stop(true);
  }
});

test("Bun socket lifecycle methods and timeout follow Bun contracts", async () => {
  const timedOut = Promise.withResolvers<number>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const started = Date.now();
  const client = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: {
      data() {},
      timeout(socket) {
        timedOut.resolve(Date.now() - started);
        socket.end();
      },
    },
  });

  try {
    expect(client.readyState).toBe(1);
    expect(client.write.length).toBe(3);
    expect(client.end.length).toBe(3);
    expect(client.shutdown.length).toBe(1);
    expect(client.timeout.length).toBe(1);
    expect(client.reload.length).toBe(1);
    expect(client.ref()).toBeUndefined();
    expect(client.unref()).toBeUndefined();
    expect(client.ref()).toBeUndefined();
    expect(client.pause()).toBeUndefined();
    expect(client.resume()).toBeUndefined();
    expect(client.timeout(1)).toBeUndefined();
    expect(await withTimeout(timedOut.promise, 3000)).toBeGreaterThanOrEqual(800);
  } finally {
    client.terminate();
    server.stop(true);
  }
});

test.skipIf(process.platform === "win32")("Bun socket drain waits for native writable readiness", async () => {
  const [socketFd, peerFd] = createSocketPair();
  const drained = Promise.withResolvers<void>();
  let peerReadStarted = false;
  let drainBeforeRead = false;
  let socket: Bun.Socket | undefined;

  try {
    socket = await Bun.connect({
      fd: socketFd,
      socket: {
        data() {},
        drain() {
          if (!peerReadStarted) drainBeforeRead = true;
          drained.resolve();
        },
      },
    });
    const payload = Buffer.alloc(1024 * 1024, 0x61);
    let written = payload.byteLength;
    for (let attempt = 0; attempt < 8 && written === payload.byteLength; attempt += 1) {
      written = socket.write(payload);
    }
    expect(written).toBeGreaterThanOrEqual(0);
    expect(written).toBeLessThan(payload.byteLength);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(drainBeforeRead).toBe(false);

    peerReadStarted = true;
    readSync(peerFd, Buffer.alloc(1024 * 1024), 0, 1024 * 1024, null);
    await withTimeout(drained.promise);
  } finally {
    socket?.terminate();
    closeSync(peerFd);
  }
});

test("allowHalfOpen sockets can reply after the peer ends its write side", async () => {
  const response = Promise.withResolvers<string>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    allowHalfOpen: true,
    socket: {
      data() {},
      end(socket) {
        socket.end("after-fin");
      },
    },
  });
  let client: Bun.Socket | undefined;

  try {
    client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      allowHalfOpen: true,
      socket: {
        open(socket) {
          socket.end("request");
        },
        data(_socket, data) {
          response.resolve(data.toString());
        },
      },
    });
    expect(await withTimeout(response.promise)).toBe("after-fin");
  } finally {
    client?.terminate();
    server.stop(true);
  }
});

test("TLS Bun.connect completes handshake before drain", async () => {
  const handshake = Promise.withResolvers<boolean>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch() {
      return new Response("ok");
    },
  });
  let handshakeComplete = false;
  let socket: Bun.Socket | undefined;

  try {
    socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      tls: { rejectUnauthorized: false },
      socket: {
        drain() {
          if (!handshakeComplete) handshake.reject(new Error("drain ran before handshake"));
        },
        handshake(secureSocket) {
          handshakeComplete = true;
          handshake.resolve(secureSocket.authorized);
        },
        error(_secureSocket, error) {
          handshake.reject(error);
        },
      },
    });
    expect(await withTimeout(handshake.promise)).toBe(true);
  } finally {
    socket?.end();
    await server.stop(true);
  }
});

test("Socket.upgradeTLS validates TLS material synchronously", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch() {
      return new Response("ok");
    },
  });
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: { data() {} },
  });

  try {
    expect(() => socket.upgradeTLS({
      tls: { ca: "invalid certificate!" },
      socket: { data() {} },
    })).toThrow(expect.objectContaining({ code: "ERR_BORINGSSL" }));
    expect(() => socket.upgradeTLS({ tls: {}, socket: { data() {} } })).toThrow();
  } finally {
    socket.end();
    await server.stop(true);
  }
});

test("Socket.upgradeTLS preserves raw bytes and exposes plaintext", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls,
    fetch() {
      return new Response("Hello World");
    },
  });
  const rawClosed = Promise.withResolvers<Uint8Array>();
  const tlsClosed = Promise.withResolvers<string>();
  let rawBytes = Buffer.alloc(0);
  let body = "";
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: server.port,
    socket: {
      data(_socket, data) {
        rawBytes = Buffer.concat([rawBytes, data]);
      },
      close() {
        rawClosed.resolve(rawBytes);
      },
      error(_socket, error) {
        rawClosed.reject(error);
      },
    },
  });

  try {
    const request = Buffer.from("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    const [rawSocket, tlsSocket] = socket.upgradeTLS({
      data: request,
      tls,
      socket: {
        handshake(secureSocket) {
          expect(secureSocket.authorized).toBe(true);
        },
        drain(secureSocket) {
          if (secureSocket.data.byteLength === 0) return;
          const written = secureSocket.write(secureSocket.data);
          secureSocket.data = secureSocket.data.subarray(written);
          secureSocket.flush();
        },
        data(secureSocket, data) {
          body += data.toString();
          if (body.includes("Hello World")) secureSocket.end();
        },
        close() {
          tlsClosed.resolve(body);
        },
        error(_secureSocket, error) {
          tlsClosed.reject(error);
        },
      },
    });

    expect(rawSocket).toBe(socket);
    expect(tlsSocket).toBeDefined();
    const [response, encrypted] = await withTimeout(Promise.all([tlsClosed.promise, rawClosed.promise]));
    expect(response).toContain("HTTP/1.1 200 OK");
    expect(response).toContain("Content-Length: 11");
    expect(response).toContain("Hello World");
    expect(encrypted.byteLength).toBeGreaterThan(0);
  } finally {
    socket.end();
    await server.stop(true);
  }
}, 15_000);

test("server-side Socket.upgradeTLS accepts a TLS client", async () => {
  const response = Promise.withResolvers<string>();
  let upgradedSocket: Bun.Socket | undefined;
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(rawSocket) {
        try {
          const [raw, secure] = rawSocket.upgradeTLS({
            tls,
            socket: {
              handshake(_socket, success, error) {
                if (!success) response.reject(error ?? new Error("server TLS handshake failed"));
              },
              data(socket, data) {
                if (data.toString() !== "ping") {
                  response.reject(new Error(`unexpected server payload: ${data}`));
                  return;
                }
                socket.end("pong");
              },
              error(_socket, error) {
                response.reject(error);
              },
            },
          });
          expect(raw).toBe(rawSocket);
          upgradedSocket = secure;
        } catch (error) {
          response.reject(error);
        }
      },
      data() {},
      error(_socket, error) {
        response.reject(error);
      },
    },
  });

  let client: Bun.Socket | undefined;
  try {
    client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      tls: { rejectUnauthorized: false },
      socket: {
        handshake(socket, success, error) {
          if (!success) {
            response.reject(error ?? new Error("client TLS handshake failed"));
            return;
          }
          socket.write("ping");
        },
        data(socket, data) {
          response.resolve(data.toString());
          socket.end();
        },
        error(_socket, error) {
          response.reject(error);
        },
      },
    });
    expect(await withTimeout(response.promise)).toBe("pong");
    expect(upgradedSocket?.listener).toBe(server);
  } finally {
    client?.terminate();
    upgradedSocket?.terminate();
    server.stop(true);
  }
});

test("encrypted Bun socket writes report native partial progress and drain the remainder", async () => {
  const payload = Buffer.alloc(16 * 1024 * 1024, 0x5a);
  const firstWrite = Promise.withResolvers<number>();
  const received = Promise.withResolvers<number>();
  let upgradedSocket: Bun.Socket | undefined;
  let writeStarted = false;
  let writeOffset = 0;
  let drainCalls = 0;
  let receivedBytes = 0;

  const fail = (error: unknown) => {
    firstWrite.reject(error);
    received.reject(error);
  };
  const writeRemaining = (socket: Bun.Socket) => {
    const written = socket.write(payload.subarray(writeOffset));
    if (written < 0) {
      fail(new Error("encrypted socket write failed"));
      return written;
    }
    writeOffset += written;
    if (writeOffset === payload.byteLength) socket.end();
    return written;
  };

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(rawSocket) {
        try {
          [, upgradedSocket] = rawSocket.upgradeTLS({
            tls,
            socket: {
              data(socket, data) {
                if (writeStarted) return;
                if (data.toString() !== "ready") {
                  fail(new Error(`unexpected readiness payload: ${data}`));
                  return;
                }
                writeStarted = true;
                firstWrite.resolve(writeRemaining(socket));
              },
              drain(socket) {
                if (!writeStarted || writeOffset === payload.byteLength) return;
                drainCalls += 1;
                while (writeOffset < payload.byteLength && writeRemaining(socket) > 0) {}
              },
              error(_socket, error) {
                fail(error);
              },
            },
          });
        } catch (error) {
          fail(error);
        }
      },
      data() {},
      error(_socket, error) {
        fail(error);
      },
    },
  });

  let client: Bun.Socket | undefined;
  try {
    client = await Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      tls: { rejectUnauthorized: false },
      socket: {
        handshake(socket, success, error) {
          if (!success) {
            fail(error ?? new Error("client TLS handshake failed"));
            return;
          }
          socket.pause();
          socket.write("ready");
        },
        data(_socket, data) {
          if (data.byteLength > 0 && (data[0] !== 0x5a || data[data.byteLength - 1] !== 0x5a)) {
            fail(new Error("encrypted payload was corrupted"));
            return;
          }
          receivedBytes += data.byteLength;
          if (receivedBytes > payload.byteLength) {
            fail(new Error("encrypted payload exceeded the accepted byte count"));
          } else if (receivedBytes === payload.byteLength) {
            received.resolve(receivedBytes);
          }
        },
        error(_socket, error) {
          fail(error);
        },
      },
    });

    const initial = await withTimeout(firstWrite.promise);
    expect(initial).toBeGreaterThanOrEqual(0);
    expect(initial).toBeLessThan(payload.byteLength);
    client.resume();
    expect(await withTimeout(received.promise, 15_000)).toBe(payload.byteLength);
    expect(writeOffset).toBe(payload.byteLength);
    expect(drainCalls).toBeGreaterThan(0);
  } finally {
    client?.terminate();
    upgradedSocket?.terminate();
    server.stop(true);
  }
}, 20_000);
