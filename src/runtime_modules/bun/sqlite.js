import { DatabaseSync } from "../node/sqlite.js";

const cachedCount = Symbol.for("Bun.Database.cache.count");
const isTypedArray = ArrayBuffer.isView;

export const constants = Object.freeze({
  SQLITE_OPEN_READONLY: 0x00000001,
  SQLITE_OPEN_READWRITE: 0x00000002,
  SQLITE_OPEN_CREATE: 0x00000004,
  SQLITE_OPEN_DELETEONCLOSE: 0x00000008,
  SQLITE_OPEN_EXCLUSIVE: 0x00000010,
  SQLITE_OPEN_AUTOPROXY: 0x00000020,
  SQLITE_OPEN_URI: 0x00000040,
  SQLITE_OPEN_MEMORY: 0x00000080,
  SQLITE_OPEN_MAIN_DB: 0x00000100,
  SQLITE_OPEN_TEMP_DB: 0x00000200,
  SQLITE_OPEN_TRANSIENT_DB: 0x00000400,
  SQLITE_OPEN_MAIN_JOURNAL: 0x00000800,
  SQLITE_OPEN_TEMP_DB_JOURNAL: 0x00001000,
  SQLITE_OPEN_TEMP_JOURNAL: 0x00001000,
  SQLITE_OPEN_SUBJOURNAL: 0x00002000,
  SQLITE_OPEN_SUPER_JOURNAL: 0x00004000,
  SQLITE_OPEN_NOMUTEX: 0x00008000,
  SQLITE_OPEN_FULLMUTEX: 0x00010000,
  SQLITE_OPEN_SHAREDCACHE: 0x00020000,
  SQLITE_OPEN_PRIVATECACHE: 0x00040000,
  SQLITE_OPEN_WAL: 0x00080000,
  SQLITE_OPEN_NOFOLLOW: 0x01000000,
  SQLITE_OPEN_EXRESCODE: 0x02000000,
  SQLITE_PREPARE_PERSISTENT: 0x01,
  SQLITE_PREPARE_NORMALIZE: 0x02,
  SQLITE_PREPARE_NO_VTAB: 0x04,
  SQLITE_DESERIALIZE_READONLY: 0x00000004,
  SQLITE_FCNTL_LOCKSTATE: 1,
  SQLITE_FCNTL_GET_LOCKPROXYFILE: 2,
  SQLITE_FCNTL_SET_LOCKPROXYFILE: 3,
  SQLITE_FCNTL_LAST_ERRNO: 4,
  SQLITE_FCNTL_SIZE_HINT: 5,
  SQLITE_FCNTL_CHUNK_SIZE: 6,
  SQLITE_FCNTL_FILE_POINTER: 7,
  SQLITE_FCNTL_SYNC_OMITTED: 8,
  SQLITE_FCNTL_WIN32_AV_RETRY: 9,
  SQLITE_FCNTL_PERSIST_WAL: 10,
  SQLITE_FCNTL_OVERWRITE: 11,
  SQLITE_FCNTL_VFSNAME: 12,
  SQLITE_FCNTL_POWERSAFE_OVERWRITE: 13,
  SQLITE_FCNTL_PRAGMA: 14,
  SQLITE_FCNTL_BUSYHANDLER: 15,
  SQLITE_FCNTL_TEMPFILENAME: 16,
  SQLITE_FCNTL_MMAP_SIZE: 18,
  SQLITE_FCNTL_TRACE: 19,
  SQLITE_FCNTL_HAS_MOVED: 20,
  SQLITE_FCNTL_SYNC: 21,
  SQLITE_FCNTL_COMMIT_PHASETWO: 22,
  SQLITE_FCNTL_WIN32_SET_HANDLE: 23,
  SQLITE_FCNTL_WAL_BLOCK: 24,
  SQLITE_FCNTL_ZIPVFS: 25,
  SQLITE_FCNTL_RBU: 26,
  SQLITE_FCNTL_VFS_POINTER: 27,
  SQLITE_FCNTL_JOURNAL_POINTER: 28,
  SQLITE_FCNTL_WIN32_GET_HANDLE: 29,
  SQLITE_FCNTL_PDB: 30,
  SQLITE_FCNTL_BEGIN_ATOMIC_WRITE: 31,
  SQLITE_FCNTL_COMMIT_ATOMIC_WRITE: 32,
  SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE: 33,
  SQLITE_FCNTL_LOCK_TIMEOUT: 34,
  SQLITE_FCNTL_DATA_VERSION: 35,
  SQLITE_FCNTL_SIZE_LIMIT: 36,
  SQLITE_FCNTL_CKPT_DONE: 37,
  SQLITE_FCNTL_RESERVE_BYTES: 38,
  SQLITE_FCNTL_CKPT_START: 39,
  SQLITE_FCNTL_EXTERNAL_READER: 40,
  SQLITE_FCNTL_CKSM_FILE: 41,
  SQLITE_FCNTL_RESET_CACHE: 42,
});

