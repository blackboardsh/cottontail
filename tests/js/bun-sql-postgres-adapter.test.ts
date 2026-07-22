import { postgres, SQL, sql as defaultSQL } from "bun";
import { expect, test } from "bun:test";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import net from "node:net";

type FrontendMessage = { type: string; body: Buffer };

function backendMessage(type: string, body = Buffer.alloc(0)): Buffer {
  const message = Buffer.alloc(5 + body.length);
  message.write(type, 0, "latin1");
  message.writeInt32BE(body.length + 4, 1);
  body.copy(message, 5);
  return message;
}

function cstring(value: string): Buffer {
  return Buffer.concat([Buffer.from(value), Buffer.from([0])]);
}

function authMessage(method: number, extra = Buffer.alloc(0)): Buffer {
  const body = Buffer.alloc(4 + extra.length);
  body.writeInt32BE(method, 0);
  extra.copy(body, 4);
  return backendMessage("R", body);
}

function ready(status = "I"): Buffer {
  return backendMessage("Z", Buffer.from(status));
}

function rowDescription(columns: Array<{ name: string; oid: number }>): Buffer {
  const count = Buffer.alloc(2);
  count.writeUInt16BE(columns.length);
  const fields = columns.map(column => {
    const metadata = Buffer.alloc(18);
    metadata.writeUInt32BE(0, 0);
    metadata.writeUInt16BE(0, 4);
    metadata.writeUInt32BE(column.oid, 6);
    metadata.writeInt16BE(-1, 10);
    metadata.writeInt32BE(-1, 12);
    metadata.writeUInt16BE(0, 16);
    return Buffer.concat([cstring(column.name), metadata]);
  });
  return backendMessage("T", Buffer.concat([count, ...fields]));
}

function dataRow(values: Array<string | Buffer | null>): Buffer {
  const count = Buffer.alloc(2);
  count.writeUInt16BE(values.length);
  const encoded = values.flatMap(value => {
    const length = Buffer.alloc(4);
    if (value === null) {
      length.writeInt32BE(-1);
      return [length];
    }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length.writeInt32BE(bytes.length);
    return [length, bytes];
  });
  return backendMessage("D", Buffer.concat([count, ...encoded]));
}

function commandComplete(tag: string): Buffer {
  return backendMessage("C", cstring(tag));
}

function errorResponse(fields: Record<string, string>): Buffer {
  const values = Object.entries(fields).map(([key, value]) =>
    Buffer.concat([Buffer.from(key), cstring(value)]),
  );
  return backendMessage("E", Buffer.concat([...values, Buffer.from([0])]));
}

function createSocketReader(socket: net.Socket) {
  let buffered = Buffer.alloc(0);
  let failure: Error | null = null;
  let wake: (() => void) | null = null;

  socket.on("data", chunk => {
    buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, Buffer.from(chunk)]);
    const callback = wake;
    wake = null;
    callback?.();
  });
  socket.on("error", error => {
    failure = error;
    const callback = wake;
    wake = null;
    callback?.();
  });
  socket.on("close", () => {
    failure ||= new Error("Socket closed");
    const callback = wake;
    wake = null;
    callback?.();
  });

  async function readExactly(length: number): Promise<Buffer> {
    while (buffered.length < length) {
      if (failure) throw failure;
      await new Promise<void>(resolve => {
        wake = resolve;
      });
    }
    const bytes = Buffer.from(buffered.subarray(0, length));
    buffered = buffered.subarray(length);
    return bytes;
  }

  return {
    async startup(): Promise<Buffer> {
      const header = await readExactly(4);
      const length = header.readInt32BE(0);
      if (length < 8) throw new Error(`Invalid startup message length: ${length}`);
      return await readExactly(length - 4);
    },
    async message(): Promise<FrontendMessage> {
      const type = (await readExactly(1)).toString("latin1");
      const length = (await readExactly(4)).readInt32BE(0);
      if (length < 4) throw new Error(`Invalid frontend message length: ${length}`);
      return { type, body: await readExactly(length - 4) };
    },
  };
}

function readCString(buffer: Buffer, state: { offset: number }): string {
  const end = buffer.indexOf(0, state.offset);
  if (end < 0) throw new Error("Missing cstring terminator");
  const value = buffer.toString("utf8", state.offset, end);
  state.offset = end + 1;
  return value;
}

