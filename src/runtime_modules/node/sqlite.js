function sqliteUnavailable() {
  if (typeof cottontail.sqliteOpen !== "function") throw new Error("native SQLite support is unavailable");
}

const sessionConstructorToken = Symbol("sqlite Session constructor token");

function bindArgs(args) {
  if (args.length === 1 && args[0] != null && typeof args[0] === "object" && !Array.isArray(args[0]) && !(args[0] instanceof ArrayBuffer) && !ArrayBuffer.isView(args[0])) {
    return args[0];
  }
  return Array.from(args);
}

const SQLITE_DETERMINISTIC = 0x800;
const SQLITE_DIRECTONLY = 0x80000;

function sqliteArgCount(kind, value, fallback) {
  const argc = Math.trunc(Number(value ?? fallback));
  if (argc !== -1 && (!Number.isFinite(argc) || argc < 0 || argc > 127)) {
    throw new RangeError(`DatabaseSync.${kind} argument count must be between 0 and 127`);
  }
  return argc;
}

function invalidState(message) {
  const error = new Error(message);
  error.code = "ERR_INVALID_STATE";
  return error;
}

function validateSessionOptions(options) {
  if (options == null) {
    if (options === undefined) return {};
    throw new TypeError('The "options" argument must be an object');
  }
  if (typeof options !== "object" && typeof options !== "function") throw new TypeError('The "options" argument must be an object');
  return options;
}

export const constants = {
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5,
  SQLITE_OK: 0,
  SQLITE_DENY: 1,
  SQLITE_IGNORE: 2,
  SQLITE_CREATE_INDEX: 1,
  SQLITE_CREATE_TABLE: 2,
  SQLITE_CREATE_TEMP_INDEX: 3,
  SQLITE_CREATE_TEMP_TABLE: 4,
  SQLITE_CREATE_TEMP_TRIGGER: 5,
  SQLITE_CREATE_TEMP_VIEW: 6,
  SQLITE_CREATE_TRIGGER: 7,
  SQLITE_CREATE_VIEW: 8,
  SQLITE_DELETE: 9,
  SQLITE_DROP_INDEX: 10,
  SQLITE_DROP_TABLE: 11,
  SQLITE_DROP_TEMP_INDEX: 12,
  SQLITE_DROP_TEMP_TABLE: 13,
  SQLITE_DROP_TEMP_TRIGGER: 14,
  SQLITE_DROP_TEMP_VIEW: 15,
  SQLITE_DROP_TRIGGER: 16,
  SQLITE_DROP_VIEW: 17,
  SQLITE_INSERT: 18,
  SQLITE_PRAGMA: 19,
  SQLITE_READ: 20,
  SQLITE_SELECT: 21,
  SQLITE_TRANSACTION: 22,
  SQLITE_UPDATE: 23,
  SQLITE_ATTACH: 24,
  SQLITE_DETACH: 25,
  SQLITE_ALTER_TABLE: 26,
  SQLITE_REINDEX: 27,
  SQLITE_ANALYZE: 28,
  SQLITE_CREATE_VTABLE: 29,
  SQLITE_DROP_VTABLE: 30,
  SQLITE_FUNCTION: 31,
  SQLITE_SAVEPOINT: 32,
  SQLITE_COPY: 0,
  SQLITE_RECURSIVE: 33,
};

export class StatementSync {
  constructor(database, native) {
    this.database = database;
    this.id = native.id;
    this.sourceSQL = native.sourceSQL;
    this.paramsCount = Number(native.paramsCount ?? 0);
    this.readBigInts = false;
  }

  get expandedSQL() {
    return this.sourceSQL;
  }

  all(...args) {
    this.database._assertOpen();
    return cottontail.sqliteStatementAll(this.id, bindArgs(args), this.readBigInts);
  }

  get(...args) {
    this.database._assertOpen();
    return cottontail.sqliteStatementGet(this.id, bindArgs(args), this.readBigInts);
  }

