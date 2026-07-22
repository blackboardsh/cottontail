import { expect, test } from "bun:test";
import { once } from "node:events";
import net from "node:net";

function listen(server: net.Server): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address() as net.AddressInfo));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("net.Socket supports asynchronous disposal", async () => {
  const accepted = Promise.withResolvers<net.Socket>();
  const server = net.createServer(socket => accepted.resolve(socket));
  const address = await listen(server);
  const client = net.connect(address.port, address.address);
  await once(client, "connect");
  const peer = await accepted.promise;

  expect(typeof client[Symbol.asyncDispose]).toBe("function");
  await client[Symbol.asyncDispose]();
  expect(client.destroyed).toBe(true);
  expect(client.closed).toBe(true);

  peer.destroy();
  await closeServer(server);
});

test("destroy closes an idle peer gracefully", async () => {
  const closed = Promise.withResolvers<boolean>();
  const server = net.createServer(socket => {
    socket.on("error", closed.reject);
    socket.on("close", hadError => closed.resolve(hadError));
    socket.write("data racing with destroy");
  });
  const address = await listen(server);
  const client = net.connect(address.port, address.address, () => client.destroy());
  client.on("error", closed.reject);

  expect(await closed.promise).toBe(false);
  await closeServer(server);
});

test("client connect callback precedes the matching server connection callback", async () => {
  const events: string[] = [];
  const server = net.createServer(socket => {
    events.push("server connection");
    socket.destroy();
  });
  const address = await listen(server);
  for (let index = 0; index < 16; index += 1) {
    const client = net.connect(address.port, address.address, () => {
      events.push("client connect");
    });
    await once(client, "close");
    expect(events.slice(-2)).toEqual(["client connect", "server connection"]);
  }
  await closeServer(server);
});

test("an already-aborted connect reports the signal reason before network errors", async () => {
  const signal = AbortSignal.timeout(1);
  await Bun.sleep(10);
  const socket = net.createConnection({ host: "127.0.0.1", port: 9, signal });
  const error = await new Promise<Error>(resolve => socket.once("error", resolve));

  expect(error.name).toBe("TimeoutError");
});

test("a live abort signal remains authoritative while connect failure is finalized", async () => {
  const signal = AbortSignal.timeout(20);
  const lookupError = Object.assign(new Error("getaddrinfo ENOTFOUND abort.invalid"), {
    code: "ENOTFOUND",
    errno: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "abort.invalid",
  });
  const socket = net.createConnection({
    host: "abort.invalid",
    port: 999,
    signal,
    lookup(_hostname, _options, callback) {
      callback(lookupError, undefined as never, undefined as never);
    },
  });
  const error = await new Promise<Error>(resolve => socket.once("error", resolve));

  expect(error.name).toBe("TimeoutError");
});

test("lookup validation, callback shape, and DNS errors match Node", async () => {
  for (const lookup of ["lookup", 1, {}, []]) {
    expect(() => net.connect({ host: "localhost", port: 0, lookup } as never)).toThrowWithCode(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
    );
  }

  const invalidFamily = net.connect({
    host: "lookup.invalid",
    port: 0,
    autoSelectFamily: false,
    lookup(_hostname, _options, callback) {
      callback(null, "127.0.0.1", 100 as never);
    },
  });
  const familyError = await new Promise<Error & { code?: string; host?: string; port?: number }>(resolve => {
    invalidFamily.once("error", resolve);
  });
  expect(familyError.code).toBe("ERR_INVALID_ADDRESS_FAMILY");
  expect(familyError.host).toBe("lookup.invalid");
  expect(familyError.port).toBe(0);

  const original = Object.assign(new Error("getaddrinfo ENOTFOUND lookup.invalid"), {
    code: "ENOTFOUND",
    errno: "ENOTFOUND",
    syscall: "getaddrinfo",
    hostname: "lookup.invalid",
  });
  const failed = net.connect({
    host: "lookup.invalid",
    port: 80,
    lookup(_hostname, _options, callback) {
      callback(original, undefined as never, undefined as never);
    },
  });
  const lookupError = await new Promise<Error & { errno?: string }>(resolve => failed.once("error", resolve));
  expect(lookupError).toBe(original);
  expect(lookupError.errno).toBe("ENOTFOUND");
});

test("native DNS lookup is asynchronous and observable", async () => {
  const server = net.createServer(socket => socket.end());
  const address = await listen(server);
  const lookups: Array<[Error | null, string, number, string]> = [];
  const client = net.connect(address.port, "localhost");
  client.on("lookup", (...args) => lookups.push(args as [Error | null, string, number, string]));
  await once(client, "close");

  expect(lookups.length).toBeGreaterThan(0);
  expect(lookups[0][0]).toBeNull();
  expect(lookups[0][3]).toBe("localhost");
  await closeServer(server);
});

test("socket inactivity timers are unrefed independently of the socket", () => {
  const socket = new net.Socket();
  expect(() => socket.setTimeout("100" as never)).toThrowWithCode(TypeError, "ERR_INVALID_ARG_TYPE");
  expect(() => socket.setTimeout(-1)).toThrowWithCode(RangeError, "ERR_OUT_OF_RANGE");
  socket.setTimeout(10_000);
  expect((socket as any)._timeoutTimer.hasRef()).toBe(false);
  socket.setTimeout(0);
  socket.destroy();
});

test("standalone servers drop at maxConnections even when dropMaxConnection is false", async () => {
  const server = net.createServer(() => {
    throw new Error("connection must be dropped");
  });
  server.maxConnections = 0;
  server.dropMaxConnection = false;
  const address = await listen(server);
  const dropped = once(server, "drop");
  const client = net.connect(address.port, address.address);
  const clientClosed = once(client, "close");
  client.on("error", () => {});

  const [details] = await dropped;
  expect(details.localPort).toBe(address.port);
  expect(details.remotePort).toBeNumber();
  await clientClosed;
  await closeServer(server);
});

test("coded BlockList validation errors include their code when stringified", () => {
  const blockList = new net.BlockList();
  try {
    blockList.addRange("10.0.0.2", "10.0.0.1");
    throw new Error("expected addRange to fail");
  } catch (error) {
    expect(String(error)).toContain("ERR_INVALID_ARG_VALUE");
  }
});

test("SocketAddress accessors stay read-only in callback code", () => {
  const address = new net.SocketAddress({ address: "127.0.0.1", port: 1234 });
  expect(Object.getOwnPropertyDescriptor(net.SocketAddress.prototype, "address")?.set).toBeUndefined();
  expect(() => {
    (address as net.SocketAddress & { address: string }).address = "1.2.3.4";
  }).toThrow(TypeError);
  expect(address.address).toBe("127.0.0.1");
});

test("SocketAddress rejects invalid family values consistently", () => {
  for (const family of [Symbol.for("ipv4"), function ipv4() {}, { family: "ipv4" }]) {
    expect(() => new net.SocketAddress({ family } as any)).toThrowWithCode(Error, "ERR_INVALID_ARG_VALUE");
  }
});

test("server address delegates listener handle errors", async () => {
  const server = net.createServer();
  await listen(server);
  const handle = (server as any)._handle;
  expect(handle.fd).toBeNumber();
  expect(handle.hasRef()).toBe(true);
  handle.getsockname = () => -1;
  expect(() => server.address()).toThrow("address EPERM");
  await closeServer(server);
});
