import { expect, test } from "bun:test";
import { once } from "node:events";
import dgram from "node:dgram";

function expectCode(callback: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }
  expect((thrown as Error & { code?: string })?.code).toBe(code);
}

async function bind(socket: dgram.Socket): Promise<dgram.AddressInfo> {
  socket.bind(0, "127.0.0.1");
  await once(socket, "listening");
  return socket.address();
}

async function close(socket: dgram.Socket): Promise<void> {
  if ((socket as unknown as { closed?: boolean }).closed) return;
  socket.close();
  await once(socket, "close");
}

function receive(socket: dgram.Socket): Promise<[Buffer, dgram.RemoteInfo]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for datagram")), 1000);
    socket.once("message", (message, rinfo) => {
      clearTimeout(timer);
      resolve([message, rinfo]);
    });
  });
}

function send(socket: dgram.Socket, ...args: unknown[]): Promise<number> {
  return new Promise((resolve, reject) => {
    (socket.send as (...values: unknown[]) => void)(...args, (error: Error | null, bytes: number) => {
      if (error) reject(error);
      else resolve(bytes);
    });
  });
}

test("dgram validates socket construction and public method arity", () => {
  expectCode(() => dgram.createSocket(undefined as never), "ERR_SOCKET_BAD_TYPE");
  expectCode(() => dgram.createSocket("UDP4" as never), "ERR_SOCKET_BAD_TYPE");
  expectCode(() => dgram.createSocket({ type: "udp4", lookup: 1 as never }), "ERR_INVALID_ARG_TYPE");
  const zeroBuffer = dgram.createSocket({ type: "udp4", recvBufferSize: 0, sendBufferSize: 0 });
  expect(zeroBuffer.close()).toBe(zeroBuffer);
  const ignoredListener = dgram.createSocket("udp4", 1 as never);
  expect(ignoredListener.close()).toBe(ignoredListener);
  expect(dgram.Socket.prototype.bind.length).toBe(2);
  expect(dgram.Socket.prototype.connect.length).toBe(3);
  expect(dgram.Socket.prototype.send.length).toBe(6);
  expect(dgram.Socket.prototype.close.length).toBe(1);
});

test("send implicitly binds and preserves offset/length overloads", async () => {
  const server = dgram.createSocket("udp4");
  const address = await bind(server);
  let lookup: { hostname: string; family: number } | undefined;
  const client = dgram.createSocket({
    type: "udp4",
    reuseAddr: true,
    lookup(hostname, options, callback) {
      lookup = { hostname, family: options.family };
      callback(null, address.address, 4);
    },
  });
  const events: string[] = [];
  client.on("listening", () => events.push("listening"));
  expectCode(() => client.address(), "ERR_SOCKET_DGRAM_NOT_RUNNING");

  const packet = receive(server);
  const bytes = await send(client, Buffer.from("012345"), 1, 3, address.port, "udp.test");
  events.push("sent");
  const [message, rinfo] = await packet;

  expect(bytes).toBe(3);
  expect(message.toString()).toBe("123");
  expect(rinfo.size).toBe(3);
  expect(client.address().port).toBeGreaterThan(0);
  expect(events).toEqual(["listening", "sent"]);
  expect(lookup).toEqual({ hostname: "udp.test", family: 4 });
  expect(server.setTTL(1.5)).toBe(1);
  expect(server.setMulticastTTL(2)).toBe(2);
  expect(server.setMulticastLoopback(true)).toBe(true);
  expect(server.setMulticastLoopback(16 as never)).toBe(16);
  expect(server.setMulticastLoopback(0 as never)).toBe(0);
  expect(server.setBroadcast(true)).toBeUndefined();
  expect(server.setRecvBufferSize(65536)).toBeUndefined();
  expect(server.setSendBufferSize(65536)).toBeUndefined();
  await close(client);
  await close(server);
});

test("connected sockets disconnect and can target a different peer", async () => {
  const first = dgram.createSocket("udp4");
  const second = dgram.createSocket("udp4");
  const client = dgram.createSocket("udp4");
  const firstAddress = await bind(first);
  const secondAddress = await bind(second);

  const connected = once(client, "connect");
  expect(client.connect(firstAddress.port, firstAddress.address)).toBeUndefined();
  await connected;
  expect(client.remoteAddress()).toEqual({ ...firstAddress });

  const firstPacket = receive(first);
  expect(await send(client, "first")).toBe(5);
  expect((await firstPacket)[0].toString()).toBe("first");

  expect(client.disconnect()).toBeUndefined();
  expectCode(() => client.remoteAddress(), "ERR_SOCKET_DGRAM_NOT_CONNECTED");
  const secondPacket = receive(second);
  expect(await send(client, "second", secondAddress.port, secondAddress.address)).toBe(6);
  expect((await secondPacket)[0].toString()).toBe("second");

  await close(client);
  await close(first);
  await close(second);
});

test("dgram ref state, async disposal, and abort close lifecycle", async () => {
  const socket = dgram.createSocket("udp4");
  await bind(socket);
  expect(socket.unref()).toBe(socket);
  expect(socket.ref()).toBe(socket);
  expect(typeof socket[Symbol.asyncDispose]).toBe("function");
  await socket[Symbol.asyncDispose]();
  expectCode(() => socket.close(), "ERR_SOCKET_DGRAM_NOT_RUNNING");

  const controller = new AbortController();
  const aborted = dgram.createSocket({ type: "udp4", signal: controller.signal });
  const error = once(aborted, "error");
  const closed = new Promise<void>(resolve => aborted.once("close", resolve));
  controller.abort();
  const [abortError] = await error;
  await closed;
  expect(abortError.name).toBe("AbortError");
  expect(abortError.code).toBe("ABORT_ERR");
});
