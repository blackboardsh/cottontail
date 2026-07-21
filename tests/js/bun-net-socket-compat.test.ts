import { expect, test } from "bun:test";
import { createSocketPair } from "bun:internal-for-testing";
import { closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const tlsFixtures = join(
  import.meta.dir,
  "../../compat/upstream/bun/v1.3.10/test/js/bun/http/fixtures",
);
const tls = {
  cert: await Bun.file(join(tlsFixtures, "cert.pem")).text(),
  key: await Bun.file(join(tlsFixtures, "cert.key")).text(),
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