function parseStartup(body: Buffer): Record<string, string> {
  expect(body.readInt32BE(0)).toBe(196608);
  const state = { offset: 4 };
  const parameters: Record<string, string> = {};
  while (state.offset < body.length && body[state.offset] !== 0) {
    const key = readCString(body, state);
    parameters[key] = readCString(body, state);
  }
  return parameters;
}

function parseQuery(body: Buffer): { statement: string; oids: number[] } {
  const state = { offset: 0 };
  readCString(body, state);
  const statement = readCString(body, state);
  const count = body.readUInt16BE(state.offset);
  state.offset += 2;
  const oids = [];
  for (let index = 0; index < count; index++) {
    oids.push(body.readUInt32BE(state.offset));
    state.offset += 4;
  }
  return { statement, oids };
}

function parseBind(body: Buffer): Array<string | null> {
  const state = { offset: 0 };
  readCString(body, state);
  readCString(body, state);
  const formatCount = body.readUInt16BE(state.offset);
  state.offset += 2 + formatCount * 2;
  const count = body.readUInt16BE(state.offset);
  state.offset += 2;
  const values = [];
  for (let index = 0; index < count; index++) {
    const length = body.readInt32BE(state.offset);
    state.offset += 4;
    if (length < 0) {
      values.push(null);
    } else {
      values.push(body.toString("utf8", state.offset, state.offset + length));
      state.offset += length;
    }
  }
  return values;
}

type RecordedQuery = {
  statement: string;
  oids: number[];
  values: Array<string | null>;
  simple: boolean;
};

type Fixture = {
  server: net.Server;
  address: net.AddressInfo;
  finished: Promise<void>;
  queries: RecordedQuery[];
  startup: Record<string, string>;
  get connectionCount(): number;
};

function resultForStatement(statement: string): {
  columns: Array<{ name: string; oid: number }>;
  values: Array<string | Buffer | null>;
  tag: string;
} | null {
  if (/answer/i.test(statement)) {
    return {
      columns: [
        { name: "answer", oid: 23 },
        { name: "ok", oid: 16 },
        { name: "payload", oid: 114 },
        { name: "large", oid: 20 },
      ],
      values: ["42", "t", '{"nested":true}', "9007199254740993"],
      tag: "SELECT 1",
    };
  }
  if (/items/i.test(statement)) {
    return {
      columns: [{ name: "items", oid: 1007 }],
      values: ["{1,2,3}"],
      tag: "SELECT 1",
    };
  }
  if (/mode/i.test(statement)) {
    return {
      columns: [{ name: "mode", oid: 23 }, { name: "label", oid: 25 }],
      values: ["7", "seven"],
      tag: "SELECT 1",
    };
  }
  if (/^\s*select/i.test(statement)) {
    const match = statement.match(/select\s+(\d+)/i);
    return {
      columns: [{ name: /\btx\b/i.test(statement) ? "tx" : "value", oid: 23 }],
      values: [match?.[1] ?? "1"],
      tag: "SELECT 1",
    };
  }
  return null;
}

async function sendQueryResult(socket: net.Socket, statement: string, transactionStatus: string): Promise<string> {
  if (/syntax_error/i.test(statement)) {
    socket.write(errorResponse({
      S: "ERROR",
      C: "42601",
      M: "syntax error at or near test",
      D: "fixture detail",
      H: "fixture hint",
    }));
    socket.write(ready(transactionStatus));
    return transactionStatus;
  }

  const result = resultForStatement(statement);
  if (result) {
    socket.write(rowDescription(result.columns));
    socket.write(dataRow(result.values));
    socket.write(commandComplete(result.tag));
  } else {
    socket.write(backendMessage("n"));
    let tag = statement.trim().replace(/\s+/g, " ").toUpperCase();
    if (tag.startsWith("BEGIN")) {
      tag = "BEGIN";
      transactionStatus = "T";
    } else if (tag.startsWith("COMMIT")) {
      tag = "COMMIT";
      transactionStatus = "I";
    } else if (tag === "ROLLBACK") {
      transactionStatus = "I";
    } else if (tag.startsWith("PREPARE TRANSACTION")) {
      transactionStatus = "I";
    }
    socket.write(commandComplete(tag));
  }
  socket.write(ready(transactionStatus));
  return transactionStatus;
}

async function listen(server: net.Server): Promise<net.AddressInfo> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address() as net.AddressInfo));
  });
}

