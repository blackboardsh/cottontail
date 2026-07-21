// Bun.SQL dispatches between SQLite and network database adapters. PostgreSQL
// and MySQL/MariaDB speak their wire protocols directly so construction stays
// lazy and does not depend on an external command-line client.

import { Database as SQLiteDatabase, SQLiteError } from "./sqlite.js";
import * as net from "../node/net.js";
import * as tls from "../node/tls.js";
import { existsSync } from "../node/fs.js";
import {
  constants as cryptoConstants,
  createHash,
  createPublicKey,
  publicEncrypt,
} from "../node/crypto.js";

function md5hex(...parts) {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
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

    const connectionTimeout = options.connectionTimeout ?? 30_000;
    if (connectionTimeout > 0) {
      timer = setTimeout(() => {
        finish(new Error(`Connection timeout after ${connectionTimeout / 1000}s`));
      }, connectionTimeout);
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
  const options = input;
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

const MYSQL_CAP_LONG_PASSWORD = 1 << 0;
const MYSQL_CAP_LONG_FLAG = 1 << 2;
const MYSQL_CAP_CONNECT_WITH_DB = 1 << 3;
const MYSQL_CAP_PROTOCOL_41 = 1 << 9;
const MYSQL_CAP_SSL = 1 << 11;
const MYSQL_CAP_TRANSACTIONS = 1 << 13;
const MYSQL_CAP_SECURE_CONNECTION = 1 << 15;
const MYSQL_CAP_MULTI_STATEMENTS = 1 << 16;
const MYSQL_CAP_MULTI_RESULTS = 1 << 17;
const MYSQL_CAP_PLUGIN_AUTH = 1 << 19;
const MYSQL_CAP_DEPRECATE_EOF = 1 << 24;
const MYSQL_SERVER_MORE_RESULTS = 1 << 3;
const MYSQL_COLUMN_UNSIGNED = 1 << 5;
const MYSQL_COLUMN_BINARY = 1 << 7;

const MYSQL_ERROR_NAMES = {
  1044: "ER_DBACCESS_DENIED_ERROR",
  1045: "ER_ACCESS_DENIED_ERROR",
  1049: "ER_BAD_DB_ERROR",
  1050: "ER_TABLE_EXISTS_ERROR",
  1051: "ER_BAD_TABLE_ERROR",
  1052: "ER_NON_UNIQ_ERROR",
  1054: "ER_BAD_FIELD_ERROR",
  1062: "ER_DUP_ENTRY",
  1064: "ER_PARSE_ERROR",
  1146: "ER_NO_SUCH_TABLE",
  1213: "ER_LOCK_DEADLOCK",
  1451: "ER_ROW_IS_REFERENCED_2",
  1452: "ER_NO_REFERENCED_ROW_2",
};

class MySQLError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "MySQLError";
    this.code = options.code ?? "ERR_MYSQL_UNKNOWN";
    if (options.errno != null) this.errno = options.errno;
    if (options.sqlState != null) this.sqlState = options.sqlState;
    if (options.sqlMessage != null) this.sqlMessage = options.sqlMessage;
  }
}

function mysqlProtocolError(message, code = "ERR_MYSQL_PROTOCOL_ERROR") {
  return new MySQLError(message, { code });
}

function readUInt24LE(buffer, offset = 0) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

function writeUInt24LE(buffer, value, offset = 0) {
  buffer[offset] = value & 0xff;
  buffer[offset + 1] = (value >>> 8) & 0xff;
  buffer[offset + 2] = (value >>> 16) & 0xff;
}

function readNullTerminated(buffer, offset) {
  let end = buffer.indexOf(0, offset);
  if (end < 0) end = buffer.length;
  return { value: buffer.toString("utf8", offset, end), offset: Math.min(end + 1, buffer.length) };
}

function mysqlPacket(payload, sequenceId) {
  const header = Buffer.alloc(4);
  writeUInt24LE(header, payload.length);
  header[3] = sequenceId & 0xff;
  return Buffer.concat([header, payload]);
}

class MySQLPacketStream {
  constructor(socket) {
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.packets = [];
    this.waiters = [];
    this.failure = null;
    this.closed = false;
    this._onData = (chunk) => {
      const bytes = Buffer.from(chunk);
      this.buffer = this.buffer.length === 0 ? bytes : Buffer.concat([this.buffer, bytes]);
      this._drain();
    };
    this._onError = (error) => this.fail(error);
    this._onClose = () => {
      if (!this.closed) this.fail(new MySQLError("Connection closed", { code: "ERR_MYSQL_CONNECTION_CLOSED" }));
    };
    this.attach(socket);
  }

  attach(socket) {
    this.detach();
    this.socket = socket;
    socket.on("data", this._onData);
    socket.on("error", this._onError);
    socket.on("close", this._onClose);
  }

  detach() {
    if (!this.socket) return;
    this.socket.removeListener("data", this._onData);
    this.socket.removeListener("error", this._onError);
    this.socket.removeListener("close", this._onClose);
    this.socket = null;
  }

  _drain() {
    while (this.buffer.length >= 4) {
      const length = readUInt24LE(this.buffer);
      if (this.buffer.length < length + 4) return;
      const packet = {
        sequenceId: this.buffer[3],
        payload: Buffer.from(this.buffer.subarray(4, 4 + length)),
      };
      this.buffer = this.buffer.subarray(4 + length);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(packet);
      else this.packets.push(packet);
    }
  }

  readRawPacket() {
    if (this.packets.length > 0) return Promise.resolve(this.packets.shift());
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async readPacket() {
    const chunks = [];
    let packet;
    do {
      packet = await this.readRawPacket();
      chunks.push(packet.payload);
    } while (packet.payload.length === 0xffffff);
    return {
      sequenceId: packet.sequenceId,
      payload: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
    };
  }

  writePacket(payload, sequenceId = 0) {
    if (!this.socket || this.closed || this.failure) {
      throw this.failure ?? new MySQLError("Connection closed", { code: "ERR_MYSQL_CONNECTION_CLOSED" });
    }
    const bytes = Buffer.from(payload);
    let offset = 0;
    let sequence = sequenceId & 0xff;
    if (bytes.length === 0) {
      this.socket.write(mysqlPacket(bytes, sequence));
      return (sequence + 1) & 0xff;
    }
    while (offset < bytes.length) {
      const length = Math.min(0xffffff, bytes.length - offset);
      this.socket.write(mysqlPacket(bytes.subarray(offset, offset + length), sequence));
      offset += length;
      sequence = (sequence + 1) & 0xff;
    }
    if (bytes.length % 0xffffff === 0) {
      this.socket.write(mysqlPacket(Buffer.alloc(0), sequence));
      sequence = (sequence + 1) & 0xff;
    }
    return sequence;
  }

  fail(error) {
    if (this.failure || this.closed) return;
    this.failure = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.waiters.splice(0)) waiter.reject(this.failure);
  }

  close(error = null) {
    if (this.closed) return;
    if (error) this.fail(error);
    this.closed = true;
    const socket = this.socket;
    this.detach();
    try {
      socket?.destroy();
    } catch {}
    const closedError = error ?? new MySQLError("Connection closed", { code: "ERR_MYSQL_CONNECTION_CLOSED" });
    for (const waiter of this.waiters.splice(0)) waiter.reject(closedError);
  }
}

