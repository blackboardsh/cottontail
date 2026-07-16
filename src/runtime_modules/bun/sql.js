// Bun.SQL — dispatches between the sqlite-backed implementation (cottontail's
// historical default) and a minimal PostgreSQL wire-protocol client used when
// postgres connection options are given. The postgres client implements the
// v3 startup handshake, cleartext/md5 auth, simple-protocol queries with
// inline-escaped parameters, and robust ErrorResponse parsing.

import { Database as SQLiteDatabase, SQLiteError } from "./sqlite.js";
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
    adapter: options.adapter ?? "postgres",
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

class SQLResultArray extends Array {
  constructor(values = []) {
    super();
    this.push(...values);
    Object.defineProperties(this, {
      count: { value: null, writable: true },
      command: { value: null, writable: true },
      lastInsertRowid: { value: null, writable: true },
      affectedRows: { value: null, writable: true },
    });
  }

  static get [Symbol.species]() {
    return Array;
  }
}

class SQLHelper {
  constructor(value, keys = undefined) {
    if (keys !== undefined && keys.length === 0 && value?.[0] != null && typeof value[0] === "object") {
      keys = Object.keys(value[0]);
    }

    if (keys !== undefined) {
      for (let key of keys) {
        if (typeof key === "string") {
          const asNumber = Number(key);
          if (Number.isNaN(asNumber)) continue;
          key = asNumber;
        }

        if (typeof key !== "string") {
          if (Number.isSafeInteger(key) && key >= 0 && key <= 64 * 1024) continue;
          throw new Error("Keys must be strings or numbers: " + String(key));
        }
      }
    }

    this.value = value;
    this.columns = keys ?? [];
  }
}

const SQLITE_MEMORY_VARIANTS = new Set([":memory:", "sqlite://:memory:", "sqlite:memory"]);
const SQLITE_PROTOCOLS = [
  ["sqlite://", 9],
  ["sqlite:", 7],
  ["file://", -1],
  ["file:", 5],
];
const SUPPORTED_ADAPTERS = ["postgres", "sqlite", "mysql", "mariadb"];

function parseDefinitelySQLiteURL(value) {
  if (value == null) return null;
  const string = value instanceof URL ? value.toString() : String(value);
  if (SQLITE_MEMORY_VARIANTS.has(string)) return ":memory:";

  for (const [prefix, stripLength] of SQLITE_PROTOCOLS) {
    if (!string.startsWith(prefix)) continue;
    if (stripLength === -1) {
      try {
        return globalThis.Bun.fileURLToPath(string);
      } catch {
        return string.slice(7);
      }
    }
    return string.slice(stripLength);
  }
  return null;
}

function parseSQLiteOptions(filenameOrURL, options) {
  const result = {
    ...options,
    adapter: "sqlite",
    filename: ":memory:",
  };

  let filename = filenameOrURL || ":memory:";
  let originalURL = filename;
  if (filename instanceof URL) {
    originalURL = filename.toString();
    filename = originalURL;
  }

  let queryString = null;
  if (typeof originalURL === "string") {
    const queryIndex = originalURL.indexOf("?");
    if (queryIndex !== -1) {
      queryString = originalURL.slice(queryIndex + 1);
      filename = String(filename).slice(0, queryIndex);
    }
  }

  const parsedFilename = parseDefinitelySQLiteURL(filename);
  if (parsedFilename !== null) filename = parsedFilename;
  result.filename = filename || ":memory:";

  if (queryString) {
    const mode = new URLSearchParams(queryString).get("mode");
    if (mode === "ro") {
      result.readonly = true;
    } else if (mode === "rw") {
      result.readonly = false;
    } else if (mode === "rwc") {
      result.readonly = false;
      result.create = true;
    }
  }

  if ("readonly" in options) result.readonly = options.readonly;
  if ("create" in options) result.create = options.create;
  if ("safeIntegers" in options) result.safeIntegers = options.safeIntegers;
  if ("strict" in options) result.strict = options.strict;
  return result;
}

function environmentConnectionURL(adapter) {
  const env = globalThis.Bun?.env ?? globalThis.process?.env ?? {};
  let url = env.DATABASE_URL || env.DATABASEURL || env.TLS_DATABASE_URL || null;
  if (url) return url;

  if (!adapter || adapter === "postgres") {
    url = env.POSTGRES_URL || env.PGURL || env.PG_URL || env.TLS_POSTGRES_DATABASE_URL || null;
    if (url) return url;
  }
  if (!adapter || adapter === "mysql") {
    url = env.MYSQL_URL || env.MYSQLURL || env.TLS_MYSQL_DATABASE_URL || null;
    if (url) return url;
  }
  if (!adapter || adapter === "mariadb") {
    url = env.MARIADB_URL || env.MARIADBURL || env.TLS_MARIADB_DATABASE_URL || null;
    if (url) return url;
  }
  if (!adapter || adapter === "sqlite") {
    url = env.SQLITE_URL || env.SQLITEURL || null;
    if (url) return url;
  }
  return null;
}