export class SQLiteError extends Error {
  static [Symbol.hasInstance](instance) {
    return instance?.name === "SQLiteError";
  }

  constructor(message = "SQLite error") {
    super(message);
    this.name = "SQLiteError";
  }
}

function sqliteError(error) {
  if (error && typeof error === "object") {
    if (error.name !== "TypeError" && error.name !== "RangeError") {
      try {
        error.name = "SQLiteError";
      } catch {}
    }
    return error;
  }
  return new SQLiteError(String(error));
}

function bytesFromData(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data ?? ""));
}

function tmpSqlitePath() {
  const env = globalThis.process?.env ?? cottontail.env();
  const base = String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp");
  const dir = `${base.replace(/\/+$/, "")}/cottontail/bun-sqlite`;
  cottontail.mkdirSync(dir, true);
  return `${dir}/db-${Date.now()}-${Math.floor(Math.random() * 1000000)}.sqlite`;
}

function normalizeOpenFlags(filename, options) {
  if (typeof options === "number") return options | constants.SQLITE_OPEN_URI;
  let flags = constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE | constants.SQLITE_OPEN_URI;
  if (options && typeof options === "object") {
    if ("readOnly" in options) throw new TypeError('Misspelled option "readOnly" should be "readonly"');
    flags = constants.SQLITE_OPEN_URI;
    if (options.readonly) flags |= constants.SQLITE_OPEN_READONLY;
    if (options.create) flags |= constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE;
    if (options.readwrite) flags |= constants.SQLITE_OPEN_READWRITE;
    if ((flags & (constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_READWRITE)) === 0) {
      flags |= constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_CREATE;
    }
  }
  const anonymous = filename === "" || filename === ":memory:";
  if (anonymous && (flags & constants.SQLITE_OPEN_READONLY) !== 0) {
    throw new Error("Cannot open an anonymous database in read-only mode.");
  }
  return flags;
}

function rowValues(row, names) {
  return names.map((name) => row?.[name]);
}

export class Statement {
  constructor(database, statement) {
    this.database = database;
    this._statement = statement;
    this.isFinalized = false;
    this._classType = null;
    this._safeIntegers = Boolean(database._safeIntegers);
    this._statement.setReadBigInts?.(this._safeIntegers);
    this.get = (...args) => this._shapeRow(this._run("get", args));
    this.all = (...args) => this._run("all", args).map((row) => this._shapeRow(row));
    this.iterate = function *(...args) {
      for (const row of this.all(...args)) yield row;
    };
    this.values = (...args) => this._run("all", args).map((row) => rowValues(row, this.columnNames));
    this.raw = (...args) => this.values(...args);
    this.run = (...args) => this._run("run", args);
  }

  _assertActive() {
    if (this.isFinalized || this._statement == null) throw new SQLiteError("SQLite statement is finalized");
    this.database._assertOpen();
  }

  _run(method, args) {
    this._assertActive();
    try {
      return this._statement[method](...args);
    } catch (error) {
      throw sqliteError(error);
    }
  }

  _columns() {
    this._assertActive();
    return this._statement.columns();
  }

  _shapeRow(row) {
    if (row == null || this._classType == null) return row;
    return Object.assign(new this._classType(), row);
  }

  get native() {
    return this._statement;
  }

  get paramsCount() {
    return Number(this._statement?.paramsCount ?? 0);
  }

  get columnNames() {
    return this._columns().map((column) => column.name);
  }

  get columnTypes() {
    return this._columns().map((column) => column.type || "");
  }

  get declaredTypes() {
    return this.columnTypes;
  }