async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
}

async function startPostgresFixture(
  authentication: "cleartext" | "scram",
  password: string,
): Promise<Fixture> {
  const queries: RecordedQuery[] = [];
  const startup: Record<string, string> = {};
  const completed = Promise.withResolvers<void>();
  let connectionCount = 0;

  const server = net.createServer(socket => {
    connectionCount++;
    const reader = createSocketReader(socket);
    socket.once("close", () => completed.resolve());
    void (async () => {
      Object.assign(startup, parseStartup(await reader.startup()));

      if (authentication === "cleartext") {
        socket.write(authMessage(3));
        const response = await reader.message();
        expect(response.type).toBe("p");
        expect(response.body.subarray(0, -1).toString()).toBe(password);
      } else {
        socket.write(authMessage(10, Buffer.concat([cstring("SCRAM-SHA-256"), Buffer.from([0])])));
        const initial = await reader.message();
        expect(initial.type).toBe("p");
        const initialState = { offset: 0 };
        expect(readCString(initial.body, initialState)).toBe("SCRAM-SHA-256");
        const initialLength = initial.body.readInt32BE(initialState.offset);
        initialState.offset += 4;
        const clientFirst = initial.body.toString("utf8", initialState.offset, initialState.offset + initialLength);
        expect(clientFirst.startsWith("n,,n=*,r=")).toBe(true);
        const clientFirstBare = clientFirst.slice(3);
        const nonce = clientFirstBare.slice(clientFirstBare.indexOf("r=") + 2);
        const salt = Buffer.from("cottontail-salt");
        const iterations = 4096;
        const serverFirst = `r=${nonce}server,s=${salt.toString("base64")},i=${iterations}`;
        socket.write(authMessage(11, Buffer.from(serverFirst)));

        const final = await reader.message();
        expect(final.type).toBe("p");
        const clientFinal = final.body.toString();
        const proofIndex = clientFinal.lastIndexOf(",p=");
        const finalWithoutProof = clientFinal.slice(0, proofIndex);
        const proof = Buffer.from(clientFinal.slice(proofIndex + 3), "base64");
        const auth = `${clientFirstBare},${serverFirst},${finalWithoutProof}`;
        const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
        const clientKey = createHmac("sha256", salted).update("Client Key").digest();
        const storedKey = createHash("sha256").update(clientKey).digest();
        const clientSignature = createHmac("sha256", storedKey).update(auth).digest();
        const expectedProof = Buffer.from(clientKey.map((byte, index) => byte ^ clientSignature[index]));
        expect(proof).toEqual(expectedProof);
        const serverKey = createHmac("sha256", salted).update("Server Key").digest();
        const signature = createHmac("sha256", serverKey).update(auth).digest("base64");
        socket.write(authMessage(12, Buffer.from(`v=${signature}`)));
      }

      socket.write(authMessage(0));
      socket.write(backendMessage("S", Buffer.concat([cstring("server_version"), cstring("16.2")])));
      const keyData = Buffer.alloc(8);
      keyData.writeUInt32BE(123, 0);
      keyData.writeUInt32BE(456, 4);
      socket.write(backendMessage("K", keyData));
      socket.write(ready());

      let pending: { statement: string; oids: number[]; values: Array<string | null> } | null = null;
      let transactionStatus = "I";
      for (;;) {
        const message = await reader.message();
        if (message.type === "X") {
          socket.end();
          completed.resolve();
          return;
        }
        if (message.type === "Q") {
          const statement = message.body.subarray(0, -1).toString();
          queries.push({ statement, oids: [], values: [], simple: true });
          if (statement.includes(";")) {
            for (const value of ["1", "2"]) {
              socket.write(rowDescription([{ name: "x", oid: 23 }]));
              socket.write(dataRow([value]));
              socket.write(commandComplete("SELECT 1"));
            }
            socket.write(ready(transactionStatus));
          } else {
            transactionStatus = await sendQueryResult(socket, statement, transactionStatus);
          }
          continue;
        }
        if (message.type === "P") {
          const parsed = parseQuery(message.body);
          pending = { ...parsed, values: [] };
          continue;
        }
        if (message.type === "B") {
          if (!pending) throw new Error("Bind received without Parse");
          pending.values = parseBind(message.body);
          continue;
        }
        if (message.type !== "S") continue;
        if (!pending) throw new Error("Sync received without Parse");
        queries.push({ ...pending, simple: false });
        socket.write(backendMessage("1"));
        socket.write(backendMessage("2"));
        transactionStatus = await sendQueryResult(socket, pending.statement, transactionStatus);
        pending = null;
      }
    })().catch(completed.reject);
  });

  const address = await listen(server);
  return {
    server,
    address,
    finished: completed.promise,
    queries,
    startup,
    get connectionCount() {
      return connectionCount;
    },
  };
}