function parseMySQLHandshake(payload) {
  if (payload.length === 0) throw mysqlProtocolError("Empty MySQL handshake");
  if (payload[0] === 0xff) throw parseMySQLError(payload);
  if (payload[0] !== 10) throw mysqlProtocolError(`Unsupported MySQL protocol version: ${payload[0]}`);

  let offset = 1;
  const serverVersion = readNullTerminated(payload, offset);
  offset = serverVersion.offset;
  if (offset + 13 > payload.length) throw mysqlProtocolError("Truncated MySQL handshake");
  const connectionId = payload.readUInt32LE(offset);
  offset += 4;
  const authPart1 = Buffer.from(payload.subarray(offset, offset + 8));
  offset += 9;
  const lowerCapabilities = payload.readUInt16LE(offset);
  offset += 2;

  if (offset >= payload.length) {
    return {
      serverVersion: serverVersion.value,
      connectionId,
      capabilities: lowerCapabilities,
      characterSet: 0,
      statusFlags: 0,
      authPlugin: "mysql_native_password",
      authData: authPart1,
    };
  }

  const characterSet = payload[offset++];
  const statusFlags = payload.readUInt16LE(offset);
  offset += 2;
  const upperCapabilities = payload.readUInt16LE(offset);
  offset += 2;
  const capabilities = (lowerCapabilities | (upperCapabilities << 16)) >>> 0;
  const authDataLength = payload[offset++] || 0;
  offset += 10;

  let authPart2 = Buffer.alloc(0);
  if (offset < payload.length) {
    const requested = Math.max(13, authDataLength - 8);
    const available = Math.min(requested, payload.length - offset);
    authPart2 = Buffer.from(payload.subarray(offset, offset + available));
    offset += available;
    while (authPart2.length > 0 && authPart2[authPart2.length - 1] === 0) {
      authPart2 = authPart2.subarray(0, -1);
    }
  }

  let authPlugin = "mysql_native_password";
  if ((capabilities & MYSQL_CAP_PLUGIN_AUTH) !== 0 && offset < payload.length) {
    authPlugin = readNullTerminated(payload, offset).value || authPlugin;
  }
  return {
    serverVersion: serverVersion.value,
    connectionId,
    capabilities,
    characterSet,
    statusFlags,
    authPlugin,
    authData: Buffer.concat([authPart1, authPart2]).subarray(0, 20),
  };
}

function xorDigests(left, right) {
  const output = Buffer.alloc(left.length);
  for (let index = 0; index < output.length; index++) output[index] = left[index] ^ right[index];
  return output;
}

function mysqlNativePassword(password, nonce) {
  if (!password) return Buffer.alloc(0);
  if (nonce.length < 20) throw mysqlProtocolError("Missing MySQL authentication data");
  const first = createHash("sha1").update(String(password)).digest();
  const second = createHash("sha1").update(first).digest();
  const challenge = createHash("sha1").update(nonce.subarray(0, 20)).update(second).digest();
  return xorDigests(first, challenge);
}

function mysqlCachingSHA2Password(password, nonce) {
  if (!password) return Buffer.alloc(0);
  if (nonce.length === 0) throw mysqlProtocolError("Missing MySQL authentication data");
  const first = createHash("sha256").update(String(password)).digest();
  const second = createHash("sha256").update(first).digest();
  const challenge = createHash("sha256").update(second).update(nonce).digest();
  return xorDigests(first, challenge);
}

function mysqlAuthResponse(plugin, password, nonce, secure) {
  switch (plugin) {
    case "mysql_native_password":
      return mysqlNativePassword(password, nonce);
    case "caching_sha2_password":
      return mysqlCachingSHA2Password(password, nonce);
    case "sha256_password":
      return secure ? Buffer.from(`${password}\0`) : mysqlCachingSHA2Password(password, nonce);
    default:
      throw mysqlProtocolError(`Unsupported MySQL authentication plugin: ${plugin}`, "ERR_MYSQL_UNSUPPORTED_AUTH_PLUGIN");
  }
}

function mysqlEncryptedPassword(password, nonce, publicKey) {
  if (nonce.length === 0) throw mysqlProtocolError("Missing MySQL authentication data");
  const cleartext = Buffer.from(`${password}\0`);
  for (let index = 0; index < cleartext.length; index++) cleartext[index] ^= nonce[index % nonce.length];
  try {
    return publicEncrypt(
      {
        key: createPublicKey(publicKey),
        padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha1",
      },
      cleartext,
    );
  } catch (error) {
    throw new MySQLError(`Invalid MySQL server public key: ${error.message}`, {
      code: "ERR_MYSQL_INVALID_PUBLIC_KEY",
    });
  }
}

function buildMySQLHandshakeResponse(options, handshake, capabilities, secure) {
  const username = Buffer.from(String(options.username ?? ""));
  const database = Buffer.from(String(options.database ?? ""));
  const plugin = handshake.authPlugin || "mysql_native_password";
  const auth = mysqlAuthResponse(plugin, options.password ?? "", handshake.authData, secure);
  const pluginBytes = Buffer.from(plugin);
  const size =
    4 + 4 + 1 + 23 + username.length + 1 + 1 + auth.length +
    ((capabilities & MYSQL_CAP_CONNECT_WITH_DB) !== 0 ? database.length + 1 : 0) +
    ((capabilities & MYSQL_CAP_PLUGIN_AUTH) !== 0 ? pluginBytes.length + 1 : 0);
  const payload = Buffer.alloc(size);
  let offset = 0;
  payload.writeUInt32LE(capabilities >>> 0, offset);
  offset += 4;
  payload.writeUInt32LE(0, offset);
  offset += 4;
  payload[offset++] = 45;
  offset += 23;
  username.copy(payload, offset);
  offset += username.length + 1;
  payload[offset++] = auth.length;
  auth.copy(payload, offset);
  offset += auth.length;
  if ((capabilities & MYSQL_CAP_CONNECT_WITH_DB) !== 0) {
    database.copy(payload, offset);
    offset += database.length + 1;
  }
  if ((capabilities & MYSQL_CAP_PLUGIN_AUTH) !== 0) pluginBytes.copy(payload, offset);
  return payload;
}

function buildMySQLSSLRequest(capabilities) {
  const payload = Buffer.alloc(32);
  payload.writeUInt32LE(capabilities >>> 0, 0);
  payload.writeUInt32LE(0, 4);
  payload[8] = 45;
  return payload;
}

function parseMySQLError(payload) {
  let offset = 1;
  const errno = payload.length >= 3 ? payload.readUInt16LE(offset) : 0;
  offset += 2;
  let sqlState;
  if (payload[offset] === 0x23 && payload.length >= offset + 6) {
    sqlState = payload.toString("ascii", offset + 1, offset + 6);
    offset += 6;
  }
  const message = payload.toString("utf8", offset) || "MySQL error";
  return new MySQLError(message, {
    code: MYSQL_ERROR_NAMES[errno] ?? `ER_MYSQL_${errno}`,
    errno,
    sqlState,
    sqlMessage: message,
  });
}