  run(...args) {
    this.database._assertOpen();
    return cottontail.sqliteStatementRun(this.id, bindArgs(args));
  }

  *iterate(...args) {
    for (const row of this.all(...args)) yield row;
  }

  columns() {
    this.database._assertOpen();
    return cottontail.sqliteStatementColumns(this.id);
  }

  finalize() {
    if (this.id != null) cottontail.sqliteStatementFinalize(this.id);
    this.id = null;
  }

  setAllowBareNamedParameters() { return this; }
  setAllowUnknownNamedParameters() { return this; }
  setReadBigInts(value = true) {
    this.readBigInts = Boolean(value);
    return this;
  }
  setReturnArrays() { return this; }
}

class SQLTagStore {
  constructor(database, maxSize = 1000) {
    this.db = database;
    this.capacity = typeof maxSize === "number" ? Math.max(0, Math.trunc(maxSize)) : 1000;
    this.cache = new Map();
  }

  _sql(strings) {
    if (!Array.isArray(strings) && strings?.raw == null) throw new TypeError("SQLTagStore methods must be used as template tags");
    return Array.from(strings).join("?");
  }

  _statement(strings) {
    this.db._assertOpen();
    const sql = this._sql(strings);
    if (this.capacity === 0) return { statement: this.db.prepare(sql), cached: false };
    const existing = this.cache.get(sql);
    if (existing) {
      this.cache.delete(sql);
      this.cache.set(sql, existing);
      return { statement: existing, cached: true };
    }
    const statement = this.db.prepare(sql);
    this.cache.set(sql, statement);
    while (this.cache.size > this.capacity) {
      const oldest = this.cache.keys().next().value;
      const evicted = this.cache.get(oldest);
      this.cache.delete(oldest);
      evicted?.finalize();
    }
    return { statement, cached: true };
  }

  _use(strings, values, method) {
    const { statement, cached } = this._statement(strings);
    try {
      return statement[method](...values);
    } finally {
      if (!cached) statement.finalize();
    }
  }

  run(strings, ...values) {
    return this._use(strings, values, "run");
  }

  get(strings, ...values) {
    return this._use(strings, values, "get");
  }

  all(strings, ...values) {
    return this._use(strings, values, "all");
  }

  *iterate(strings, ...values) {
    const { statement, cached } = this._statement(strings);
    try {
      yield* statement.iterate(...values);
    } finally {
      if (!cached) statement.finalize();
    }
  }