function inferAdapter(value) {
  if (parseDefinitelySQLiteURL(value) !== null) return "sqlite";
  if (value instanceof URL) {
    const protocol = value.protocol.replace(/:$/, "").toLowerCase();
    if (protocol === "mysql" || protocol === "mysql2") return "mysql";
    if (protocol === "mariadb") return "mariadb";
    return "postgres";
  }
  const string = value == null ? "" : String(value);
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(string);
  if (!match) return "postgres";
  const protocol = match[1].toLowerCase();
  if (protocol === "sqlite" || protocol === "file") return "sqlite";
  if (protocol === "mysql" || protocol === "mysql2") return "mysql";
  if (protocol === "mariadb") return "mariadb";
  return "postgres";
}

function resolveSQLConfiguration(first, second = {}) {
  let options;
  let resolvedURL;
  if (typeof first === "string" || first instanceof URL) {
    options = { ...second };
    resolvedURL = first;
  } else {
    options = {
      ...(first && typeof first === "object" ? first : {}),
      ...(second && typeof second === "object" ? second : {}),
    };
    resolvedURL = environmentConnectionURL(options.adapter);
  }

  if (options.adapter != null && !SUPPORTED_ADAPTERS.includes(options.adapter)) {
    throw new Error(
      "Unsupported adapter: " +
        options.adapter +
        '. Supported adapters: "postgres", "sqlite", "mysql", "mariadb"',
    );
  }

  if (options.adapter === "sqlite") {
    if ("filename" in options && options.filename) resolvedURL = options.filename;
  } else if (options.adapter) {
    if ("url" in options && options.url) resolvedURL = options.url;
  } else if ("filename" in options && options.filename) {
    resolvedURL = options.filename;
  } else if ("url" in options && options.url) {
    resolvedURL = options.url;
  }

  const adapter = options.adapter ?? inferAdapter(resolvedURL);
  if (adapter === "sqlite") {
    return {
      adapter,
      options: parseSQLiteOptions(resolvedURL, { ...options, adapter }),
      url: resolvedURL,
    };
  }

  return {
    adapter,
    options: { ...options, adapter, url: resolvedURL },
    url: resolvedURL,
  };
}

function tokenizeSQL(source) {
  const tokens = [];
  let token = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  const flush = () => {
    if (token) {
      tokens.push(token.toUpperCase());
      token = "";
    }
  };

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (source[index + 1] === quote) {
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      flush();
      lineComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      flush();
      blockComment = true;
      index++;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      flush();
      quote = character;
      continue;
    }
    if (/[A-Za-z_]/.test(character)) {
      token += character;
    } else {
      flush();
    }
  }
  flush();
  return tokens;
}

function parseSQLQuery(source) {
  const tokens = tokenizeSQL(String(source));
  let helperCommand = "none";
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index];
    if (token === "IN") {
      helperCommand = "in";
      break;
    }
    if (token === "SET") {
      helperCommand = "updateSet";
      break;
    }
    if (token === "WHERE") {
      helperCommand = "where";
      break;
    }
    if (token === "UPDATE") {
      helperCommand = "update";
      break;
    }
    if (token === "INSERT") {
      helperCommand = "insert";
      break;
    }
  }

  const canReturnRows = tokens.some((token) =>
    token === "SELECT" || token === "PRAGMA" || token === "WITH" || token === "EXPLAIN" || token === "RETURNING"
  );
  const commands = ["INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "PRAGMA", "SELECT", "WITH", "EXPLAIN", "VACUUM", "ANALYZE", "ATTACH", "DETACH", "REPLACE"];
  const command = tokens.find((token) => commands.includes(token)) ?? tokens[0] ?? "";
  return { helperCommand, canReturnRows, command };
}

function helperCommandName(command) {
  if (command === "insert") return "INSERT";
  if (command === "update" || command === "updateSet") return "UPDATE";
  if (command === "in") return "IN";
  if (command === "where") return "WHERE";
  return "";
}

function escapeSQLiteIdentifier(value) {
  return '"' + String(value).replaceAll('"', '""').replaceAll(".", '"."') + '"';
}

