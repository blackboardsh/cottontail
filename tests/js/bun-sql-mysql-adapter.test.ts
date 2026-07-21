import { SQL } from "bun";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import net from "node:net";

const CAP_CONNECT_WITH_DB = 1 << 3;
const CAP_PROTOCOL_41 = 1 << 9;
const CAP_TRANSACTIONS = 1 << 13;
const CAP_SECURE_CONNECTION = 1 << 15;
const CAP_MULTI_STATEMENTS = 1 << 16;
const CAP_MULTI_RESULTS = 1 << 17;
const CAP_PLUGIN_AUTH = 1 << 19;
const CAP_DEPRECATE_EOF = 1 << 24;

function packet(payload: Buffer, sequence: number): Buffer {
  const header = Buffer.alloc(4);
  header[0] = payload.length & 0xff;
  header[1] = (payload.length >>> 8) & 0xff;
  header[2] = (payload.length >>> 16) & 0xff;
  header[3] = sequence;
  return Buffer.concat([header, payload]);
}

function lengthEncoded(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length >= 0xfb) throw new Error("test fixture only supports short values");
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
}

function columnDefinition(name: string, type: number): Buffer {
  const fixed = Buffer.alloc(13);
  fixed[0] = 0x0c;
  fixed.writeUInt16LE(45, 1);
  fixed.writeUInt32LE(11, 3);
  fixed[7] = type;
  return Buffer.concat([
    lengthEncoded("def"),
    lengthEncoded("testdb"),
    lengthEncoded(""),
    lengthEncoded(""),
    lengthEncoded(name),
    lengthEncoded(name),
    fixed,
  ]);
}

function nativePassword(password: string, nonce: Buffer): Buffer {
  const first = createHash("sha1").update(password).digest();
  const second = createHash("sha1").update(first).digest();
  const challenge = createHash("sha1").update(nonce).update(second).digest();
  return Buffer.from(first.map((byte, index) => byte ^ challenge[index]));
}

function cachingSHA2Password(password: string, nonce: Buffer): Buffer {
  const first = createHash("sha256").update(password).digest();
  const second = createHash("sha256").update(first).digest();
  const challenge = createHash("sha256").update(second).update(nonce).digest();
  return Buffer.from(first.map((byte, index) => byte ^ challenge[index]));
}

function packetReader(socket: net.Socket): () => Promise<{ payload: Buffer; sequence: number }> {
  let buffered = Buffer.alloc(0);
  const packets: Array<{ payload: Buffer; sequence: number }> = [];
  const waiters: Array<{
    resolve: (packet: { payload: Buffer; sequence: number }) => void;
    reject: (error: Error) => void;
  }> = [];

  const drain = () => {
    while (buffered.length >= 4) {
      const length = buffered[0] | (buffered[1] << 8) | (buffered[2] << 16);
      if (buffered.length < length + 4) return;
      const value = { sequence: buffered[3], payload: Buffer.from(buffered.subarray(4, length + 4)) };
      buffered = buffered.subarray(length + 4);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(value);
      else packets.push(value);
    }
  };
  socket.on("data", chunk => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    drain();
  });
  socket.on("error", error => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  });

  return () => {
    const value = packets.shift();
    if (value) return Promise.resolve(value);
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
}

function listen(server: net.Server): Promise<net.AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address() as net.AddressInfo));
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

test("MySQL and MariaDB construction is lazy and normalizes adapter options", async () => {
  const mysql = new SQL("mysql://user:pass@127.0.0.1/example");
  const mariadb = new SQL("http://wrong.invalid/wrong", {
    adapter: "mariadb",
    url: "mariadb://maria:secret@db.internal/production",
  });

  expect(mysql.options).toMatchObject({
    adapter: "mysql",
    hostname: "127.0.0.1",
    port: 3306,
    username: "user",
    password: "pass",
    database: "example",
  });
  expect(mariadb.options).toMatchObject({
    adapter: "mariadb",
    hostname: "db.internal",
    port: 3306,
    username: "maria",
    password: "secret",
    database: "production",
  });

  await mysql.close();
  await mariadb.close();
});