test("PostgreSQL construction is lazy and direct calls are identifier fragments", async () => {
  expect(defaultSQL).toBe(Bun.sql);
  expect(postgres).toBe(defaultSQL);
  expect(Bun.postgres).toBe(defaultSQL);
  expect(typeof defaultSQL.connect).toBe("function");
  expect(typeof defaultSQL.unsafe).toBe("function");
  const sql = new SQL({
    adapter: "postgres",
    hostname: "127.0.0.1",
    port: 5432,
    username: "testuser",
    database: "testdb",
  });
  expect(sql.options).toMatchObject({
    adapter: "postgres",
    hostname: "127.0.0.1",
    port: 5432,
    username: "testuser",
    database: "testdb",
  });

  const fragment = sql("users");
  expect(() => fragment.catch(() => {})).toThrow("tagged template literal");
  try {
    await fragment;
    expect.unreachable();
  } catch (error: any) {
    expect(error).toBeInstanceOf(SQL.SQLError);
    expect(error).toBeInstanceOf(SQL.PostgresError);
    expect(error.code).toBe("ERR_POSTGRES_NOT_TAGGED_CALL");
  }
  await sql.close();
});

test("PostgreSQL adapter pools, binds, decodes, and manages transactions", async () => {
  const password = "testpass";
  const fixture = await startPostgresFixture("cleartext", password);
  let passwordCalls = 0;
  const connects: Array<unknown> = [];
  const closes: Array<unknown> = [];
  const sql = new SQL({
    adapter: "postgres",
    hostname: fixture.address.address,
    port: fixture.address.port,
    username: "testuser",
    password: async () => {
      passwordCalls++;
      return password;
    },
    database: "testdb",
    max: 1,
    bigint: false,
    connection: { application_name: "cottontail-test" },
    onconnect: error => connects.push(error),
    onclose: error => closes.push(error),
  });

  try {
    expect(fixture.connectionCount).toBe(0);
    await sql.connect();
    expect(fixture.connectionCount).toBe(1);
    expect(passwordCalls).toBe(1);
    expect(connects).toEqual([null]);
    expect(fixture.startup).toMatchObject({
      user: "testuser",
      database: "testdb",
      client_encoding: "UTF8",
      application_name: "cottontail-test",
    });

    const beforeLazy = fixture.queries.length;
    const lazy = sql`SELECT ${42}::int4 AS answer, ${true}::bool AS ok,
      ${{ nested: true }}::json AS payload, ${9007199254740993n}::int8 AS large`;
    expect(fixture.queries.length).toBe(beforeLazy);
    const result = await lazy;
    expect(result).toEqual([{
      answer: 42,
      ok: true,
      payload: { nested: true },
      large: "9007199254740993",
    }]);
    expect(result.command).toBe("SELECT");
    expect(result.count).toBe(1);
    expect(result.constructor[Symbol.toStringTag]).toBe("SQLResults");

    const bound = fixture.queries.at(-1)!;
    expect(bound.oids).toEqual([23, 16, 0, 20]);
    expect(bound.values).toEqual(["42", "t", '{"nested":true}', "9007199254740993"]);
    expect(bound.statement).toContain("$1 ::int4");
    expect(bound.statement).toContain("$4 ::int8");

    const [{ items }] = await sql`SELECT ${sql.array([1, 2, 3], "INT")} AS items`;
    expect(items).toEqual(new Int32Array([1, 2, 3]));
    expect(fixture.queries.at(-1)!.statement).toContain("$1::INT[]");

    await sql`UPDATE users SET ${sql({ roles: sql.array([4, 5], "INT") })}`;
    expect(fixture.queries.at(-1)!.values).toEqual(["{4,5}"]);

    expect(await sql`SELECT 7 AS mode`.values()).toEqual([[7, "seven"]]);
    const raw = await sql`SELECT 7 AS mode`.raw();
    expect(raw[0][0]).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(raw[0][0]).toString()).toBe("7");

    const multiple = await sql`SELECT 1 AS x; SELECT 2 AS x`.simple();
    expect(multiple.length).toBe(2);
    expect(multiple[0][0].x).toBe(1);
    expect(multiple[1][0].x).toBe(2);

    const marker = new Error("rollback savepoint");
    const transactionValue = await sql.begin("ISOLATION LEVEL SERIALIZABLE", async tx => {
      expect(() => tx.begin(() => {})).toThrow("savepoint");
      try {
        await tx.savepoint("named", async savepoint => {
          await savepoint`SELECT 9 AS tx`;
          throw marker;
        });
        expect.unreachable();
      } catch (error) {
        expect(error).toBe(marker);
      }
      expect((await tx`SELECT 1 AS tx WHERE ${tx`1 = ${1}`}`)[0].tx).toBe(1);
      return (await tx`SELECT 2 AS tx`)[0].tx;
    });
    expect(transactionValue).toBe(2);

    expect(await sql.beginDistributed("fixture_dist", async tx => {
      try {
        await tx.savepoint(async () => {});
        expect.unreachable();
      } catch (error: any) {
        expect(error.code).toBe("ERR_POSTGRES_INVALID_TRANSACTION_STATE");
      }
      return 8;
    })).toBe(8);
    await sql.commitDistributed("fixture_dist");

    const statements = fixture.queries.map(query => query.statement);
    expect(statements.some(statement => statement === "BEGIN ISOLATION LEVEL SERIALIZABLE")).toBe(true);
    expect(statements.some(statement => statement.startsWith('SAVEPOINT "s0_named"'))).toBe(true);
    expect(statements.some(statement => statement.startsWith('ROLLBACK TO SAVEPOINT "s0_named"'))).toBe(true);
    expect(statements.some(statement => statement === "COMMIT")).toBe(true);
    expect(statements.some(statement => statement === "PREPARE TRANSACTION 'fixture_dist'")).toBe(true);
    expect(statements.some(statement => statement === "COMMIT PREPARED 'fixture_dist'")).toBe(true);

    const reserved = await sql.reserve();
    expect((await reserved`SELECT 3 AS tx`)[0].tx).toBe(3);
    await reserved.release();
    expect((await sql`SELECT 4 AS tx`)[0].tx).toBe(4);
    expect(fixture.connectionCount).toBe(1);

    try {
      await sql`SELECT syntax_error`;
      expect.unreachable();
    } catch (error: any) {
      expect(error).toBeInstanceOf(SQL.SQLError);
      expect(error).toBeInstanceOf(SQL.PostgresError);
      expect(error.code).toBe("ERR_POSTGRES_SYNTAX_ERROR");
      expect(error.errno).toBe("42601");
      expect(error.detail).toBe("fixture detail");
      expect(error.hint).toBe("fixture hint");
    }
    expect((await sql`SELECT 5 AS tx`)[0].tx).toBe(5);
  } finally {
    await sql.close({ timeout: 0 });
    await fixture.finished;
    await closeServer(fixture.server);
  }
  expect(closes).toEqual([null]);
}, 15_000);

test("PostgreSQL adapter authenticates with SCRAM-SHA-256", async () => {
  const password = "scram-secret";
  const fixture = await startPostgresFixture("scram", password);
  let passwordCalls = 0;
  const idleClose = Promise.withResolvers<Error>();
  const sql = new SQL({
    adapter: "postgres",
    hostname: fixture.address.address,
    port: fixture.address.port,
    username: "scram_user",
    password: () => {
      passwordCalls++;
      return Promise.resolve(password);
    },
    database: "scram_db",
    max: 1,
    idle_timeout: 0.1,
    onclose: error => idleClose.resolve(error),
  });
  try {
    expect((await sql`SELECT 6 AS tx`)[0].tx).toBe(6);
    expect(passwordCalls).toBe(1);
    expect(fixture.connectionCount).toBe(1);
    const error: any = await idleClose.promise;
    expect(error).toBeInstanceOf(SQL.SQLError);
    expect(error).toBeInstanceOf(SQL.PostgresError);
    expect(error.code).toBe("ERR_POSTGRES_IDLE_TIMEOUT");
  } finally {
    await sql.close({ timeout: 0 });
    await fixture.finished;
    await closeServer(fixture.server);
  }
}, 15_000);