function definedColumnsAndSQL(columns, items) {
  const definedColumns = [];
  let sql = "(";
  for (const column of columns) {
    const hasDefinedValue = Array.isArray(items)
      ? items.some((item) => item != null && typeof item[column] !== "undefined")
      : items != null && typeof items[column] !== "undefined";
    if (!hasDefinedValue) continue;
    if (definedColumns.length > 0) sql += ", ";
    sql += escapeSQLiteIdentifier(column);
    definedColumns.push(column);
  }
  return { definedColumns, sql: sql + ") VALUES" };
}

function validateSQLiteBinding(value) {
  if (value == null) return;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "bigint" || type === "boolean") return;
  if (ArrayBuffer.isView(value)) return;
  throw new TypeError("Binding expected string, TypedArray, boolean, number, bigint or null");
}

function normalizeSQLiteQuery(strings, values) {
  if (typeof strings === "string") return [strings, values ?? []];
  if (!Array.isArray(strings)) {
    throw new SyntaxError("Invalid query: SQL Fragment cannot be executed or was misused");
  }

  let query = "";
  const bindings = [];
  for (let index = 0; index < strings.length; index++) {
    const string = strings[index];
    if (typeof string !== "string") {
      throw new SyntaxError("Invalid query: SQL Fragment cannot be executed or was misused");
    }
    query += string;
    if (index >= values.length) continue;

    const value = values[index];
    if (value instanceof SQLiteQuery) {
      const [fragment, fragmentBindings] = normalizeSQLiteQuery(value._strings, value._values);
      query += fragment;
      bindings.push(...fragmentBindings);
      continue;
    }

    if (!(value instanceof SQLHelper)) {
      query += "? ";
      bindings.push(typeof value === "undefined" ? null : value);
      continue;
    }

    const command = parseSQLQuery(query).helperCommand;
    if (command === "none" || command === "where") {
      throw new SyntaxError("Helpers are only allowed for INSERT, UPDATE and WHERE IN commands");
    }

    const items = value.value;
    const columns = value.columns;
    if (columns.length === 0 && command !== "in") {
      throw new SyntaxError("Cannot " + helperCommandName(command) + " with no columns");
    }

    if (command === "insert") {
      const built = definedColumnsAndSQL(columns, items);
      if (built.definedColumns.length === 0) {
        throw new SyntaxError("Insert needs to have at least one column with a defined value");
      }
      query += built.sql;
      const rows = Array.isArray(items) ? items : [items];
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        const row = rows[rowIndex];
        query += "(";
        for (let columnIndex = 0; columnIndex < built.definedColumns.length; columnIndex++) {
          const column = built.definedColumns[columnIndex];
          if (columnIndex > 0) query += ", ";
          query += "?";
          bindings.push(typeof row[column] === "undefined" ? null : row[column]);
        }
        query += rowIndex + 1 < rows.length ? ")," : ") ";
      }
      continue;
    }

    if (command === "in") {
      const rows = Array.isArray(items) ? items : [items];
      if (columns.length > 1) throw new SyntaxError("Cannot use WHERE IN helper with multiple columns");
      query += "(";
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
        if (rowIndex > 0) query += ", ";
        query += "?";
        const row = rows[rowIndex];
        const binding = columns.length === 0 ? row : row?.[columns[0]];
        bindings.push(typeof binding === "undefined" ? null : binding);
      }
      query += ") ";
      continue;
    }

    const rows = Array.isArray(items) ? items : [items];
    if (rows.length > 1) throw new SyntaxError("Cannot use array of objects for UPDATE");
    if (command === "update") query += " SET ";
    let added = 0;
    for (const column of columns) {
      const columnValue = rows[0]?.[column];
      if (typeof columnValue === "undefined") continue;
      if (added > 0) query += ", ";
      query += escapeSQLiteIdentifier(column) + " = ?";
      bindings.push(columnValue);
      added++;
    }
    if (added === 0) throw new SyntaxError("Update needs to have at least one column");
    query += " ";
  }

  for (const binding of bindings) validateSQLiteBinding(binding);
  return [query, bindings];
}

