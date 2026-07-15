// Bun.SQL — dispatches between the sqlite-backed implementation (cottontail's
// historical default) and a minimal PostgreSQL wire-protocol client used when
// postgres connection options are given. The postgres client implements the
// v3 startup handshake, cleartext/md5 auth, simple-protocol queries with
// inline-escaped parameters, and robust ErrorResponse parsing.

import { Database as SQLiteDatabase } from "./sqlite.js";
import * as net from "../node/net.js";
import { createHash } from "../node/crypto.js";

function md5hex(...parts) {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function parsePostgresURL(url) {
  const out = {};
  try {
    const u = new URL(String(url));
    if (u.hostname) out.hostname = decodeURIComponent(u.hostname);
    if (u.port) out.port = Number(u.port);
    if (u.username) out.username = decodeURIComponent(u.username);
    if (u.password) out.password = decodeURIComponent(u.password);
    const db = u.pathname.replace(/^\//, "");
    if (db) out.database = decodeURIComponent(db);
  } catch {}
  return out;
}

function isPostgresURLString(value) {
  return typeof value === "string" && /^postgres(ql)?:\/\//i.test(value);
}

function looksLikePostgresOptions(options) {
  if (typeof options !== "object" || options === null) return false;
  const adapter = options.adapter;
  if (adapter === "postgres" || adapter === "postgresql") return true;
  if (adapter && adapter !== "postgres" && adapter !== "postgresql") return false;
  if (isPostgresURLString(options.url)) return true;
  return (
    "hostname" in options ||
    "host" in options ||
    "port" in options ||
    "username" in options ||
    "user" in options ||
    "connectionTimeout" in options ||
    "connection_timeout" in options
  );
}

function resolvePostgresOptions(input) {
  let options = {};
  if (isPostgresURLString(input)) {
    options = parsePostgresURL(input);
  } else if (typeof input === "object" && input !== null) {
    options = { ...input };
    if (isPostgresURLString(options.url)) {
      options = { ...parsePostgresURL(options.url), ...options };
    }
  }
  const envv = globalThis.process?.env ?? {};
  return {
    hostname: options.hostname ?? options.host ?? envv.PGHOST ?? "localhost",
    port: Number(options.port ?? envv.PGPORT ?? 5432),
    username: options.username ?? options.user ?? envv.PGUSER ?? envv.USER ?? "postgres",
    password: options.password ?? options.pass ?? envv.PGPASSWORD ?? "",
    database: options.database ?? options.db ?? envv.PGDATABASE ?? options.username ?? options.user ?? "postgres",
    path: options.path,
    max: Number(options.max ?? 10),
    idleTimeout: Number(options.idleTimeout ?? options.idle_timeout ?? 0),
    connectionTimeout: Number(options.connectionTimeout ?? options.connection_timeout ?? 30),
  };
}

function escapeValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : `'${value}'`;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (Array.isArray(value)) {
    return `ARRAY[${value.map(escapeValue).join(",")}]`;
  }
  const text = String(value).replace(/\0/g, "");
  if (/[\\]/.test(text)) {
    return `E'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

function buildStartupMessage(options) {
  const params = [
    "user", options.username,
    "database", options.database,
    "client_encoding", "UTF8",
  ];
  const body = Buffer.concat([
    ...params.map((p) => Buffer.concat([Buffer.from(String(p), "utf8"), Buffer.from([0])])),
    Buffer.from([0]),
  ]);
  const message = Buffer.alloc(8 + body.length);
  message.writeInt32BE(8 + body.length, 0);
  message.writeInt32BE(196608, 4); // protocol 3.0
  body.copy(message, 8);
  return message;
}

function typedMessage(type, body = Buffer.alloc(0)) {
  const message = Buffer.alloc(5 + body.length);
  message.write(type, 0, "latin1");
  message.writeInt32BE(4 + body.length, 1);
  body.copy(message, 5);
  return message;
}

function cstringBuffer(text) {
  return Buffer.concat([Buffer.from(String(text), "utf8"), Buffer.from([0])]);
}

// ErrorResponse / NoticeResponse body: repeated (type byte, cstring), 0
// terminator. Must tolerate empty and truncated bodies.
function parseErrorFields(body) {
  const fields = {};
  let offset = 0;
  while (offset < body.length) {
    const fieldType = body[offset];
    if (fieldType === 0) break;
    offset += 1;
    let end = body.indexOf(0, offset);
    if (end < 0) end = body.length;
    fields[String.fromCharCode(fieldType)] = body.toString("utf8", offset, end);
    offset = end + 1;
  }
  return fields;
}

class PostgresError extends Error {
  constructor(fields) {
    super(fields.M || "PostgreSQL error");
    this.name = "PostgresError";
    if (fields.C) this.code = fields.C;
    if (fields.S) this.severity = fields.S;
    if (fields.D) this.detail = fields.D;
    if (fields.H) this.hint = fields.H;
  }
}

function runPostgresQuery(options, statement, sockets) {
  return new Promise((resolve, reject) => {
    for (const [name, value] of [
      ["username", options.username],
      ["password", options.password],
      ["database", options.database],
    ]) {
      if (typeof value === "string" && value.includes("\0")) {
        reject(new Error(`PostgreSQL ${name} cannot contain null bytes`));
        return;
      }
    }

    // A unix socket path containing null bytes is invalid: drop it and fall
    // back to TCP rather than silently connecting to a truncated path.
    let path = options.path;
    if (typeof path === "string" && path.includes("\0")) path = undefined;

    let settled = false;
    let timer = null;
    const socket = path
      ? net.connect(path)
      : net.connect(options.port, options.hostname);
    sockets.add(socket);

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      sockets.delete(socket);
      try {
        socket.destroy();
      } catch {}
      if (error) reject(error);
      else resolve(result);
    };

    if (options.connectionTimeout > 0) {
      timer = setTimeout(() => {
        finish(new Error(`Connection timeout after ${options.connectionTimeout}s`));
      }, options.connectionTimeout * 1000);
      if (typeof timer?.unref === "function") timer.unref();
    }

    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error("Connection closed by server")));

    socket.on("connect", () => {
      try {
        socket.write(buildStartupMessage(options));
      } catch (error) {
        finish(error);
      }
    });

    let buffered = Buffer.alloc(0);
    let queryError = null;
    const rows = [];
    let columns = [];
    let command = "";
    let querySent = false;

    const handleMessage = (type, body) => {
      switch (type) {
        case "R": {
          const authType = body.length >= 4 ? body.readInt32BE(0) : 0;
          if (authType === 0) break; // AuthenticationOk
          if (authType === 3) {
            socket.write(typedMessage("p", cstringBuffer(options.password)));
          } else if (authType === 5) {
            const salt = body.subarray(4, 8);
            const inner = md5hex(options.password, options.username);
            const digest = `md5${md5hex(inner, salt)}`;
            socket.write(typedMessage("p", cstringBuffer(digest)));
          } else {
            finish(new Error(`Unsupported PostgreSQL authentication method: ${authType}`));
          }
          break;
        }
        case "E": {
          const error = new PostgresError(parseErrorFields(body));
          if (querySent) queryError = error;
          else finish(error);
          break;
        }
        case "Z": {
          if (!querySent) {
            querySent = true;
            socket.write(typedMessage("Q", cstringBuffer(statement)));
          } else if (queryError) {
            finish(queryError);
          } else {
            const result = rows;
            result.command = command;
            result.count = rows.length;
            finish(null, result);
          }
          break;
        }
        case "T": {
          columns = [];
          if (body.length >= 2) {
            const count = body.readInt16BE(0);
            let offset = 2;
            for (let i = 0; i < count && offset < body.length; i++) {
              let end = body.indexOf(0, offset);
              if (end < 0) end = body.length;
              columns.push(body.toString("utf8", offset, end));
              offset = end + 1 + 18; // skip fixed-size field metadata
            }
          }
          break;
        }
        case "D": {
          if (body.length < 2) break;
          const count = body.readInt16BE(0);
          let offset = 2;
          const row = {};
          for (let i = 0; i < count && offset + 4 <= body.length; i++) {
            const length = body.readInt32BE(offset);
            offset += 4;
            let value = null;
            if (length >= 0) {
              value = body.toString("utf8", offset, offset + length);
              offset += length;
            }
            row[columns[i] ?? String(i)] = value;
          }
          rows.push(row);
          break;
        }
        case "C": {
          command = body.toString("utf8", 0, Math.max(0, body.length - 1)).split(" ")[0];
          break;
        }
        default:
          break; // S (ParameterStatus), K (BackendKeyData), N (Notice), ...
      }
    };

    socket.on("data", (chunk) => {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      while (!settled && buffered.length >= 5) {
        const type = String.fromCharCode(buffered[0]);
        const length = buffered.readInt32BE(1);
        if (length < 4 || buffered.length < 1 + length) break;
        const body = buffered.subarray(5, 1 + length);
        buffered = buffered.subarray(1 + length);
        try {
          handleMessage(type, body);
        } catch (error) {
          finish(error);
          return;
        }
      }
    });
  });
}

function interpolateQuery(strings, values) {
  if (typeof strings === "string") return strings;
  let statement = "";
  for (let i = 0; i < strings.length; i++) {
    statement += strings[i];
    if (i < values.length) statement += escapeValue(values[i]);
  }
  return statement;
}

function createPostgresSQL(input) {
  const options = resolvePostgresOptions(input);
  const sockets = new Set();
  let closed = false;

  const sql = (strings, ...values) => {
    if (closed) return Promise.reject(new Error("Connection closed"));
    const statement = interpolateQuery(strings, values);
    return runPostgresQuery(options, statement, sockets);
  };

  sql.unsafe = (statement) => {
    if (closed) return Promise.reject(new Error("Connection closed"));
    return runPostgresQuery(options, String(statement), sockets);
  };
  sql.close = (_options) => {
    closed = true;
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {}
    }
    sockets.clear();
    return Promise.resolve();
  };
  sql.end = sql.close;
  sql.options = options;
  sql[Symbol.asyncDispose] = () => sql.close();
  return sql;
}

export function SQL(...args) {
  const [first] = args;
  if (isPostgresURLString(first) || looksLikePostgresOptions(first)) {
    return createPostgresSQL(first);
  }
  return Reflect.construct(SQLiteDatabase, args);
}
SQL.prototype = SQLiteDatabase.prototype;