function readLengthEncodedInteger(buffer, state) {
  if (state.offset >= buffer.length) throw mysqlProtocolError("Truncated length-encoded integer");
  const first = buffer[state.offset++];
  if (first < 0xfb) return first;
  if (first === 0xfb) return null;
  if (first === 0xfc) {
    const value = buffer.readUInt16LE(state.offset);
    state.offset += 2;
    return value;
  }
  if (first === 0xfd) {
    const value = readUInt24LE(buffer, state.offset);
    state.offset += 3;
    return value;
  }
  if (first === 0xfe) {
    const value = buffer.readBigUInt64LE(state.offset);
    state.offset += 8;
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }
  throw mysqlProtocolError("Invalid length-encoded integer");
}

function readLengthEncodedBuffer(buffer, state) {
  const length = readLengthEncodedInteger(buffer, state);
  if (length === null) return null;
  const number = Number(length);
  if (!Number.isSafeInteger(number) || number < 0 || state.offset + number > buffer.length) {
    throw mysqlProtocolError("Truncated length-encoded string");
  }
  const value = Buffer.from(buffer.subarray(state.offset, state.offset + number));
  state.offset += number;
  return value;
}

function parseMySQLOKPacket(payload) {
  const state = { offset: 1 };
  const affectedRows = readLengthEncodedInteger(payload, state) ?? 0;
  const lastInsertRowid = readLengthEncodedInteger(payload, state) ?? 0;
  const statusFlags = state.offset + 2 <= payload.length ? payload.readUInt16LE(state.offset) : 0;
  return { affectedRows, lastInsertRowid, statusFlags };
}

function isMySQLEOFPacket(payload) {
  return payload[0] === 0xfe && payload.length < 9;
}

function isMySQLResultTerminator(payload) {
  return isMySQLEOFPacket(payload) || (payload[0] === 0xfe && payload.length >= 7);
}

function mysqlTerminatorStatus(payload) {
  if (isMySQLEOFPacket(payload)) return payload.length >= 5 ? payload.readUInt16LE(3) : 0;
  return parseMySQLOKPacket(payload).statusFlags;
}

function parseMySQLColumn(payload) {
  const state = { offset: 0 };
  const catalog = readLengthEncodedBuffer(payload, state);
  const schema = readLengthEncodedBuffer(payload, state);
  const table = readLengthEncodedBuffer(payload, state);
  const originalTable = readLengthEncodedBuffer(payload, state);
  const name = readLengthEncodedBuffer(payload, state);
  const originalName = readLengthEncodedBuffer(payload, state);
  readLengthEncodedInteger(payload, state);
  if (state.offset + 10 > payload.length) throw mysqlProtocolError("Truncated MySQL column definition");
  const characterSet = payload.readUInt16LE(state.offset);
  state.offset += 2;
  const columnLength = payload.readUInt32LE(state.offset);
  state.offset += 4;
  const type = payload[state.offset++];
  const flags = payload.readUInt16LE(state.offset);
  state.offset += 2;
  const decimals = payload[state.offset];
  return {
    catalog: catalog?.toString("utf8") ?? "",
    schema: schema?.toString("utf8") ?? "",
    table: table?.toString("utf8") ?? "",
    originalTable: originalTable?.toString("utf8") ?? "",
    name: name?.toString("utf8") ?? "",
    originalName: originalName?.toString("utf8") ?? "",
    characterSet,
    columnLength,
    type,
    flags,
    decimals,
  };
}

function parseMySQLValue(bytes, column, options, raw) {
  if (bytes === null) return null;
  if (raw) return Buffer.from(bytes);
  const text = bytes.toString("utf8");
  switch (column.type) {
    case 0x01:
    case 0x02:
    case 0x03:
    case 0x09:
      return Number(text);
    case 0x08: {
      const integer = BigInt(text || "0");
      const unsigned = (column.flags & MYSQL_COLUMN_UNSIGNED) !== 0;
      const fitsNumber = unsigned
        ? integer <= 0xffffffffn
        : integer >= -0x80000000n && integer <= 0x7fffffffn;
      if (fitsNumber) return Number(integer);
      return options.bigint ? integer : text;
    }
    case 0x04:
    case 0x05:
      return Number(text);
    case 0x07:
    case 0x0a:
    case 0x0c: {
      const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
      return Number.isNaN(date.getTime()) ? new Date(NaN) : date;
    }
    case 0x0b:
      return text;
    case 0x10:
      return column.columnLength === 1 ? bytes[0] === 1 : Buffer.from(bytes);
    case 0xf5:
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    default:
      if ((column.flags & MYSQL_COLUMN_BINARY) !== 0 && column.characterSet === 63) return Buffer.from(bytes);
      return text;
  }
}

function parseMySQLRow(payload, columns, options, mode) {
  const state = { offset: 0 };
  const values = columns.map((column) =>
    parseMySQLValue(readLengthEncodedBuffer(payload, state), column, options, mode === "raw"),
  );
  if (mode === "values" || mode === "raw") return values;
  const row = {};
  for (let index = 0; index < columns.length; index++) row[columns[index].name || String(index)] = values[index];
  return row;
}

function waitForSocketConnect(socket) {
  if (!socket.connecting) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function waitForSecureConnect(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener("secureConnect", onConnect);
      socket.removeListener("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("secureConnect", onConnect);
    socket.once("error", onError);
  });
}

function mysqlTLSOptions(options, socket) {
  const configured = options.tls && typeof options.tls === "object" ? { ...options.tls } : {};
  const servername = configured.servername ?? configured.serverName ?? options.hostname;
  delete configured.serverName;
  const verify = options.sslMode >= SSL_MODE_VERIFY_CA;
  const tlsOptions = {
    ...configured,
    socket,
    host: options.hostname,
    servername,
    rejectUnauthorized: configured.rejectUnauthorized ?? verify,
  };
  if (options.sslMode === SSL_MODE_VERIFY_CA && configured.checkServerIdentity == null) {
    tlsOptions.checkServerIdentity = () => undefined;
  }
  return tlsOptions;
}

class MySQLSession {
  constructor(client) {
    this.client = client;
    this.options = client.options;
    this.socket = null;
    this.stream = null;
    this.openPromise = null;
    this.connected = false;
    this.secure = false;
    this.closed = false;
    this.capabilities = 0;
    this.queue = Promise.resolve();
    this.closeReason = null;
    client.sessions.add(this);
  }

  open() {
    if (this.connected) return Promise.resolve(this);
    if (this.closed) {
      return Promise.reject(new MySQLError("Connection closed", { code: "ERR_MYSQL_CONNECTION_CLOSED" }));
    }
    if (!this.openPromise) {
      this.openPromise = this._open().then(
        () => {
          this.connected = true;
          if (this.options.maxLifetime > 0) {
            this._lifetimeTimer = setTimeout(() => {
              this.close(new MySQLError("Max lifetime timeout reached", {
                code: "ERR_MYSQL_LIFETIME_TIMEOUT",
              }));
            }, this.options.maxLifetime);
            this._lifetimeTimer.unref?.();
          }
          try {
            this.options.onconnect?.(null);
          } catch {}
          return this;
        },
        (error) => {
          try {
            this.options.onconnect?.(error);
          } catch {}
          this.close(error);
          throw error;
        },
      );
    }
    return this.openPromise;
  }

