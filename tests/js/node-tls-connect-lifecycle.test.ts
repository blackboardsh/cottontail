import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import net from "node:net";
import { Duplex, PassThrough } from "node:stream";
import tls from "node:tls";
import { cert, key } from "./fixtures/tls-cert.js";

type NodeError = Error & { code?: string | number };

class StalledDuplex extends Duplex {
  _read() {}

  _write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    callback();
  }
}

async function runCase(name: string, body: () => Promise<void> | void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      body(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 3_000);
      }),
    ]);
    console.log(`ok - ${name}`);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

function listen(server: net.Server): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address() as net.AddressInfo);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}

await runCase("pre-handshake FIN reports ECONNRESET after transport events", async () => {
  const server = net.createServer(socket => socket.end());
  const address = await listen(server);
  const events: string[] = [];
  let connectionError: NodeError | undefined;
  let hadError = false;
  const socket = tls.connect({ host: address.address, port: address.port, rejectUnauthorized: false });
  socket.on("connect", () => events.push("connect"));
  socket.on("ready", () => events.push("ready"));
  socket.on("secure", () => events.push("secure"));
  socket.on("secureConnect", () => events.push("secureConnect"));
  socket.on("end", () => events.push("end"));
  socket.on("error", error => {
    connectionError = error;
    events.push("error");
  });
  await new Promise<void>(resolve => socket.once("close", value => {
    hadError = value;
    events.push("close");
    resolve();
  }));

  assert.equal(connectionError?.code, "ECONNRESET");
  assert.equal(hadError, true);
  assert.deepEqual(events.slice(0, 2), ["connect", "ready"]);
  assert.equal(events.includes("secure"), false);
  assert.equal(events.includes("secureConnect"), false);
  assert.deepEqual(events.slice(-2), ["error", "close"]);
  await closeServer(server);
});

await runCase("TLSSocket exposes the parent wrapper for stream consumers", () => {
  const transport = new PassThrough();
  const socket = new tls.TLSSocket(transport);
  assert.equal((socket as any)._handle, transport);
  assert.equal((transport as any)._parentWrap, socket);
  assert.equal(typeof (transport as any)._parentWrap.constructor, "function");
  socket.destroy();
  transport.destroy();
});

await runCase("an already-aborted connect does not open a transport", async () => {
  let accepted = 0;
  const server = net.createServer(socket => {
    accepted += 1;
    socket.destroy();
  });
  const address = await listen(server);
  const controller = new AbortController();
  controller.abort();
  const events: string[] = [];
  let connectionError: unknown;
  let hadError = false;
  const socket = tls.connect({
    host: address.address,
    port: address.port,
    rejectUnauthorized: false,
    signal: controller.signal,
  });
  socket.on("connect", () => events.push("connect"));
  socket.on("secureConnect", () => events.push("secureConnect"));
  socket.on("error", error => {
    connectionError = error;
    events.push("error");
  });
  await new Promise<void>(resolve => socket.once("close", value => {
    hadError = value;
    events.push("close");
    resolve();
  }));

  assert.equal(connectionError, controller.signal.reason);
  assert.equal((connectionError as Error).name, "AbortError");
  assert.equal(hadError, true);
  assert.deepEqual(events, ["error", "close"]);
  assert.equal(accepted, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await closeServer(server);
});

await runCase("aborting during the handshake closes once with the signal reason", async () => {
  const peers = new Set<net.Socket>();
  const server = net.createServer(socket => {
    peers.add(socket);
    socket.once("close", () => peers.delete(socket));
  });
  const address = await listen(server);
  const controller = new AbortController();
  const events: string[] = [];
  let connectionError: unknown;
  let hadError = false;
  const socket = tls.connect({
    host: address.address,
    port: address.port,
    rejectUnauthorized: false,
    signal: controller.signal,
  });
  socket.on("connect", () => {
    events.push("connect");
    controller.abort();
  });
  socket.on("ready", () => events.push("ready"));
  socket.on("secureConnect", () => events.push("secureConnect"));
  socket.on("error", error => {
    connectionError = error;
    events.push("error");
  });
  await new Promise<void>(resolve => socket.once("close", value => {
    hadError = value;
    events.push("close");
    resolve();
  }));

  assert.equal(connectionError, controller.signal.reason);
  assert.equal((connectionError as Error).name, "AbortError");
  assert.equal(hadError, true);
  assert.deepEqual(events, ["connect", "ready", "error", "close"]);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const peer of peers) peer.destroy();
  await closeServer(server);
});

await runCase("server handshakeTimeout uses the Node TLS error contract", async () => {
  const failure = Promise.withResolvers<{ error: NodeError; socket: tls.TLSSocket }>();
  const server = tls.createServer({ cert, key, handshakeTimeout: 40 });
  server.once("tlsClientError", (error, socket) => failure.resolve({ error, socket }));
  const address = await listen(server);
  const client = net.connect(address.port, address.address);
  client.on("error", () => {});
  const { error, socket } = await failure.promise;

  assert.equal(error.code, "ERR_TLS_HANDSHAKE_TIMEOUT");
  assert.equal(error.message, "TLS handshake timeout");
  client.destroy();
  socket.destroy();
  await closeServer(server);
});

await runCase("Duplex handshakeTimeout uses the same TLS error contract", async () => {
  const transport = new StalledDuplex();
  transport.on("error", () => {});
  const socket = tls.connect({
    socket: transport,
    rejectUnauthorized: false,
    handshakeTimeout: 40,
  });
  const error = await new Promise<NodeError>(resolve => socket.once("error", resolve));

  assert.equal(error.code, "ERR_TLS_HANDSHAKE_TIMEOUT");
  assert.equal(error.message, "TLS handshake timeout");
  assert.equal(socket.secureConnecting, false);
  transport.destroy();
});

await runCase("invalid ALPN callback results fail the handshake", async () => {
  const serverFailure = Promise.withResolvers<NodeError>();
  const server = tls.createServer({
    cert,
    key,
    ALPNCallback() {
      return "not-offered";
    },
  });
  server.once("tlsClientError", error => serverFailure.resolve(error));
  const address = await listen(server);
  let clientError: NodeError | undefined;
  const client = tls.connect({
    host: address.address,
    port: address.port,
    rejectUnauthorized: false,
    ALPNProtocols: ["h2"],
  });
  client.on("error", error => { clientError = error; });
  await new Promise<void>(resolve => client.once("close", () => resolve()));
  const error = await serverFailure.promise;

  assert.equal(error.code, "ERR_TLS_ALPN_CALLBACK_INVALID_RESULT");
  assert.ok(clientError instanceof Error);
  assert.equal(client.secureConnecting, false);
  await closeServer(server);
});
