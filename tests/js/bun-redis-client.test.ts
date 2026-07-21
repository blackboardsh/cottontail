import { RedisClient } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createServer, type Server, type Socket } from "node:net";

type MockState = {
  hashes: Map<string, Map<string, Buffer>>;
  selectedDatabases: number[];
  strings: Map<string, Buffer>;
};

function parseCommand(buffer: Buffer): { args: Buffer[]; next: number } | null {
  const lineEnd = buffer.indexOf("\r\n");
  if (lineEnd < 0) return null;
  const count = Number(buffer.toString("ascii", 1, lineEnd));
  if (buffer[0] !== 42 || !Number.isInteger(count) || count < 1) throw new Error("invalid mock request");
  let cursor = lineEnd + 2;
  const args: Buffer[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer[cursor] !== 36) throw new Error("invalid mock bulk request");
    const lengthEnd = buffer.indexOf("\r\n", cursor);
    if (lengthEnd < 0) return null;
    const length = Number(buffer.toString("ascii", cursor + 1, lengthEnd));
    const start = lengthEnd + 2;
    const end = start + length;
    if (end + 2 > buffer.length) return null;
    args.push(Buffer.from(buffer.subarray(start, end)));
    cursor = end + 2;
  }
  return { args, next: cursor };
}

function bulk(value: Buffer | string | null): Buffer {
  if (value == null) return Buffer.from("$-1\r\n");
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from(`$${bytes.length}\r\n`), bytes, Buffer.from("\r\n")]);
}

function mapReply(entries: Array<[string, Buffer | string]>): Buffer {
  const chunks = [Buffer.from(`%${entries.length}\r\n`)];
  for (const [key, value] of entries) chunks.push(bulk(key), bulk(value));
  return Buffer.concat(chunks);
}

function startMockRedis() {
  const state: MockState = {
    hashes: new Map(),
    selectedDatabases: [],
    strings: new Map(),
  };
  const sockets = new Set<Socket>();
  const subscribers = new Map<string, Set<Socket>>();
  const writers = new Map<Socket, (value: Buffer) => void>();
  let connectionCount = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    connectionCount += 1;
    let input = Buffer.alloc(0);
    let output = Promise.resolve();
    const reply = (value: Buffer) => {
      output = output.then(async () => {
        const split = Math.max(1, Math.floor(value.length / 2));
        socket.write(value.subarray(0, split));
        await new Promise((resolve) => setTimeout(resolve, 0));
        socket.write(value.subarray(split));
      });
    };
    writers.set(socket, reply);

    socket.on("data", (chunk) => {
      input = Buffer.concat([input, Buffer.from(chunk)]);
      while (input.length > 0) {
        const parsed = parseCommand(input);
        if (!parsed) break;
        input = Buffer.from(input.subarray(parsed.next));
        const [rawCommand, ...args] = parsed.args;
        const command = rawCommand.toString().toUpperCase();

        if (command === "HELLO") {
          expect(args.map((arg) => arg.toString())).toEqual(["3", "AUTH", "user", "secret"]);
          reply(mapReply([["server", "redis"], ["proto", "3"]]));
        } else if (command === "SELECT") {
          state.selectedDatabases.push(Number(args[0].toString()));
          reply(Buffer.from("+OK\r\n"));
        } else if (command === "SET") {
          const previous = state.strings.get(args[0].toString()) ?? null;
          state.strings.set(args[0].toString(), Buffer.from(args[1]));
          reply(args.some((arg) => arg.toString().toUpperCase() === "GET") ? bulk(previous) : Buffer.from("+OK\r\n"));
        } else if (command === "GET") {
          reply(bulk(state.strings.get(args[0].toString()) ?? null));
        } else if (command === "EXISTS") {
          reply(Buffer.from(`:${state.strings.has(args[0].toString()) ? 1 : 0}\r\n`));
        } else if (command === "INCR") {
          const key = args[0].toString();
          const value = Number(state.strings.get(key)?.toString() ?? "0") + 1;
          state.strings.set(key, Buffer.from(String(value)));
          reply(Buffer.from(`:${value}\r\n`));
        } else if (command === "HSET") {
          const key = args[0].toString();
          const hash = state.hashes.get(key) ?? new Map<string, Buffer>();
          state.hashes.set(key, hash);
          let added = 0;
          for (let index = 1; index < args.length; index += 2) {
            if (!hash.has(args[index].toString())) added += 1;
            hash.set(args[index].toString(), Buffer.from(args[index + 1]));
          }
          reply(Buffer.from(`:${added}\r\n`));
        } else if (command === "HGETALL") {
          const entries = [...(state.hashes.get(args[0].toString()) ?? new Map()).entries()];
          reply(mapReply(entries));
        } else if (command === "PING") {
          reply(args.length ? bulk(args[0]) : Buffer.from("+PONG\r\n"));
        } else if (command === "SUBSCRIBE") {
          for (const channelBytes of args) {
            const channel = channelBytes.toString();
            let channelSubscribers = subscribers.get(channel);
            if (!channelSubscribers) subscribers.set(channel, channelSubscribers = new Set());
            channelSubscribers.add(socket);
            reply(Buffer.concat([Buffer.from(">3\r\n+subscribe\r\n"), bulk(channel), Buffer.from(`:${channelSubscribers.size}\r\n`)]));
          }
        } else if (command === "UNSUBSCRIBE") {
          for (const channelBytes of args) {
            const channel = channelBytes.toString();
            subscribers.get(channel)?.delete(socket);
            reply(Buffer.concat([Buffer.from(">3\r\n+unsubscribe\r\n"), bulk(channel), Buffer.from(":0\r\n")]));
          }
        } else if (command === "PUBLISH") {
          const channel = args[0].toString();
          const recipients = subscribers.get(channel) ?? new Set();
          for (const recipient of recipients) {
            writers.get(recipient)?.(Buffer.concat([Buffer.from(">3\r\n+message\r\n"), bulk(channel), bulk(args[1])]));
          }
          reply(Buffer.from(`:${recipients.size}\r\n`));
        } else if (command === "FAIL") {
          reply(Buffer.from("-ERR deliberate failure\r\n"));
        } else {
          reply(Buffer.from(`-ERR unknown command '${command}'\r\n`));
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
      writers.delete(socket);
      for (const channelSubscribers of subscribers.values()) channelSubscribers.delete(socket);
    });
  });

  return {
    connectionCount: () => connectionCount,
    server,
    sockets,
    state,
  };
}

