import assert from "node:assert/strict";
import { constants } from "node:crypto";
import { once } from "node:events";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import { test } from "bun:test";
import { cert, key } from "./fixtures/tls-cert.js";

const loopback = "127.0.0.1";
const sniCert = readFileSync("compat/upstream/bun/v1.3.10/test/js/third_party/grpc-js/fixtures/server1.pem", "utf8");
const sniKey = readFileSync("compat/upstream/bun/v1.3.10/test/js/third_party/grpc-js/fixtures/server1.key", "utf8");

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(promise: Promise<T>, label: string, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function listen(server: net.Server, options: net.ListenOptions, milliseconds = 5_000) {
  const listening = once(server, "listening");
  server.listen(options);
  await withTimeout(listening, "server listen", milliseconds);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address;
}

async function closeServer(server: net.Server) {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.close();
  await withTimeout(closed, "server close");
}

test("native connect binds localAddress and localPort asynchronously", async () => {
  let acceptedSocket: net.Socket | undefined;
  const target = net.createServer();
  const accepted = new Promise<net.Socket>((resolve) => {
    target.once("connection", (socket) => {
      acceptedSocket = socket;
      resolve(socket);
    });
  });
  const reservation = net.createServer();
  let client: net.Socket | undefined;

  try {
    const targetAddress = await listen(target, { host: loopback, port: 0, backlog: 7 });
    const reservationAddress = await listen(reservation, { host: loopback, port: 0 });
    const localPort = reservationAddress.port;
    await closeServer(reservation);

    client = net.connect({
      host: loopback,
      port: targetAddress.port,
      localAddress: loopback,
      localPort,
    });
    assert.equal(client.connecting, true);
    const connected = once(client, "connect");
    await withTimeout(connected, "bound client connect");
    const peer = await withTimeout(accepted, "bound server accept");

    assert.equal(client.localAddress, loopback);
    assert.equal(client.localPort, localPort);
    assert.equal(peer.remoteAddress, loopback);
    assert.equal(peer.remotePort, localPort);
  } finally {
    client?.destroy();
    acceptedSocket?.destroy();
    await closeServer(reservation);
    await closeServer(target);
  }
});

test("Happy Eyeballs falls through failed IPv6 to IPv4", async () => {
  const server = net.createServer((socket) => socket.end("fallback"));
  let client: net.Socket | undefined;
  try {
    const address = await listen(server, { host: loopback, port: 0 });
    const attempts: Array<[string, number, number]> = [];
    const failures: Array<[string, number, number, string | undefined]> = [];
    client = net.connect({
      host: "dual-stack.invalid",
      port: address.port,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 25,
      lookup(_hostname, options, callback) {
        assert.equal(options.all, true);
        queueMicrotask(() => callback(null, [
          { address: "::1", family: 6 },
          { address: loopback, family: 4 },
        ]));
      },
    });
    client.on("connectionAttempt", (host, port, family) => attempts.push([host, port, family]));
    client.on("connectionAttemptFailed", (host, port, family, error) => {
      failures.push([host, port, family, error?.code]);
    });

    const ended = once(client, "end");
    await withTimeout(once(client, "connect"), "Happy Eyeballs connect");
    await withTimeout(ended, "Happy Eyeballs response");

    assert.deepEqual(attempts.map(([host, , family]) => [host, family]), [["::1", 6], [loopback, 4]]);
    assert.equal(failures.length, 1);
    assert.deepEqual(failures[0].slice(0, 3), ["::1", address.port, 6]);
    assert.deepEqual(client.autoSelectFamilyAttemptedAddresses, [`::1:${address.port}`, `${loopback}:${address.port}`]);
  } finally {
    client?.destroy();
    await closeServer(server);
  }
});

test("AbortSignal preserves its reason and cancels native attempts", async () => {
  const controller = new AbortController();
  const reason = new DOMException("The operation timed out", "TimeoutError");
  controller.abort(reason);
  const socket = net.connect({ host: loopback, port: 9, signal: controller.signal });
  try {
    const [error] = await withTimeout(once(socket, "error"), "aborted socket error");
    assert.equal(error, reason);
    assert.equal(error.name, "TimeoutError");
  } finally {
    socket.destroy();
  }

  const operation = cottontail.tcpSocketConnectStart(9, "192.0.2.1", 4, undefined, 0, true);
  assert.ok(Number(operation?.id) > 0);
  assert.equal(cottontail.tcpSocketConnectCancel(operation.id), true);
  await delay(25);
  assert.equal(cottontail.tcpSocketConnectTake(operation.id), null);
});

test("pause and resume control the native fd watcher", async () => {
  let peer: net.Socket | undefined;
  const server = net.createServer();
  const accepted = new Promise<net.Socket>((resolve) => {
    server.once("connection", (socket) => {
      peer = socket;
      resolve(socket);
    });
  });
  let client: net.Socket | undefined;
  try {
    const address = await listen(server, { host: loopback, port: 0 });
    client = net.connect({ host: loopback, port: address.port });
    client.pause();
    const chunks: Buffer[] = [];
    client.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const connected = once(client, "connect");
    const received = once(client, "data");
    await withTimeout(connected, "paused client connect");
    const serverSocket = await withTimeout(accepted, "paused server accept");
    serverSocket.write("held-by-kernel");
    await delay(30);
    assert.equal(chunks.length, 0);

    client.resume();
    await withTimeout(received, "resumed client data");
    assert.equal(Buffer.concat(chunks).toString(), "held-by-kernel");
  } finally {
    client?.destroy();
    peer?.destroy();
    await closeServer(server);
  }
});

test("resetAndDestroy closes with a TCP RST", async () => {
  const server = net.createServer((socket) => socket.resetAndDestroy());
  let client: net.Socket | undefined;
  try {
    const address = await listen(server, { host: loopback, port: 0 });
    client = net.connect({ host: loopback, port: address.port });
    const reset = new Promise<Error>((resolve, reject) => {
      client!.once("error", resolve);
      client!.once("close", (hadError) => {
        if (!hadError) reject(new Error("peer closed without a TCP reset"));
      });
    });
    const error = await withTimeout(reset, "TCP reset");
    assert.equal((error as NodeJS.ErrnoException).code, "ECONNRESET");
  } finally {
    client?.destroy();
    await closeServer(server);
  }
});

test("Unix socket path remains application-owned after close", async () => {
  if (process.platform === "win32") return;
  const socketPath = join(tmpdir(), `ct-${process.pid}-${Date.now().toString(36)}.sock`);
  const server = net.createServer();
  try {
    const listening = once(server, "listening");
    server.listen(socketPath);
    await withTimeout(listening, "Unix socket listen");
    assert.equal(server.address(), socketPath);
    assert.equal(existsSync(socketPath), true);
    await closeServer(server);
    assert.equal(existsSync(socketPath), true);
    unlinkSync(socketPath);
    assert.equal(existsSync(socketPath), false);
  } finally {
    await closeServer(server);
    if (existsSync(socketPath)) unlinkSync(socketPath);
  }
});

test("listener ipv6Only and reusePort options reach native sockets", async () => {
  if (process.platform !== "win32") {
    const first = net.createServer();
    const second = net.createServer();
    try {
      const address = await listen(first, { host: loopback, port: 0, reusePort: true, backlog: 3 }, 2_500);
      await listen(second, { host: loopback, port: address.port, reusePort: true, backlog: 3 }, 2_500);
    } finally {
      await closeServer(second);
      await closeServer(first);
    }
  }

  const ipv6Server = net.createServer((socket) => socket.end());
  let ipv6Client: net.Socket | undefined;
  let ipv4Client: net.Socket | undefined;
  try {
    const listening = once(ipv6Server, "listening");
    const listenError = once(ipv6Server, "error");
    ipv6Server.listen({ host: "::", port: 0, ipv6Only: true, backlog: 3 });
    const outcome = await withTimeout(Promise.race([
      listening.then(() => "listening" as const),
      listenError.then(([error]) => ({ error })),
    ]), "IPv6-only listen", 2_500);
    if (outcome !== "listening") {
      const code = outcome.error?.code;
      assert.ok(code === "EAFNOSUPPORT" || code === "ENOTSUP" || /not supported/i.test(outcome.error?.message ?? ""));
      return;
    }
    const address = ipv6Server.address();
    assert.ok(address && typeof address === "object");

    ipv6Client = net.connect({ host: "::1", port: address.port, family: 6 });
    await withTimeout(once(ipv6Client, "connect"), "IPv6 loopback connect", 2_500);
    ipv6Client.destroy();

    ipv4Client = net.connect({ host: loopback, port: address.port, family: 4 });
    const [error] = await withTimeout(once(ipv4Client, "error"), "IPv4 rejection from IPv6-only listener", 2_500);
    assert.ok(["ECONNREFUSED", "EADDRNOTAVAIL", "ENETUNREACH"].includes(error.code));
  } finally {
    ipv6Client?.destroy();
    ipv4Client?.destroy();
    await closeServer(ipv6Server);
  }
});

test("native TCP and TLS ref state controls event-loop liveness", async () => {
  const fixture = join(import.meta.dir, "fixtures/native-transport-ref.js");
  for (const kind of ["net", "tls"] as const) {
    const server = kind === "tls"
      ? tls.createServer({ cert, key })
      : net.createServer();
    if (kind === "tls") server.on("tlsClientError", () => {});
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const peers: net.Socket[] = [];
    try {
      const address = await listen(server, { host: loopback, port: 0 });
      const peerEvent = kind === "tls" ? "secureConnection" : "connection";

      const unrefPeer = once(server, peerEvent);
      const unrefChild = Bun.spawn({
        cmd: [process.execPath, fixture, kind, "unref"],
        env: { ...process.env, COTTONTAIL_TRANSPORT_PORT: String(address.port) },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(unrefChild);
      const [unrefServerSocket] = await withTimeout(unrefPeer, `${kind} unref server accept`, 10_000);
      peers.push(unrefServerSocket);
      assert.equal(await withTimeout(unrefChild.exited, `${kind} unref child exit`, 10_000), 0);
      unrefServerSocket.destroy();

      const refPeer = once(server, peerEvent);
      const refChild = Bun.spawn({
        cmd: [process.execPath, fixture, kind, "ref"],
        env: { ...process.env, COTTONTAIL_TRANSPORT_PORT: String(address.port) },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(refChild);
      let refChildExited = false;
      const refChildExit = refChild.exited.then((code) => {
        refChildExited = true;
        return code;
      });
      const [refServerSocket] = await withTimeout(refPeer, `${kind} ref server accept`, 10_000);
      peers.push(refServerSocket);
      await delay(100);
      assert.equal(refChildExited, false, `${kind} socket exited while its native handle was referenced`);
      refServerSocket.end();
      assert.equal(await withTimeout(refChildExit, `${kind} ref child exit`, 10_000), 0);
    } finally {
      for (const child of children) {
        try { child.kill(); } catch {}
      }
      for (const peer of peers) peer.destroy();
      await closeServer(server);
    }
  }
});

test("OpenSSL protocol, metadata, OCSP, SNI, session, ref, and pause hooks are native", async () => {
  const server = tls.createServer({
    cert,
    key,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
  });
  server.addContext("alt.local", {
    cert: sniCert,
    key: sniKey,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
  });
  server.on("tlsClientError", () => {});
  let client: tls.TLSSocket | undefined;
  let resumedClient: tls.TLSSocket | undefined;
  let serverSocket: tls.TLSSocket | undefined;
  let resumedServerSocket: tls.TLSSocket | undefined;

  try {
    const address = await listen(server, { host: loopback, port: 0 });
    const accepted = once(server, "secureConnection");
    client = tls.connect({
      host: loopback,
      port: address.port,
      servername: "alt.local",
      rejectUnauthorized: false,
      requestOCSP: true,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.3",
      secureOptions: constants.SSL_OP_NO_TLSv1_3,
    });
    const ocspResponse = once(client, "OCSPResponse");
    await withTimeout(once(client, "secureConnect"), "TLS 1.2 secure connect");
    [serverSocket] = await withTimeout(accepted, "TLS 1.2 server accept");
    const [ocsp] = await withTimeout(ocspResponse, "OCSP response event");

    assert.equal(client.getProtocol(), "TLSv1.2");
    assert.equal(serverSocket.getProtocol(), "TLSv1.2");
    assert.equal(serverSocket.servername, "alt.local");
    assert.equal(client.getPeerCertificate().subject?.CN, "bun.test");
    assert.equal(ocsp, null);

    const clientFinished = client.getFinished();
    const peerFinished = client.getPeerFinished();
    assert.ok(Buffer.isBuffer(clientFinished) && clientFinished.length > 0);
    assert.ok(Buffer.isBuffer(peerFinished) && peerFinished.length > 0);
    assert.deepEqual(clientFinished, serverSocket.getPeerFinished());
    assert.deepEqual(peerFinished, serverSocket.getFinished());

    const ephemeral = client.getEphemeralKeyInfo();
    assert.equal(ephemeral.type, "ECDH");
    assert.ok(ephemeral.size > 0);
    const session = client.getSession();
    assert.ok(Buffer.isBuffer(session) && session.length > 0);
    const ticket = client.getTLSTicket();
    assert.ok(Buffer.isBuffer(ticket) && ticket.length > 0);

    client.pause();
    const chunks: Buffer[] = [];
    client.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const received = once(client, "data");
    serverSocket.write("tls-paused");
    await delay(30);
    assert.equal(chunks.length, 0);
    client.unref();
    client.ref();
    client.resume();
    await withTimeout(received, "resumed TLS data");
    assert.equal(Buffer.concat(chunks).toString(), "tls-paused");

    const firstEnded = once(client, "end");
    serverSocket.end();
    await withTimeout(firstEnded, "first TLS close");

    const resumedAccepted = once(server, "secureConnection");
    resumedClient = tls.connect({
      host: loopback,
      port: address.port,
      servername: "alt.local",
      rejectUnauthorized: false,
      minVersion: "TLSv1.2",
      maxVersion: "TLSv1.2",
    });
    resumedClient.setSession(session);
    await withTimeout(once(resumedClient, "secureConnect"), "TLS session-injected connect");
    [resumedServerSocket] = await withTimeout(resumedAccepted, "TLS session-injected server accept");
    assert.equal(resumedClient.getProtocol(), "TLSv1.2");
    assert.ok(Buffer.isBuffer(resumedClient.getSession()));
    const resumedEnded = once(resumedClient, "end");
    resumedServerSocket.end();
    await withTimeout(resumedEnded, "resumed TLS close");
  } finally {
    client?.destroy();
    resumedClient?.destroy();
    serverSocket?.destroy();
    resumedServerSocket?.destroy();
    await closeServer(server);
  }
});

test("incompatible native TLS protocol limits fail the handshake", async () => {
  const server = tls.createServer({ cert, key, minVersion: "TLSv1.2", maxVersion: "TLSv1.2" });
  server.on("tlsClientError", () => {});
  let client: tls.TLSSocket | undefined;
  try {
    const address = await listen(server, { host: loopback, port: 0 });
    client = tls.connect({
      host: loopback,
      port: address.port,
      servername: "localhost",
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
    });
    const [error] = await withTimeout(once(client, "error"), "TLS protocol mismatch");
    assert.match(error.message, /protocol|version|alert/i);
  } finally {
    client?.destroy();
    await closeServer(server);
  }
});
