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
  const client = net.connect(address.port, address.address, () => {
    events.push("client connect");
  });

  await once(client, "close");
  expect(events).toEqual(["client connect", "server connection"]);
  await closeServer(server);
});

test("an already-aborted connect reports the signal reason before network errors", async () => {
  const signal = AbortSignal.timeout(1);
  await Bun.sleep(10);
  const socket = net.createConnection({ host: "127.0.0.1", port: 9, signal });
  const error = await new Promise<Error>(resolve => socket.once("error", resolve));

  expect(error.name).toBe("TimeoutError");
});

test("SocketAddress accessors stay read-only in callback code", () => {
  const address = new net.SocketAddress({ address: "127.0.0.1", port: 1234 });
  expect(Object.getOwnPropertyDescriptor(net.SocketAddress.prototype, "address")?.set).toBeUndefined();
  expect(() => {
    (address as net.SocketAddress & { address: string }).address = "1.2.3.4";
  }).toThrow(TypeError);
  expect(address.address).toBe("127.0.0.1");
});