  safeIntegers(updatedValue = undefined) {
    if (updatedValue === undefined) return this._safeIntegers;
    this._safeIntegers = Boolean(updatedValue);
    this._statement?.setReadBigInts?.(this._safeIntegers);
    return this;
  }

  as(ClassType) {
    if (typeof ClassType !== "function") throw new TypeError("Statement.as requires a constructor");
    this._classType = ClassType;
    return this;
  }

  finalize() {
    if (this.isFinalized) return undefined;
    this._statement?.finalize();
    this._statement = null;
    this.isFinalized = true;
    return undefined;
  }

  toJSON() {
    return {
      sql: this.toString(),
      isFinalized: this.isFinalized,
      paramsCount: this.paramsCount,
      columnNames: this.isFinalized ? [] : this.columnNames,
    };
  }

  toString() {
    return String(this._statement?.expandedSQL ?? this._statement?.sourceSQL ?? "");
  }

  *[Symbol.iterator]() {
    yield* this.iterate();
  }

  [Symbol.dispose]() {
    if (!this.isFinalized) this.finalize();
  }
}

function queryCacheEntry(db, query) {
  for (let index = 0; index < db._cachedQueriesKeys.length; index += 1) {
    if (db._cachedQueriesKeys[index] === query) return index;
  }
  return -1;
}

function transactionController(db) {
  if (db._transactionController) return db._transactionController;
  const shared = {
    commit: db.prepare("COMMIT"),
    rollback: db.prepare("ROLLBACK"),
    savepoint: db.prepare("SAVEPOINT `\t_bs3.\t`"),
    release: db.prepare("RELEASE `\t_bs3.\t`"),
    rollbackTo: db.prepare("ROLLBACK TO `\t_bs3.\t`"),
  };
  db._transactionController = {
    default: Object.assign({ begin: db.prepare("BEGIN") }, shared),
    deferred: Object.assign({ begin: db.prepare("BEGIN DEFERRED") }, shared),
    immediate: Object.assign({ begin: db.prepare("BEGIN IMMEDIATE") }, shared),
    exclusive: Object.assign({ begin: db.prepare("BEGIN EXCLUSIVE") }, shared),
  };
  return db._transactionController;
}

function wrapTransaction(fn, db, controller) {
  return function transaction(...args) {
    const nested = db.inTransaction;
    const begin = nested ? controller.savepoint : controller.begin;
    const commit = nested ? controller.release : controller.commit;
    const rollback = nested ? controller.rollbackTo : controller.rollback;
    try {
      begin.run();
      const result = fn.apply(this, args);
      commit.run();
      return result;
    } catch (error) {
      try {
        rollback.run();
        if (nested) controller.release.run();
      } catch {}
      throw error;
    }
  };
}

export class Database {
  static MAX_QUERY_CACHE_SIZE = 20;

  static open(filename, options = undefined) {
    return new Database(filename, options);
  }

  static deserialize(serialized, options = false) {
    return new Database(serialized, typeof options === "boolean" ? { readonly: options } : options);
  }

  static setCustomSQLite(_path) {
    globalThis.__cottontailCustomSQLitePath = String(_path);
    return undefined;
  }

  constructor(filenameGiven = ":memory:", options = undefined) {
    let filename;
    let openOptions = options;
    if (isTypedArray(filenameGiven) || filenameGiven instanceof ArrayBuffer) {
      filename = tmpSqlitePath();
      cottontail.writeFile(filename, bytesFromData(filenameGiven));
      openOptions = {
        ...(typeof options === "object" && options ? options : {}),
        readonly: typeof options === "boolean" ? options : options?.readonly,
      };
    } else if (filenameGiven == null) {
      filename = ":memory:";
    } else if (typeof filenameGiven === "string") {
      filename = filenameGiven.trim() || ":memory:";
    } else {
      throw new TypeError(`Expected 'filename' to be a string, got '${typeof filenameGiven}'`);
    }

    const flags = normalizeOpenFlags(filename, openOptions);
    this.filename = filename;
    this._cachedQueriesKeys = [];
    this._cachedQueriesValues = [];
    this._transactionController = null;
    this._hasClosed = false;
    this._safeIntegers = Boolean(openOptions && typeof openOptions === "object" && openOptions.safeIntegers);
    try {
      this._db = new DatabaseSync(filename === "" ? ":memory:" : filename, {
        allowExtension: true,
        openFlags: flags,
      });
    } catch (error) {
      throw sqliteError(error);
    }
  }