describe("Bun.RedisClient RESP conformance", () => {
  const mock = startMockRedis();
  let server: Server = mock.server;
  let port = 0;

  test("connects with auth and database selection and parses fragmented RESP3", async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
    const client = new RedisClient(`redis://user:secret@127.0.0.1:${port}/2`, { autoReconnect: false });
    let connected = 0;
    let closed = 0;
    client.onconnect = () => connected += 1;
    client.onclose = () => closed += 1;

    const hello = await client.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hello).toEqual({ server: "redis", proto: "3" });
    expect(client.connected).toBe(true);
    expect(connected).toBe(1);
    expect(mock.state.selectedDatabases).toEqual([2]);

    const results = await Promise.all([
      client.set("one", "1"),
      client.set("two", "2"),
      client.get("one"),
      client.incr("two"),
      client.exists("one"),
      client.exists("missing"),
    ]);
    expect(results).toEqual(["OK", "OK", "1", 3, true, false]);

    await client.set("binary", new Uint8Array([0, 1, 2, 255]));
    expect(await client.getBuffer("binary")).toEqual(Buffer.from([0, 1, 2, 255]));
    expect(await client.hset("person", { name: "Ada", role: "engineer" })).toBe(2);
    expect(await client.hgetall("person")).toEqual({ name: "Ada", role: "engineer" });
    expect(await client.ping()).toBe("PONG");
    expect(await client.ping("hello")).toBe("hello");
    await expect(client.send("FAIL", [])).rejects.toThrow("ERR deliberate failure");

    const duplicate = await client.duplicate();
    expect(duplicate.connected).toBe(true);
    expect(mock.connectionCount()).toBe(2);
    expect(await duplicate.get("one")).toBe("1");

    const subscriber = await client.duplicate();
    let subscribed: Promise<number>;
    const message = new Promise<[string, string]>((resolve) => {
      subscribed = subscriber.subscribe("events", (body, channel) => resolve([body, channel]));
    });
    expect(await subscribed!).toBe(1);
    expect(await duplicate.publish("events", "ready")).toBe(1);
    expect(await message).toEqual(["ready", "events"]);
    expect(await subscriber.unsubscribe("events")).toBe(0);
    subscriber.close();
    duplicate.close();

    process.env.REDIS_URL = `redis://user:secret@127.0.0.1:${port}/2`;
    expect(Bun.redis).toBeInstanceOf(RedisClient);
    expect(await Bun.redis.get("one")).toBe("1");
    Bun.redis.close();
    delete process.env.REDIS_URL;

    expect(client.ref()).toBe(client);
    expect(client.unref()).toBe(client);
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(client.connected).toBe(false);
    expect(closed).toBe(1);
    await expect(client.get("one")).rejects.toThrow("Connection has failed");
  });

  test("validates send arguments synchronously", () => {
    const client = new RedisClient(`redis://127.0.0.1:${port}`, { autoReconnect: false });
    expect(() => client.send("GET", "not-an-array" as never)).toThrow("Arguments must be an array");
    client.close();
  });

  test("honors offline queue and connection failure options", async () => {
    const noQueue = new RedisClient(`redis://user:secret@127.0.0.1:${port}/2`, {
      autoReconnect: false,
      enableOfflineQueue: false,
    });
    await expect(noQueue.get("one")).rejects.toThrow("offline queue is disabled");
    await noQueue.connect();
    expect(await noQueue.get("one")).toBe("1");
    noQueue.close();

    const unavailable = createServer();
    await new Promise<void>((resolve) => unavailable.listen(0, "127.0.0.1", resolve));
    const unavailablePort = (unavailable.address() as { port: number }).port;
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    const failed = new RedisClient(`redis://127.0.0.1:${unavailablePort}`, {
      autoReconnect: false,
      connectionTimeout: 500,
    });
    let closes = 0;
    failed.onclose = () => closes += 1;
    await expect(failed.get("key")).rejects.toThrow(/connection|connect|socket/i);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failed.connected).toBe(false);
    expect(closes).toBe(1);
    failed.close();
  });

  afterAll(async () => {
    for (const socket of mock.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