  clear() {
    for (const statement of this.cache.values()) statement.finalize();
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

export class DatabaseSync {
  constructor(location = ":memory:", options = {}) {
    sqliteUnavailable();
    this.location = String(location);
    this.options = { ...options };
    const native = cottontail.sqliteOpen(this.location, this.options.allowExtension === true, this.options.openFlags ?? null);
    this.id = native.id;
    this.open = true;
  }

  _assertOpen() {
    if (!this.open) throw new Error("SQLite database is closed");
  }

  close() {
    if (!this.open) return;
    cottontail.sqliteClose(this.id);
    this.open = false;
  }

  exec(sql) {
    this._assertOpen();
    cottontail.sqliteExec(this.id, String(sql));
  }

  prepare(sql) {
    this._assertOpen();
    return new StatementSync(this, cottontail.sqlitePrepare(this.id, String(sql)));
  }

  function(name, options = {}, fn = undefined) {
    this._assertOpen();
    if (typeof options === "function") {
      fn = options;
      options = {};
    }
    if (typeof fn !== "function") throw new TypeError("DatabaseSync.function requires a callback");
    const normalizedOptions = options ?? {};
    const argc = normalizedOptions.varargs === true ? -1 : sqliteArgCount("function", normalizedOptions.arguments, fn.length);
    let flags = 0;
    if (normalizedOptions.deterministic) flags |= SQLITE_DETERMINISTIC;
    if (normalizedOptions.directOnly) flags |= SQLITE_DIRECTONLY;
    cottontail.sqliteCreateFunction(this.id, String(name), argc, flags, fn);
  }

  aggregate(name, options = {}) {
    this._assertOpen();
    const normalizedOptions = options ?? {};
    if (normalizedOptions.start === undefined) throw new TypeError('The "options.start" argument must be a function or a primitive value');
    if (typeof normalizedOptions.step !== "function") throw new TypeError('The "options.step" argument must be a function');
    if (normalizedOptions.inverse !== undefined && typeof normalizedOptions.inverse !== "function") throw new TypeError('The "options.inverse" argument must be a function');
    const argc = normalizedOptions.varargs === true ? -1 : sqliteArgCount("aggregate", normalizedOptions.arguments, Math.max(0, normalizedOptions.step.length - 1));
    let flags = 0;
    if (normalizedOptions.deterministic) flags |= SQLITE_DETERMINISTIC;
    if (normalizedOptions.directOnly) flags |= SQLITE_DIRECTONLY;
    const result = typeof normalizedOptions.result === "function" ? normalizedOptions.result : null;
    const inverse = typeof normalizedOptions.inverse === "function" ? normalizedOptions.inverse : null;
    cottontail.sqliteCreateAggregate(this.id, String(name), argc, flags, normalizedOptions.start, normalizedOptions.step, result, inverse);
  }

  createTagStore(maxSize = 1000) {
    this._assertOpen();
    return new SQLTagStore(this, maxSize);
  }

  createSession() {
    this._assertOpen();
    const options = validateSessionOptions(arguments[0]);
    const native = cottontail.sqliteSessionCreate(this.id, options.db ?? "main", options.table ?? null);
    return new Session(native, this, sessionConstructorToken);
  }

  applyChangeset(changeset, options = {}) {
    this._assertOpen();
    const normalizedOptions = validateSessionOptions(options);
    const filter = typeof normalizedOptions.filter === "function" ? normalizedOptions.filter : null;
    const onConflict = typeof normalizedOptions.onConflict === "function" ? normalizedOptions.onConflict : null;
    return cottontail.sqliteApplyChangeset(this.id, changeset, filter, onConflict);
  }

  enableLoadExtension(enabled = true) {
    this._assertOpen();
    cottontail.sqliteEnableLoadExtension(this.id, Boolean(enabled));
  }

  loadExtension(path) {
    this._assertOpen();
    cottontail.sqliteLoadExtension(this.id, String(path));
  }

  setAuthorizer(callback) {
    this._assertOpen();
    if (callback != null && typeof callback !== "function") throw new TypeError("DatabaseSync.setAuthorizer requires a function or null");
    cottontail.sqliteSetAuthorizer(this.id, callback ?? null);
  }
}

export class Session {
  constructor(native = undefined, database = undefined, token = undefined) {
    if (token !== sessionConstructorToken) {
      const error = new Error("Illegal constructor");
      error.code = "ERR_ILLEGAL_CONSTRUCTOR";
      throw error;
    }
    this.id = Number(native?.id);
    this.database = database;
    this.open = true;
  }

  _assertOpen() {
    if (!this.open || this.id == null) throw invalidState("session is not open");
    this.database?._assertOpen();
  }

  changeset() {
    this._assertOpen();
    return new Uint8Array(cottontail.sqliteSessionChangeset(this.id, false));
  }

  patchset() {
    this._assertOpen();
    return new Uint8Array(cottontail.sqliteSessionChangeset(this.id, true));
  }

  close() {
    if (!this.open || this.id == null) return;
    cottontail.sqliteSessionClose(this.id);
    this.id = null;
    this.open = false;
  }
}

export function backup(sourceDb, path) {
  if (!(sourceDb instanceof DatabaseSync)) throw new TypeError("backup source must be a DatabaseSync");
  sourceDb._assertOpen();
  return Promise.resolve(cottontail.sqliteBackup(sourceDb.id, String(path)));
}

export default {
  DatabaseSync,
  Session,
  StatementSync,
  backup,
  constants,
};