function rawSQLiteValue(value) {
  if (value === null) return null;
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (typeof value === "bigint") {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    return bytes;
  }
  if (typeof value === "number") {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    if (Number.isInteger(value)) view.setBigInt64(0, BigInt(value), true);
    else view.setFloat64(0, value, true);
    return bytes;
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return new TextEncoder().encode(String(value));
}

function executeSQLiteQuery(client, queryObject) {
  if (client.closed) throw new SQLiteError("Connection closed");
  if (client.storedError) throw client.storedError;
  if (!client.db) throw new SQLiteError("SQLite database not initialized");

  const [statementSQL, bindings] = normalizeSQLiteQuery(queryObject._strings, queryObject._values);
  const parsed = parseSQLQuery(statementSQL);
  if (parsed.canReturnRows) {
    const statement = client.db.prepare(statementSQL);
    try {
      let rows;
      if (queryObject._mode === "values" || queryObject._mode === "raw") {
        rows = statement.values(...bindings);
        if (queryObject._mode === "raw") rows = rows.map((row) => row.map(rawSQLiteValue));
      } else {
        rows = statement.all(...bindings);
      }
      const result = new SQLResultArray(rows);
      result.command = parsed.command;
      result.count = rows.length;
      return result;
    } finally {
      statement.finalize();
    }
  }

  const changes = client.db.run(statementSQL, ...bindings);
  const result = new SQLResultArray();
  result.command = parsed.command;
  result.count = changes.changes;
  result.affectedRows = changes.changes;
  result.lastInsertRowid = changes.lastInsertRowid;
  return result;
}

class SQLiteQuery extends Promise {
  constructor(client, strings, values, notTagged = false) {
    let resolvePromise;
    let rejectPromise;
    super((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this._client = client;
    this._strings = strings;
    this._values = values;
    this._notTagged = notTagged;
    this._resolvePromise = resolvePromise;
    this._rejectPromise = rejectPromise;
    this._mode = "objects";
    this._started = false;
    this._cancelled = false;
    this.active = false;
  }

  static get [Symbol.species]() {
    return Promise;
  }

  _start() {
    if (this._started || this._cancelled) return;
    this._started = true;
    if (this._notTagged) {
      this._rejectPromise(new SQLiteError("Query not called as a tagged template literal"));
      return;
    }
    this.active = true;
    try {
      this._resolvePromise(executeSQLiteQuery(this._client, this));
    } catch (error) {
      this._rejectPromise(error);
    } finally {
      this.active = false;
    }
  }

  execute() {
    this._start();
    return this;
  }

  async run() {
    this._start();
    return await this;
  }

  values() {
    if (!this._started) this._mode = "values";
    return this;
  }

  raw() {
    if (!this._started) this._mode = "raw";
    return this;
  }

  simple() {
    return this;
  }

  cancel() {
    if (this._started || this._cancelled) return this;
    this._cancelled = true;
    this._rejectPromise(new SQLiteError("Query cancelled"));
    return this;
  }

  then(...arguments_) {
    this._start();
    return super.then(...arguments_);
  }

  catch(...arguments_) {
    this._start();
    return super.catch(...arguments_);
  }

  finally(...arguments_) {
    this._start();
    return super.finally(...arguments_);
  }
}

function sqliteTransactionCommand(options) {
  if (!options) return "BEGIN";
  const mode = String(options).toUpperCase();
  if (mode === "READONLY" || mode === "READ") {
    throw new Error(
      "SQLite doesn't support '" +
        options +
        "' transaction mode. Use DEFERRED, IMMEDIATE, or EXCLUSIVE.",
    );
  }
  return "BEGIN " + mode;
}

function runSQLiteControl(client, statement) {
  if (client.closed) throw new SQLiteError("Connection closed");
  if (client.storedError) throw client.storedError;
  return client.db.run(statement);
}

async function beginSQLiteTransaction(client, optionsOrCallback, maybeCallback) {
  let options = optionsOrCallback;
  let callback = maybeCallback;
  if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
    options = undefined;
  }
  if (typeof callback !== "function") throw new TypeError("fn must be a function");

  const begin = sqliteTransactionCommand(options);
  runSQLiteControl(client, begin);
  let needsRollback = true;
  const transactionSQL = createSQLiteSQLFunction(client, true);
  try {
    let result = await callback(transactionSQL);
    if (Array.isArray(result)) result = await Promise.all(result);
    runSQLiteControl(client, "COMMIT");
    needsRollback = false;
    return result;
  } catch (error) {
    if (needsRollback) {
      try {
        runSQLiteControl(client, "ROLLBACK");
      } catch {}
    }
    throw error;
  }
}

async function runSQLiteSavepoint(client, callback, name = "") {
  if (typeof callback !== "function") throw new TypeError("fn must be a function");
  const identifier = "s" + client.nextSavepoint++ + (name ? "_" + name : "");
  runSQLiteControl(client, "SAVEPOINT " + escapeSQLiteIdentifier(identifier));
  const transactionSQL = createSQLiteSQLFunction(client, true);
  try {
    let result = await callback(transactionSQL);
    if (Array.isArray(result)) result = await Promise.all(result);
    runSQLiteControl(client, "RELEASE SAVEPOINT " + escapeSQLiteIdentifier(identifier));
    return result;
  } catch (error) {
    try {
      runSQLiteControl(client, "ROLLBACK TO SAVEPOINT " + escapeSQLiteIdentifier(identifier));
      runSQLiteControl(client, "RELEASE SAVEPOINT " + escapeSQLiteIdentifier(identifier));
    } catch {}
    throw error;
  }
}

function createSQLiteSQLFunction(client, inTransaction = false) {
  function sql(strings, ...values) {
    const isTaggedTemplate =
      Array.isArray(strings) &&
      (Array.isArray(strings.raw) ||
        (strings.length === values.length + 1 && strings.every((part) => typeof part === "string")));
    if (Array.isArray(strings) && !isTaggedTemplate) {
      return new SQLHelper(strings, values);
    }
    if (
      !Array.isArray(strings) &&
      strings != null &&
      typeof strings === "object" &&
      !(strings instanceof SQLiteQuery) &&
      !(strings instanceof SQLHelper)
    ) {
      return new SQLHelper([strings], values);
    }
    if (typeof strings === "string") {
      return new SQLiteQuery(client, escapeSQLiteIdentifier(strings), values, true);
    }
    return new SQLiteQuery(client, strings, values);
  }

  sql.unsafe = (statement, arguments_ = []) => new SQLiteQuery(client, String(statement), arguments_);
  sql.file = async (path, arguments_ = []) => {
    const text = await globalThis.Bun.file(String(path)).text();
    return await sql.unsafe(text, arguments_);
  };
  sql.connect = () => {
    if (client.closed) return Promise.reject(new SQLiteError("Connection closed"));
    if (client.storedError) return Promise.reject(client.storedError);
    return Promise.resolve(sql);
  };
  sql.array = () => {
    throw new Error("SQLite doesn't support arrays");
  };
  sql.reserve = () => Promise.reject(new Error("This adapter doesn't support connection reservation"));
  sql.flush = () => {
    throw new Error("SQLite doesn't support flush() - queries are executed synchronously");
  };
  sql.beginDistributed = () => {
    throw new Error("This adapter doesn't support distributed transactions.");
  };
  sql.commitDistributed = () => {
    throw new Error("SQLite doesn't support distributed transactions.");
  };
  sql.rollbackDistributed = () => {
    throw new Error("SQLite doesn't support distributed transactions.");
  };

  if (inTransaction) {
    sql.begin = () => {
      throw new SQLiteError("cannot call begin inside a transaction use savepoint() instead");
    };
    sql.savepoint = (callback, name = "") => runSQLiteSavepoint(client, callback, name);
    sql.close = async () => undefined;
  } else {
    sql.begin = (optionsOrCallback, callback) =>
      beginSQLiteTransaction(client, optionsOrCallback, callback);
    sql.close = async () => {
      if (client.closed) return;
      client.closed = true;
      const closedError = new Error("Connection closed");
      client.storedError = closedError;
      if (client.db) {
        try {
          client.db.close();
        } catch {}
        client.db = null;
      }
      try {
        client.options.onclose?.(closedError);
      } catch {}
    };
  }

  sql.transaction = sql.begin;
  sql.distributed = sql.beginDistributed;
  sql.end = sql.close;
  sql.options = client.options;
  sql[Symbol.asyncDispose] = () => sql.close();
  return sql;
}

function createSQLiteSQL(options) {
  const client = {
    options,
    db: null,
    storedError: null,
    closed: false,
    nextSavepoint: 0,
  };

  try {
    const databaseOptions = {};
    if (options.readonly) {
      databaseOptions.readonly = true;
    } else {
      databaseOptions.create = options.create !== false;
      databaseOptions.readwrite = true;
    }
    if ("safeIntegers" in options) databaseOptions.safeIntegers = options.safeIntegers;
    if ("strict" in options) databaseOptions.strict = options.strict;
    client.db = new SQLiteDatabase(options.filename, databaseOptions);
    try {
      options.onconnect?.(null);
    } catch {}
  } catch (error) {
    client.storedError = error;
    try {
      options.onconnect?.(error);
    } catch {}
  }

  return createSQLiteSQLFunction(client);
}

export function SQL(first = undefined, second = {}) {
  const configuration = resolveSQLConfiguration(first, second);
  if (configuration.adapter === "sqlite") return createSQLiteSQL(configuration.options);
  if (configuration.adapter === "postgres") return createPostgresSQL(configuration.options);
  throw new Error("Bun.SQL " + configuration.adapter + " adapter is not available");
}

SQL.SQLiteError = SQLiteError;