test("MySQL adapter authenticates and executes a text-protocol query", async () => {
  const seed = Buffer.from("12345678abcdefghijkl");
  const capabilities =
    CAP_CONNECT_WITH_DB |
    CAP_PROTOCOL_41 |
    CAP_TRANSACTIONS |
    CAP_SECURE_CONNECTION |
    CAP_MULTI_STATEMENTS |
    CAP_MULTI_RESULTS |
    CAP_PLUGIN_AUTH |
    CAP_DEPRECATE_EOF;
  const serverFinished = Promise.withResolvers<void>();
  let acceptedConnections = 0;

  const server = net.createServer(socket => {
    acceptedConnections++;
    const read = packetReader(socket);
    void (async () => {
      const lower = Buffer.alloc(2);
      lower.writeUInt16LE(capabilities & 0xffff);
      const upper = Buffer.alloc(2);
      upper.writeUInt16LE(capabilities >>> 16);
      const status = Buffer.alloc(2);
      status.writeUInt16LE(2);
      const handshake = Buffer.concat([
        Buffer.from([10]),
        Buffer.from("8.4.0-cottontail\0"),
        Buffer.from([1, 0, 0, 0]),
        seed.subarray(0, 8),
        Buffer.from([0]),
        lower,
        Buffer.from([45]),
        status,
        upper,
        Buffer.from([21]),
        Buffer.alloc(10),
        seed.subarray(8),
        Buffer.from([0]),
        Buffer.from("caching_sha2_password\0"),
      ]);
      socket.write(packet(handshake, 0));

      const auth = await read();
      expect(auth.sequence).toBe(1);
      const clientCapabilities = auth.payload.readUInt32LE(0);
      expect(clientCapabilities & CAP_PROTOCOL_41).toBe(CAP_PROTOCOL_41);
      let offset = 32;
      const usernameEnd = auth.payload.indexOf(0, offset);
      expect(auth.payload.toString("utf8", offset, usernameEnd)).toBe("testuser");
      offset = usernameEnd + 1;
      const authLength = auth.payload[offset++];
      expect(auth.payload.subarray(offset, offset + authLength)).toEqual(cachingSHA2Password("testpass", seed));
      offset += authLength;
      const databaseEnd = auth.payload.indexOf(0, offset);
      expect(auth.payload.toString("utf8", offset, databaseEnd)).toBe("testdb");

      socket.write(packet(Buffer.concat([
        Buffer.from([0xfe]),
        Buffer.from("mysql_native_password\0"),
        seed,
        Buffer.from([0]),
      ]), 2));
      const switchedAuth = await read();
      expect(switchedAuth.sequence).toBe(3);
      expect(switchedAuth.payload).toEqual(nativePassword("testpass", seed));
      socket.write(packet(Buffer.from([0, 0, 0, 2, 0, 0, 0]), 4));
      const query = await read();
      expect(query.sequence).toBe(0);
      expect(query.payload[0]).toBe(0x03);
      expect(query.payload.toString("utf8", 1)).toBe("SELECT 42 AS answer");

      socket.write(packet(Buffer.from([1]), 1));
      socket.write(packet(columnDefinition("answer", 0x03), 2));
      socket.write(packet(lengthEncoded("42"), 3));
      socket.write(packet(Buffer.from([0xfe, 0, 0, 2, 0, 0, 0]), 4));

      const quit = await read();
      expect(quit.payload).toEqual(Buffer.from([0x01]));
      socket.end();
      serverFinished.resolve();
    })().catch(serverFinished.reject);
  });
  const address = await listen(server);

  const sql = new SQL({
    adapter: "mysql",
    hostname: address.address,
    port: address.port,
    username: "testuser",
    password: "testpass",
    database: "testdb",
  });
  try {
    expect(acceptedConnections).toBe(0);
    const result = await sql`SELECT ${42} AS answer`;
    expect(result).toEqual([{ answer: 42 }]);
    expect(result.count).toBe(1);
    expect(result.command).toBe("SELECT");
  } finally {
    await sql.close();
    await serverFinished.promise;
    await closeServer(server);
  }
}, 10_000);