  _assertOpen() {
    if (this._hasClosed || !this._db?.open) throw new SQLiteError("SQLite database is closed");
  }

  get handle() {
    return this._db?.id ?? 0;
  }

  get inTransaction() {
    this._assertOpen();
    return cottontail.sqliteInTransaction(this._db.id) === true;
  }

  get [cachedCount]() {
    return this._cachedQueriesKeys.length;
  }

  loadExtension(name, _entryPoint = undefined) {
    this._assertOpen();
    try {
      return this._db.loadExtension(String(name));
    } catch (error) {
      throw sqliteError(error);
    }
  }

  serialize(name = "main") {
    this._assertOpen();
    try {
      return new Uint8Array(cottontail.sqliteSerialize(this._db.id, String(name)));
    } catch (error) {
      throw sqliteError(error);
    }
  }

  fileControl() {
    this._assertOpen();
    let fileName = null;
    let op;
    let result = null;
    if (arguments.length <= 2) {
      op = arguments[0];
      result = arguments[1] ?? null;
    } else {
      fileName = arguments[0];
      op = arguments[1];
      result = arguments[2] ?? null;
    }
    try {
      return cottontail.sqliteFileControl(this._db.id, fileName, Number(op), result);
    } catch (error) {
      throw sqliteError(error);
    }
  }

  close(throwOnError = false) {
    void throwOnError;
    if (this._hasClosed) return undefined;
    this.clearQueryCache();
    if (this._transactionController) {
      const seen = new Set();
      for (const controller of Object.values(this._transactionController)) {
        for (const statement of Object.values(controller)) {
          if (statement && !seen.has(statement)) {
            seen.add(statement);
            statement.finalize?.();
          }
        }
      }
      this._transactionController = null;
    }
    try {
      this._db.close();
      this._hasClosed = true;
    } catch (error) {
      throw sqliteError(error);
    }
    return undefined;
  }

  clearQueryCache() {
    for (const statement of this._cachedQueriesValues) statement?.finalize?.();
    this._cachedQueriesKeys.length = 0;
    this._cachedQueriesValues.length = 0;
  }

  run(query, ...params) {
    this._assertOpen();
    const statement = this.prepare(String(query));
    try {
      return statement.run(...params);
    } finally {
      statement.finalize();
    }
  }

  exec(query, ...params) {
    return this.run(query, ...params);
  }

  prepare(query, _params = undefined, _flags = 0) {
    this._assertOpen();
    const sql = String(query);
    if (sql.length === 0) throw new Error("SQL query cannot be empty.");
    try {
      return new Statement(this, this._db.prepare(sql));
    } catch (error) {
      throw sqliteError(error);
    }
  }

  query(query) {
    if (typeof query !== "string") throw new TypeError(`Expected 'query' to be a string, got '${typeof query}'`);
    if (query.length === 0) throw new Error("SQL query cannot be empty.");
    const index = queryCacheEntry(this, query);
    if (index !== -1) {
      const cached = this._cachedQueriesValues[index];
      if (!cached.isFinalized) return cached;
      const replacement = this.prepare(query);
      this._cachedQueriesValues[index] = replacement;
      return replacement;
    }
    const statement = this.prepare(query);
    if (this._cachedQueriesKeys.length < Database.MAX_QUERY_CACHE_SIZE) {
      this._cachedQueriesKeys.push(query);
      this._cachedQueriesValues.push(statement);
    }
    return statement;
  }

  transaction(fn, self = undefined) {
    if (typeof fn !== "function") throw new TypeError("Expected first argument to be a function");
    const controller = transactionController(this);
    const properties = {
      default: { value: wrapTransaction(fn, this, controller.default) },
      deferred: { value: wrapTransaction(fn, this, controller.deferred) },
      immediate: { value: wrapTransaction(fn, this, controller.immediate) },
      exclusive: { value: wrapTransaction(fn, this, controller.exclusive) },
      database: { value: this, enumerable: true },
    };
    void self;
    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);
    return properties.default.value;
  }

  [Symbol.dispose]() {
    if (!this._hasClosed) this.close(true);
  }
}

export const __esModule = true;

const defaultExport = {
  __esModule,
  Database,
  SQLiteError,
  Statement,
  constants,
  default: Database,
};

export default defaultExport;