  async _open() {
    let password = this.options.password;
    if (typeof password === "function") password = password();
    password = await password;
    this.options = { ...this.options, password: password ?? "" };
    for (const [name, value] of [
      ["username", this.options.username],
      ["password", this.options.password],
      ["database", this.options.database],
    ]) {
      if (String(value ?? "").includes("\0")) {
        throw mysqlProtocolError(`MySQL ${name} cannot contain null bytes`, "ERR_MYSQL_INVALID_CREDENTIALS");
      }
    }

    const socket = this.options.path
      ? net.connect(this.options.path)
      : net.connect(this.options.port, this.options.hostname);
    this.socket = socket;
    this.stream = new MySQLPacketStream(socket);

    let timer = null;
    const timeout = this.options.connectionTimeout ?? 30_000;
    if (timeout > 0) {
      timer = setTimeout(() => {
        const error = new MySQLError(`Connection timeout after ${timeout / 1000}s (during authentication)`, {
          code: "ERR_MYSQL_CONNECTION_TIMEOUT",
        });
        this.stream?.fail(error);
        try {
          this.socket?.destroy(error);
        } catch {}
      }, timeout);
      timer.unref?.();
    }

    try {
      await waitForSocketConnect(socket);
      const handshakePacket = await this.stream.readPacket();
      const handshake = parseMySQLHandshake(handshakePacket.payload);
      const wantsTLS = this.options.sslMode !== SSL_MODE_DISABLE || Boolean(this.options.tls);
      let desiredCapabilities =
        MYSQL_CAP_LONG_PASSWORD |
        MYSQL_CAP_LONG_FLAG |
        MYSQL_CAP_PROTOCOL_41 |
        MYSQL_CAP_TRANSACTIONS |
        MYSQL_CAP_SECURE_CONNECTION |
        MYSQL_CAP_MULTI_STATEMENTS |
        MYSQL_CAP_MULTI_RESULTS |
        MYSQL_CAP_PLUGIN_AUTH |
        MYSQL_CAP_DEPRECATE_EOF;
      if (this.options.database) desiredCapabilities |= MYSQL_CAP_CONNECT_WITH_DB;
      if (wantsTLS) desiredCapabilities |= MYSQL_CAP_SSL;
      this.capabilities = (desiredCapabilities & handshake.capabilities) >>> 0;
      if ((this.capabilities & MYSQL_CAP_PROTOCOL_41) === 0) {
        throw mysqlProtocolError("MySQL server does not support protocol 4.1");
      }

      let sequence = (handshakePacket.sequenceId + 1) & 0xff;
      if (wantsTLS && (this.capabilities & MYSQL_CAP_SSL) !== 0) {
        sequence = this.stream.writePacket(buildMySQLSSLRequest(this.capabilities), sequence);
        this.stream.detach();
        const secureSocket = tls.connect(mysqlTLSOptions(this.options, socket));
        this.socket = secureSocket;
        this.stream.attach(secureSocket);
        await waitForSecureConnect(secureSocket);
        this.secure = true;
      } else if (wantsTLS && this.options.sslMode >= SSL_MODE_VERIFY_CA) {
        throw new MySQLError("MySQL server does not support TLS", { code: "ERR_MYSQL_TLS_NOT_SUPPORTED" });
      } else {
        this.capabilities &= ~MYSQL_CAP_SSL;
      }

      sequence = this.stream.writePacket(
        buildMySQLHandshakeResponse(this.options, handshake, this.capabilities, this.secure),
        sequence,
      );
      await this._authenticate(handshake, sequence);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _authenticate(handshake, nextSequence) {
    let plugin = handshake.authPlugin || "mysql_native_password";
    let nonce = handshake.authData;
    let awaitingPublicKey = false;
    for (;;) {
      const packet = await this.stream.readPacket();
      const payload = packet.payload;
      if (payload.length === 0) throw mysqlProtocolError("Empty MySQL authentication packet");
      if (payload[0] === 0x00) return;
      if (payload[0] === 0xff) throw parseMySQLError(payload);

      nextSequence = (packet.sequenceId + 1) & 0xff;
      if (payload[0] === 0xfe) {
        const parsedPlugin = readNullTerminated(payload, 1);
        plugin = parsedPlugin.value;
        nonce = Buffer.from(payload.subarray(parsedPlugin.offset));
        while (nonce.length > 0 && nonce[nonce.length - 1] === 0) nonce = nonce.subarray(0, -1);
        this.stream.writePacket(
          mysqlAuthResponse(plugin, this.options.password, nonce, this.secure),
          nextSequence,
        );
        awaitingPublicKey = false;
        continue;
      }

      if (payload[0] !== 0x01) {
        throw mysqlProtocolError(`Unexpected MySQL authentication packet: 0x${payload[0].toString(16)}`);
      }
      if (awaitingPublicKey) {
        const publicKey = payload.subarray(1);
        this.stream.writePacket(
          mysqlEncryptedPassword(this.options.password, nonce, publicKey),
          nextSequence,
        );
        awaitingPublicKey = false;
        continue;
      }

      const status = payload[1];
      if (status === 0x03) continue;
      if (status === 0x04) {
        if (this.secure) {
          this.stream.writePacket(Buffer.from(`${this.options.password}\0`), nextSequence);
        } else {
          this.stream.writePacket(Buffer.from([plugin === "sha256_password" ? 0x01 : 0x02]), nextSequence);
          awaitingPublicKey = true;
        }
        continue;
      }
      throw mysqlProtocolError(`Unsupported MySQL authentication continuation: ${status}`);
    }
  }

  query(statement, mode = "objects") {
    const operation = this.queue.then(async () => {
      await this.open();
      if (this.closed) {
        throw new MySQLError("Connection closed", { code: "ERR_MYSQL_CONNECTION_CLOSED" });
      }
      const query = Buffer.concat([Buffer.from([0x03]), Buffer.from(statement)]);
      this.stream.writePacket(query, 0);
      return await this._readQueryResults(statement, mode);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  async _readQueryResults(statement, mode) {
    const results = [];
    let statusFlags = 0;
    do {
      const parsed = await this._readQueryResult(statement, mode);
      results.push(parsed.result);
      statusFlags = parsed.statusFlags;
    } while ((statusFlags & MYSQL_SERVER_MORE_RESULTS) !== 0);
    return results.length === 1 ? results[0] : results;
  }

  async _readQueryResult(statement, mode) {
    const first = (await this.stream.readPacket()).payload;
    if (first.length === 0) throw mysqlProtocolError("Empty MySQL query response");
    if (first[0] === 0xff) throw parseMySQLError(first);
    if (first[0] === 0x00) {
      const ok = parseMySQLOKPacket(first);
      const result = new SQLResultArray();
      result.command = parseSQLQuery(statement).command;
      result.count = ok.affectedRows;
      result.affectedRows = ok.affectedRows;
      result.lastInsertRowid = ok.lastInsertRowid;
      return { result, statusFlags: ok.statusFlags };
    }
    if (first[0] === 0xfb) {
      throw new MySQLError("MySQL LOCAL INFILE is not supported", { code: "ERR_MYSQL_LOCAL_INFILE" });
    }

    const columnState = { offset: 0 };
    const columnCount = Number(readLengthEncodedInteger(first, columnState));
    if (!Number.isSafeInteger(columnCount) || columnCount < 0) {
      throw mysqlProtocolError("Invalid MySQL result column count");
    }
    const columns = [];
    for (let index = 0; index < columnCount; index++) {
      const packet = await this.stream.readPacket();
      if (packet.payload[0] === 0xff) throw parseMySQLError(packet.payload);
      columns.push(parseMySQLColumn(packet.payload));
    }

    let packet = await this.stream.readPacket();
    if (isMySQLEOFPacket(packet.payload)) packet = await this.stream.readPacket();
    const rows = [];
    let statusFlags = 0;
    for (;;) {
      if (packet.payload[0] === 0xff) throw parseMySQLError(packet.payload);
      if (isMySQLResultTerminator(packet.payload)) {
        statusFlags = mysqlTerminatorStatus(packet.payload);
        break;
      }
      rows.push(parseMySQLRow(packet.payload, columns, this.options, mode));
      packet = await this.stream.readPacket();
    }

    const result = new SQLResultArray(rows);
    result.command = parseSQLQuery(statement).command;
    result.count = rows.length;
    result.affectedRows = 0;
    result.lastInsertRowid = 0;
    return { result, statusFlags };
  }

  close(error = null) {
    if (this.closed) return;
    this.closed = true;
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (this._lifetimeTimer) clearTimeout(this._lifetimeTimer);
    this._idleTimer = null;
    this._lifetimeTimer = null;
    this.closeReason = error;
    if (this.connected && !error) {
      try {
        this.stream?.writePacket(Buffer.from([0x01]), 0);
      } catch {}
    }
    this.connected = false;
    this.stream?.close(error);
    if (!this.stream) {
      try {
        this.socket?.destroy();
      } catch {}
    }
    this.client.sessionClosed(this);
    try {
      this.options.onclose?.(error);
    } catch {}
  }
}

function escapeMySQLIdentifier(value) {
  return "`" + String(value).replaceAll("`", "``").replaceAll(".", "`.`") + "`";
}

function escapeMySQLValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : `'${String(value)}'`;
  if (typeof value === "bigint") {
    if (value < -(2n ** 63n) || value > 2n ** 64n - 1n) {
      throw new RangeError("The value is out of range. It must fit in a MySQL 64-bit integer");
    }
    return value.toString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Invalid Date cannot be bound to a MySQL query");
    return `'${value.toISOString().replace("T", " ").replace("Z", "")}'`;
  }
  if (value instanceof ArrayBuffer) value = new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return `X'${bytes.toString("hex")}'`;
  }
  if (typeof value === "object") value = JSON.stringify(value);
  if (typeof value === "function" || typeof value === "symbol") {
    throw new TypeError("Cannot bind this type to a MySQL query parameter");
  }
  return "'" +
    String(value).replace(/[\0\b\t\n\r\x1a'"\\]/g, (character) => {
      switch (character) {
        case "\0": return "\\0";
        case "\b": return "\\b";
        case "\t": return "\\t";
        case "\n": return "\\n";
        case "\r": return "\\r";
        case "\x1a": return "\\Z";
        default: return "\\" + character;
      }
    }) +
    "'";
}

function interpolateMySQLPlaceholders(statement, values) {
  let output = "";
  let valueIndex = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index];
    const next = statement[index + 1];
    if (lineComment) {
      output += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      output += character;
      if (character === "*" && next === "/") {
        output += next;
        index++;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (character === "\\") {
        if (next !== undefined) output += statement[++index];
      } else if (character === quote) {
        if (next === quote) output += statement[++index];
        else quote = null;
      }
      continue;
    }
    if (character === "-" && next === "-") {
      output += character + next;
      index++;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      output += character + next;
      index++;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "?" && valueIndex < values.length) {
      output += escapeMySQLValue(values[valueIndex++]);
      continue;
    }
    output += character;
  }
  if (valueIndex !== values.length) throw new TypeError("Too many MySQL query parameters");
  return output;
}

function normalizeMySQLQuery(strings, values) {
  if (typeof strings === "string") return interpolateMySQLPlaceholders(strings, values ?? []);
  if (!Array.isArray(strings)) {
    throw new SyntaxError("Invalid query: SQL Fragment cannot be executed or was misused");
  }

  let query = "";
  for (let index = 0; index < strings.length; index++) {
    if (typeof strings[index] !== "string") {
      throw new SyntaxError("Invalid query: SQL Fragment cannot be executed or was misused");
    }
    query += strings[index];
    if (index >= values.length) continue;
    const value = values[index];

    if (value instanceof MySQLQuery) {
      query += value._buildStatement();
      continue;
    }
    if (!(value instanceof SQLHelper)) {
      query += escapeMySQLValue(value);
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
      const rows = Array.isArray(items) ? items : [items];
      const definedColumns = columns.filter((column) =>
        rows.some((row) => row != null && typeof row[column] !== "undefined"),
      );
      if (definedColumns.length === 0) {
        throw new SyntaxError("Insert needs to have at least one column with a defined value");
      }
      query += `(${definedColumns.map(escapeMySQLIdentifier).join(", ")}) VALUES`;
      query += rows
        .map((row) =>
          `(${definedColumns
            .map((column) => escapeMySQLValue(typeof row[column] === "undefined" ? null : row[column]))
            .join(", ")})`,
        )
        .join(",");
      query += " ";
      continue;
    }

    if (command === "in") {
      if (columns.length > 1) throw new SyntaxError("Cannot use WHERE IN helper with multiple columns");
      const rows = Array.isArray(items) ? items : [items];
      const bindings = rows.map((row) => columns.length === 0 ? row : row?.[columns[0]]);
      query += `(${bindings.length > 0 ? bindings.map(escapeMySQLValue).join(", ") : "NULL"}) `;
      continue;
    }

    const rows = Array.isArray(items) ? items : [items];
    if (rows.length > 1) throw new SyntaxError("Cannot use array of objects for UPDATE");
    if (command === "update") query += " SET ";
    const assignments = [];
    for (const column of columns) {
      if (typeof rows[0]?.[column] === "undefined") continue;
      assignments.push(`${escapeMySQLIdentifier(column)} = ${escapeMySQLValue(rows[0][column])}`);
    }
    if (assignments.length === 0) throw new SyntaxError("Update needs to have at least one column");
    query += assignments.join(", ") + " ";
  }
  return query;
}

class MySQLQuery extends Promise {
  constructor(client, strings, values, options = {}) {
    let resolvePromise;
    let rejectPromise;
    super((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    this._client = client;
    this._strings = strings;
    this._values = values;
    this._notTagged = options.notTagged === true;
    this._fixedSession = options.session ?? null;
    this._resolvePromise = resolvePromise;
    this._rejectPromise = rejectPromise;
    this._mode = "objects";
    this._started = false;
    this._cancelled = false;
    this._session = null;
    this.active = false;
  }

  static get [Symbol.species]() {
    return Promise;
  }

  _buildStatement() {
    return normalizeMySQLQuery(this._strings, this._values);
  }

  _start() {
    if (this._started || this._cancelled) return;
    this._started = true;
    if (this._notTagged) {
      this._rejectPromise(new MySQLError("Query not called as a tagged template literal", {
        code: "ERR_MYSQL_NOT_TAGGED_CALL",
      }));
      return;
    }
    this.active = true;
    Promise.resolve()
      .then(() => this._client.execute(this))
      .then(this._resolvePromise, this._rejectPromise)
      .finally(() => {
        this.active = false;
      });
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
    if (this._started || this._cancelled) {
      if (this.active) this._session?.close(new MySQLError("Query cancelled", { code: "ERR_MYSQL_QUERY_CANCELLED" }));
      return this;
    }
    this._cancelled = true;
    this._rejectPromise(new MySQLError("Query cancelled", { code: "ERR_MYSQL_QUERY_CANCELLED" }));
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

class MySQLClient {
  constructor(options) {
    this.options = options;
    this.sessions = new Set();
    this.available = [];
    this.waiters = [];
    this.closed = false;
  }

  acquire() {
    if (this.closed) {
      return Promise.reject(new MySQLError("Connection closed", { code: "ERR_MYSQL_CONNECTION_CLOSED" }));
    }
    while (this.available.length > 0) {
      const session = this.available.pop();
      if (session.closed) continue;
      if (session.stream?.failure) {
        session.close(session.stream.failure);
        continue;
      }
      if (session._idleTimer) clearTimeout(session._idleTimer);
      session._idleTimer = null;
      return Promise.resolve(session);
    }
    if (this.sessions.size < this.options.max) return Promise.resolve(new MySQLSession(this));
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  release(session) {
    if (!session || session.closed) return;
    if (this.closed) {
      session.close();
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(session);
      return;
    }
    if (!this.available.includes(session)) this.available.push(session);
    if (this.options.idleTimeout > 0) {
      session._idleTimer = setTimeout(() => session.close(), this.options.idleTimeout);
      session._idleTimer.unref?.();
    }
  }

  sessionClosed(session) {
    this.sessions.delete(session);
    const index = this.available.indexOf(session);
    if (index !== -1) this.available.splice(index, 1);
    if (!this.closed && this.waiters.length > 0 && this.sessions.size < this.options.max) {
      this.waiters.shift().resolve(new MySQLSession(this));
    }
  }

  async execute(query) {
    const statement = query._buildStatement();
    if (query._fixedSession) {
      query._session = query._fixedSession;
      return await query._fixedSession.query(statement, query._mode);
    }
    const session = await this.acquire();
    query._session = session;
    try {
      return await session.query(statement, query._mode);
    } finally {
      if (session.stream?.failure) session.close(session.stream.failure);
      else this.release(session);
    }
  }

  async close(error = null) {
    if (this.closed) return;
    this.closed = true;
    const closeError = error ?? new MySQLError("Connection closed", { code: "ERR_MYSQL_CONNECTION_CLOSED" });
    for (const waiter of this.waiters.splice(0)) waiter.reject(closeError);
    for (const session of [...this.sessions]) session.close(error);
    this.available.length = 0;
  }
}

async function runMySQLSavepoint(client, session, callback, name = "") {
  if (typeof callback !== "function") throw new TypeError("fn must be a function");
  const identifier = `s${client.nextSavepoint++}${name ? `_${name}` : ""}`;
  const escaped = escapeMySQLIdentifier(identifier);
  await session.query(`SAVEPOINT ${escaped}`);
  const sql = createMySQLSQLFunction(client, session, "transaction");
  try {
    let result = await callback(sql);
    if (Array.isArray(result)) result = await Promise.all(result);
    await session.query(`RELEASE SAVEPOINT ${escaped}`);
    return result;
  } catch (error) {
    try {
      await session.query(`ROLLBACK TO SAVEPOINT ${escaped}`);
      await session.query(`RELEASE SAVEPOINT ${escaped}`);
    } catch {}
    throw error;
  }
}

async function runMySQLTransaction(client, optionsOrCallback, maybeCallback) {
  let options = optionsOrCallback;
  let callback = maybeCallback;
  if (typeof optionsOrCallback === "function") {
    callback = optionsOrCallback;
    options = undefined;
  }
  if (typeof callback !== "function") throw new TypeError("fn must be a function");
  const session = await client.acquire();
  try {
    await session.query(`START TRANSACTION${options ? ` ${String(options)}` : ""}`);
    const transactionSQL = createMySQLSQLFunction(client, session, "transaction");
    try {
      let result = await callback(transactionSQL);
      if (Array.isArray(result)) result = await Promise.all(result);
      await session.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await session.query("ROLLBACK");
      } catch {}
      throw error;
    }
  } finally {
    client.release(session);
  }
}

function validateMySQLDistributedName(name) {
  name = String(name);
  if (name.includes("'")) throw new Error("Distributed transaction name cannot contain single quotes.");
  return name;
}

async function runMySQLDistributedTransaction(client, name, callback) {
  if (typeof callback !== "function") throw new TypeError("fn must be a function");
  name = validateMySQLDistributedName(name);
  const session = await client.acquire();
  try {
    await session.query(`XA START '${name}'`);
    const transactionSQL = createMySQLSQLFunction(client, session, "distributed");
    try {
      let result = await callback(transactionSQL);
      if (Array.isArray(result)) result = await Promise.all(result);
      await session.query(`XA END '${name}'`);
      await session.query(`XA PREPARE '${name}'`);
      return result;
    } catch (error) {
      try {
        await session.query(`XA END '${name}'`);
        await session.query(`XA ROLLBACK '${name}'`);
      } catch {}
      throw error;
    }
  } finally {
    client.release(session);
  }
}

function createMySQLSQLFunction(client, session = null, state = "root") {
  function sql(strings, ...values) {
    const isTaggedTemplate =
      Array.isArray(strings) &&
      (Array.isArray(strings.raw) ||
        (strings.length === values.length + 1 && strings.every((part) => typeof part === "string")));
    if (Array.isArray(strings) && !isTaggedTemplate) return new SQLHelper(strings, values);
    if (
      !Array.isArray(strings) &&
      strings != null &&
      typeof strings === "object" &&
      !(strings instanceof MySQLQuery) &&
      !(strings instanceof SQLHelper)
    ) {
      return new SQLHelper([strings], values);
    }
    if (typeof strings === "string") {
      return new MySQLQuery(client, escapeMySQLIdentifier(strings), [], {
        notTagged: true,
        session,
      });
    }
    return new MySQLQuery(client, strings, values, { session });
  }

  sql.unsafe = (statement, arguments_ = []) =>
    new MySQLQuery(client, String(statement), arguments_ ?? [], { session });
  sql.file = async (path, arguments_ = []) => {
    const text = await globalThis.Bun.file(String(path)).text();
    return await sql.unsafe(text, arguments_);
  };
  sql.connect = async () => {
    if (session) {
      await session.open();
      return sql;
    }
    const connection = await client.acquire();
    try {
      await connection.open();
    } finally {
      client.release(connection);
    }
    return sql;
  };
  sql.array = () => {
    throw new Error("MySQL doesn't support arrays");
  };
  sql.flush = () => undefined;

  if (state === "root") {
    sql.reserve = async () => {
      const reserved = await client.acquire();
      try {
        await reserved.open();
      } catch (error) {
        reserved.close(error);
        throw error;
      }
      return createMySQLSQLFunction(client, reserved, "reserved");
    };
    sql.begin = (optionsOrCallback, callback) => runMySQLTransaction(client, optionsOrCallback, callback);
    sql.beginDistributed = (name, callback) => runMySQLDistributedTransaction(client, name, callback);
    sql.commitDistributed = (name) => sql.unsafe(`XA COMMIT '${validateMySQLDistributedName(name)}'`);
    sql.rollbackDistributed = (name) => sql.unsafe(`XA ROLLBACK '${validateMySQLDistributedName(name)}'`);
    sql.close = (options) => client.close(options?.reason ?? null);
  } else {
    sql.reserve = async () => sql;
    sql.begin = () => {
      throw new MySQLError("cannot call begin inside a transaction use savepoint() instead", {
        code: "ERR_MYSQL_INVALID_TRANSACTION_STATE",
      });
    };
    sql.beginDistributed = () => {
      throw new MySQLError("cannot call beginDistributed inside a transaction", {
        code: "ERR_MYSQL_INVALID_TRANSACTION_STATE",
      });
    };
    sql.commitDistributed = () => {
      throw new MySQLError("cannot commit a distributed transaction from an active transaction", {
        code: "ERR_MYSQL_INVALID_TRANSACTION_STATE",
      });
    };
    sql.rollbackDistributed = sql.commitDistributed;
    sql.close = async () => {
      if (state === "reserved") session.close();
    };
    sql.savepoint = (callback, name = "") => runMySQLSavepoint(client, session, callback, name);
  }

  sql.transaction = sql.begin;
  sql.distributed = sql.beginDistributed;
  sql.end = sql.close;
  sql.options = client.options;
  sql[Symbol.asyncDispose] = () => sql.close();
  return sql;
}

function createMySQLSQL(options) {
  const client = new MySQLClient(options);
  client.nextSavepoint = 0;
  return createMySQLSQLFunction(client);
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

const SSL_MODE_DISABLE = 0;
const SSL_MODE_PREFER = 1;
const SSL_MODE_REQUIRE = 2;
const SSL_MODE_VERIFY_CA = 3;
const SSL_MODE_VERIFY_FULL = 4;

function invalidSQLArgument(name, value, reason) {
  const error = new TypeError(`The argument '${name}' ${reason}. Received ${JSON.stringify(value)}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function normalizeSSLMode(value) {
  switch (String(value ?? "").toLowerCase()) {
    case "":
    case "disable":
      return SSL_MODE_DISABLE;
    case "prefer":
      return SSL_MODE_PREFER;
    case "require":
    case "required":
      return SSL_MODE_REQUIRE;
    case "verify-ca":
    case "verify_ca":
      return SSL_MODE_VERIFY_CA;
    case "verify-full":
    case "verify_full":
      return SSL_MODE_VERIFY_FULL;
    default:
      throw invalidSQLArgument(
        "sslmode",
        value,
        "must be one of: disable, prefer, require, verify-ca, verify-full",
      );
  }
}

function environmentConnectionDetails(adapter) {
  const env = globalThis.Bun?.env ?? globalThis.process?.env ?? {};
  let url = env.DATABASE_URL || env.DATABASEURL || null;
  if (url) return { url, sslMode: null, adapter: adapter ?? null };
  url = env.TLS_DATABASE_URL || null;
  if (url) return { url, sslMode: SSL_MODE_REQUIRE, adapter: adapter ?? null };

  if (!adapter || adapter === "postgres") {
    url = env.POSTGRES_URL || env.PGURL || env.PG_URL || null;
    if (url) return { url, sslMode: null, adapter: "postgres" };
    url = env.TLS_POSTGRES_DATABASE_URL || null;
    if (url) return { url, sslMode: SSL_MODE_REQUIRE, adapter: "postgres" };
  }
  if (!adapter || adapter === "mysql") {
    url = env.MYSQL_URL || env.MYSQLURL || null;
    if (url) return { url, sslMode: null, adapter: "mysql" };
    url = env.TLS_MYSQL_DATABASE_URL || null;
    if (url) return { url, sslMode: SSL_MODE_REQUIRE, adapter: "mysql" };
  }
  if (!adapter || adapter === "mariadb") {
    url = env.MARIADB_URL || env.MARIADBURL || null;
    if (url) return { url, sslMode: null, adapter: "mariadb" };
    url = env.TLS_MARIADB_DATABASE_URL || null;
    if (url) return { url, sslMode: SSL_MODE_REQUIRE, adapter: "mariadb" };
  }
  if (!adapter || adapter === "sqlite") {
    url = env.SQLITE_URL || env.SQLITEURL || null;
    if (url) return { url, sslMode: null, adapter: "sqlite" };
  }
  return { url: null, sslMode: null, adapter: adapter ?? null };
}

function adapterFromProtocol(protocol) {
  switch (String(protocol).toLowerCase()) {
    case "http":
    case "https":
    case "ftp":
    case "postgres":
    case "postgresql":
      return "postgres";
    case "mysql":
    case "mysql2":
      return "mysql";
    case "mariadb":
      return "mariadb";
    case "file":
    case "sqlite":
      return "sqlite";
    default:
      return null;
  }
}

function decodeURLPart(value) {
  return value ? decodeURIComponent(value) : null;
}

function validateDurationOption(name, value) {
  if (value == null) return undefined;
  const number = Number(value);
  if (number > 2 ** 31 || number < 0 || Number.isNaN(number)) {
    throw invalidSQLArgument(name, number, "must be a non-negative integer less than 2^31");
  }
  return number * 1000;
}

function normalizeNetworkOptions(urlValue, options, sslModeFromEnvironment) {
  const env = globalThis.Bun?.env ?? globalThis.process?.env ?? {};
  const adapter = options.adapter;
  let url = urlValue == null ? null : urlValue instanceof URL ? urlValue : new URL(String(urlValue));
  let sslMode = sslModeFromEnvironment ?? SSL_MODE_DISABLE;
  let query = "";

  let hostname = options.host || options.hostname || url?.hostname || undefined;
  let port = options.port || url?.port || undefined;
  let username = options.user || options.username || decodeURLPart(url?.username) || undefined;
  let password = options.pass || options.password || decodeURLPart(url?.password) || undefined;
  let path = options.path || url?.pathname || "";

  if (url) {
    for (const [key, value] of url.searchParams) {
      if (key.toLowerCase() === "sslmode") {
        sslMode = normalizeSSLMode(value);
      } else if (key.toLowerCase() === "path") {
        path = value;
      } else {
        query += `${key}\0${value}\0`;
      }
    }
    query = query.trim();
  }

  if (adapter === "postgres") {
    hostname ||= options.hostname || options.host || env.PG_HOST || env.PGHOST || "localhost";
    port ||= Number(options.port || env.PG_PORT || env.PGPORT || "5432");
    username ||= options.username || options.user || env.PG_USER || env.PGUSER || env.USER || "postgres";
    password ||= options.password || options.pass || env.PG_PASSWORD || env.PGPASSWORD || env.PASSWORD || "";
  } else if (adapter === "mysql") {
    hostname ||= options.hostname || options.host || env.MYSQL_HOST || env.MYSQLHOST || "localhost";
    port ||= Number(options.port || env.MYSQL_PORT || env.MYSQLPORT || "3306");
    username ||= options.username || options.user || env.MYSQL_USER || env.MYSQLUSER || env.USER || "root";
    password ||= options.password || options.pass || env.MYSQL_PASSWORD || env.MYSQLPASSWORD || env.PASSWORD || "";
  } else {
    hostname ||= options.hostname || options.host || env.MARIADB_HOST || env.MARIADBHOST || "localhost";
    port ||= Number(options.port || env.MARIADB_PORT || env.MARIADBPORT || "3306");
    username ||= options.username || options.user || env.MARIADB_USER || env.MARIADBUSER || env.USER || "root";
    password ||=
      options.password || options.pass || env.MARIADB_PASSWORD || env.MARIADBPASSWORD || env.PASSWORD || "";
  }

  let database;
  if (adapter === "postgres") {
    database =
      options.database ||
      options.db ||
      env.PG_DATABASE ||
      env.PGDATABASE ||
      decodeURLPart((url?.pathname ?? "").slice(1)) ||
      username;
  } else if (adapter === "mysql") {
    database =
      options.database ||
      options.db ||
      env.MYSQL_DATABASE ||
      env.MYSQLDATABASE ||
      decodeURLPart((url?.pathname ?? "").slice(1)) ||
      "mysql";
  } else {
    database =
      options.database ||
      options.db ||
      env.MARIADB_DATABASE ||
      env.MARIADBDATABASE ||
      decodeURLPart((url?.pathname ?? "").slice(1)) ||
      "mariadb";
  }

  if (options.connection && typeof options.connection === "object") {
    for (const key in options.connection) {
      if (options.connection[key] !== undefined) query += `${key}\0${options.connection[key]}\0`;
    }
  }

  let tlsOptions = options.tls || options.ssl;
  const idleTimeout = validateDurationOption(
    "options.idle_timeout",
    options.idleTimeout ?? options.idle_timeout,
  );
  const connectionTimeout = validateDurationOption(
    "options.connection_timeout",
    options.connectionTimeout ??
      options.connection_timeout ??
      options.connectTimeout ??
      options.connect_timeout,
  );
  const maxLifetime = validateDurationOption(
    "options.max_lifetime",
    options.maxLifetime ?? options.max_lifetime,
  );

  let max = options.max;
  if (max != null) {
    max = Number(max);
    if (max > 2 ** 31 || max < 1 || Number.isNaN(max)) {
      throw invalidSQLArgument("options.max", max, "must be a non-negative integer between 1 and 2^31");
    }
  }

  let prepare = true;
  if (options.prepare === false) {
    if (adapter === "mysql") {
      throw invalidSQLArgument("options.prepare", false, "prepared: false is not supported in MySQL");
    }
    prepare = false;
  }

  for (const callbackName of ["onconnect", "onclose"]) {
    if (options[callbackName] !== undefined && typeof options[callbackName] !== "function") {
      const error = new TypeError(`The \"${callbackName}\" argument must be of type function`);
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
  }

  if (sslMode !== SSL_MODE_DISABLE && !tlsOptions?.serverName) {
    tlsOptions = hostname ? { ...(tlsOptions && typeof tlsOptions === "object" ? tlsOptions : {}), serverName: hostname } : tlsOptions || true;
  }
  if (tlsOptions && sslMode === SSL_MODE_DISABLE) sslMode = SSL_MODE_PREFER;

  port = Number(port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw invalidSQLArgument("port", port, "must be a non-negative integer between 1 and 65535");
  }

  const normalized = {
    adapter,
    hostname,
    port,
    username,
    password,
    database,
    tls: tlsOptions,
    prepare,
    bigint: options.bigint,
    sslMode,
    query,
    max: max || 10,
  };
  if (idleTimeout != null) normalized.idleTimeout = idleTimeout;
  if (connectionTimeout != null) normalized.connectionTimeout = connectionTimeout;
  if (maxLifetime != null) normalized.maxLifetime = maxLifetime;
  if (options.onconnect !== undefined) normalized.onconnect = options.onconnect;
  if (options.onclose !== undefined) normalized.onclose = options.onclose;
  if (path && existsSync(path)) normalized.path = path;
  return normalized;
}

function resolveSQLConfiguration(first, second = {}) {
  let options;
  let resolvedURL = null;
  let sslMode = null;
  let environmentAdapter = null;

  if (typeof first === "string" || first instanceof URL) {
    options = { ...(second && typeof second === "object" ? second : {}) };
    resolvedURL = first;
  } else {
    options = {
      ...(first && typeof first === "object" ? first : {}),
      ...(second && typeof second === "object" ? second : {}),
    };
    const environment = environmentConnectionDetails(options.adapter);
    resolvedURL = environment.url;
    sslMode = environment.sslMode;
    environmentAdapter = environment.adapter;
  }

  if (options.adapter != null && !SUPPORTED_ADAPTERS.includes(options.adapter)) {
    throw new Error(
      "Unsupported adapter: " +
        options.adapter +
        '. Supported adapters: "postgres", "sqlite", "mysql", "mariadb"',
    );
  }

  if (options.adapter === "sqlite") {
    if (options.filename) resolvedURL = options.filename;
  } else if (!options.adapter) {
    if (options.filename) resolvedURL = options.filename;
    else if (options.url) resolvedURL = options.url;
  } else if (options.url) {
    resolvedURL = options.url;
  }

  if (options.adapter === "sqlite") {
    return { adapter: "sqlite", options: parseSQLiteOptions(resolvedURL, options), url: resolvedURL };
  }
  if (!options.adapter && resolvedURL !== null && parseDefinitelySQLiteURL(resolvedURL) !== null) {
    return {
      adapter: "sqlite",
      options: parseSQLiteOptions(resolvedURL, { ...options, adapter: "sqlite" }),
      url: resolvedURL,
    };
  }

  let protocol = options.adapter || "postgres";
  let urlToProcess = resolvedURL;
  if (urlToProcess instanceof URL) {
    protocol = urlToProcess.protocol.replace(/:$/, "");
  } else if (urlToProcess !== null) {
    if (String(urlToProcess).includes("://")) {
      try {
        urlToProcess = new URL(String(urlToProcess));
        protocol = urlToProcess.protocol.replace(/:$/, "");
      } catch (error) {
        if (options.adapter && String(urlToProcess).includes("sqlite")) {
          throw new Error(
            `Invalid URL '${urlToProcess}' for ${options.adapter}. Did you mean to specify \`{ adapter: "sqlite" }\`?`,
            { cause: error },
          );
        }
        throw error;
      }
    } else {
      urlToProcess = new URL(`${protocol}://${urlToProcess}`);
    }
  }

  if (options.adapter === undefined && environmentAdapter !== null) options.adapter = environmentAdapter;
  if (!options.adapter) {
    const inferred = adapterFromProtocol(protocol);
    if (!inferred) {
      throw new Error(
        `Unsupported protocol: ${protocol}. Supported adapters: "postgres", "sqlite", "mysql", "mariadb"`,
      );
    }
    options.adapter = inferred;
  }

  return {
    adapter: options.adapter,
    options: normalizeNetworkOptions(urlToProcess, options, sslMode),
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
  return createMySQLSQL(configuration.options);
}

SQL.SQLiteError = SQLiteError;
SQL.MySQLError = MySQLError;
