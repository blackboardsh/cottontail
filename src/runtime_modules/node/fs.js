import "../bun/ffi.js";
import constantsObject from "./constants.js";
import { dirname, join, resolve } from "./path.js";
import { Readable, Writable } from "./stream.js";
import {
  encodingFromOptions,
  invalidArgType,
  invalidArgValue,
  outOfRange,
  runAbortable,
  validateAbortSignal,
  validateBufferRange,
  validateFd,
  validateInteger,
  validatePosition,
} from "./fs/internal.js";
import { cpSyncImpl, normalizeCopyPath } from "./fs/cp.js";
// Imported last so constants/path/stream are initialized before the circular
// fs <-> fs/promises edge is evaluated. `fs.promises` must be the exact same
// object as the fs/promises module namespace (Node/Bun behavior relied on by
// upstream tests: require("fs/promises") === require("fs").promises).
import fsPromisesDefault from "./fs/promises.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// fs.constants must be the exact same object as fsPromises.constants. Because
// fs.js and fs/promises.js form an import cycle whose evaluation order depends
// on which module is reached first, both files construct the object through a
// shared global registry: whichever module body runs first creates it and the
// other reuses it. Keep the name list below in sync with fs/promises.js.
const fsConstantNames = [
  "UV_FS_SYMLINK_DIR",
  "UV_FS_SYMLINK_JUNCTION",
  "O_RDONLY",
  "O_WRONLY",
  "O_RDWR",
  "UV_DIRENT_UNKNOWN",
  "UV_DIRENT_FILE",
  "UV_DIRENT_DIR",
  "UV_DIRENT_LINK",
  "UV_DIRENT_FIFO",
  "UV_DIRENT_SOCKET",
  "UV_DIRENT_CHAR",
  "UV_DIRENT_BLOCK",
  "S_IFMT",
  "S_IFREG",
  "S_IFDIR",
  "S_IFCHR",
  "S_IFBLK",
  "S_IFIFO",
  "S_IFLNK",
  "S_IFSOCK",
  "O_CREAT",
  "O_EXCL",
  "UV_FS_O_FILEMAP",
  "O_NOCTTY",
  "O_TRUNC",
  "O_APPEND",
  "O_DIRECTORY",
  "O_NOFOLLOW",
  "O_SYNC",
  "O_DSYNC",
  "O_SYMLINK",
  "O_NONBLOCK",
  "S_IRWXU",
  "S_IRUSR",
  "S_IWUSR",
  "S_IXUSR",
  "S_IRWXG",
  "S_IRGRP",
  "S_IWGRP",
  "S_IXGRP",
  "S_IRWXO",
  "S_IROTH",
  "S_IWOTH",
  "S_IXOTH",
  "F_OK",
  "R_OK",
  "W_OK",
  "X_OK",
  "UV_FS_COPYFILE_EXCL",
  "COPYFILE_EXCL",
  "UV_FS_COPYFILE_FICLONE",
  "COPYFILE_FICLONE",
  "UV_FS_COPYFILE_FICLONE_FORCE",
  "COPYFILE_FICLONE_FORCE",
];

export const constants = globalThis.__cottontailFsConstants ??= Object.freeze(Object.fromEntries(
  fsConstantNames
    .filter((name) => Object.prototype.hasOwnProperty.call(constantsObject, name))
    .map((name) => [name, constantsObject[name]]),
));

export const F_OK = constants.F_OK ?? 0;
export const R_OK = constants.R_OK ?? 4;
export const W_OK = constants.W_OK ?? 2;
export const X_OK = constants.X_OK ?? 1;

function normalizePath(path) {
  if (path instanceof Uint8Array) {
    const decoded = decoder.decode(path);
    if (decoded.includes("\0")) throw invalidArgValue("path", decoded, "must be a string without null bytes");
    return decoded;
  }
  if (path && typeof path === "object" && typeof path.href === "string" && path.protocol === "file:") {
    path = normalizeFileUrlPath(path);
    if (path.includes("\0")) throw invalidArgValue("path", path, "must be a string without null bytes");
    return path;
  }
  if (typeof path === "string" && path.startsWith("file:")) {
    let url;
    try {
      url = new URL(path);
    } catch {
      // Let the filesystem report malformed file: strings as ordinary paths.
    }
    if (url?.protocol === "file:") {
      path = normalizeFileUrlPath(url);
      if (path.includes("\0")) throw invalidArgValue("path", path, "must be a string without null bytes");
      return path;
    }
  }
  const normalized = String(path);
  if (normalized.includes("\0")) throw invalidArgValue("path", normalized, "must be a string without null bytes");
  return normalized;
}

function normalizeFileUrlPath(url) {
  let pathname = decodeURIComponent(url.pathname);
  if (globalThis.process?.platform === "win32" && /^\/[A-Za-z]:/.test(pathname)) {
    pathname = pathname.slice(1).replaceAll("/", "\\");
  }
  return pathname;
}

const knownErrorCodes = [
  "EPERM", "ENOENT", "EIO", "EBADF", "EACCES", "EEXIST", "EXDEV", "ENOTDIR",
  "EISDIR", "EINVAL", "ENFILE", "EMFILE", "EROFS", "EPIPE", "ENOTEMPTY", "ELOOP",
  "ENAMETOOLONG", "ENOSPC", "EFBIG", "EAGAIN", "EBUSY", "EMLINK", "ENODEV", "ENXIO",
  "ENOSYS", "ENOTSUP", "EOPNOTSUPP",
];

const messageByCode = {
  EPERM: "operation not permitted",
  ENOENT: "no such file or directory",
  EBADF: "bad file descriptor",
  EACCES: "permission denied",
  EEXIST: "file already exists",
  ENOTDIR: "not a directory",
  EISDIR: "illegal operation on a directory",
  EINVAL: "invalid argument",
  ENOSYS: "function not implemented",
  ENOTSUP: "operation not supported",
  EOPNOTSUPP: "operation not supported",
};

function makeFsError(error, path, syscall = "open") {
  const hasPath = path !== undefined;
  const normalizedPath = hasPath ? normalizePath(path) : undefined;
  const source = String(error?.message ?? error ?? "");
  let code = String(error?.code ?? "");
  if (!knownErrorCodes.includes(code)) {
    code = knownErrorCodes.find((candidate) => source.includes(candidate)) ?? "";
  }
  if (!code) {
    if (source.includes("No such file or directory") || source.includes("FileNotFound")) code = "ENOENT";
    else if (source.includes("Permission denied") || source.includes("access denied") || source.includes("AccessDenied")) code = "EACCES";
    else if (source.includes("already exists") || source.includes("File exists") || source.includes("PathAlreadyExists")) code = "EEXIST";
    else if (source.includes("Not a directory") || source.includes("NotDir")) code = "ENOTDIR";
    else if (source.includes("Is a directory") || source.includes("IsDir")) code = "EISDIR";
    else if (source.includes("Directory not empty") || source.includes("DirNotEmpty")) code = "ENOTEMPTY";
    else if (source.includes("Bad file descriptor")) code = "EBADF";
    else if (source.includes("Device not configured") || source.includes("No such device or address") || source.includes("NoDevice")) code = "ENXIO";
    else if (source.includes("Operation not supported") || source.includes("Not supported")) code = "ENOTSUP";
    else if (source.includes("Function not implemented")) code = "ENOSYS";
    else code = "EIO";
  }
  const reason = messageByCode[code] ?? (source || code);
  const out = new Error(`${code}: ${reason}, ${syscall}${hasPath ? ` '${normalizedPath}'` : ""}`);
  out.errno = -(Number(constantsObject[code]) || 5);
  out.code = code;
  out.syscall = syscall;
  if (hasPath) out.path = normalizedPath;
  return out;
}

function makeFdError(error, fd, syscall) {
  const out = makeFsError(error, undefined, syscall);
  out.fd = fd;
  return out;
}

function describeReceived(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `type string ('${value}')`;
  if (typeof value === "object") return `an instance of ${value.constructor?.name ?? "Object"}`;
  return `type ${typeof value} (${String(value)})`;
}

function makeInvalidCallbackError(name, value) {
  const error = new TypeError(
    `The "${name}" argument must be of type function. Received ${describeReceived(value)}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function makeInvalidArgTypeError(name, expected, value) {
  const error = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function validatePathArg(path, name = "path") {
  if (typeof path === "string") return;
  if (path instanceof Uint8Array) return;
  if (path && typeof path === "object" && typeof path.href === "string" && typeof path.protocol === "string") return;
  throw makeInvalidArgTypeError(name, "of type string or an instance of Buffer or URL", path);
}

function normalizeEncoding(options, fallback = undefined) {
  return encodingFromOptions(options, fallback);
}

function bufferFrom(bytes) {
  return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : makeBuffer(bytes);
}

function makeBuffer(arrayBufferOrView) {
  // Return a real Buffer so prototype patches (e.g. upstream harness.ts's
  // Buffer.prototype.toUnixString) reach fs results.
  if (globalThis.Buffer?.from) {
    if (arrayBufferOrView instanceof ArrayBuffer) return globalThis.Buffer.from(new Uint8Array(arrayBufferOrView));
    if (ArrayBuffer.isView(arrayBufferOrView)) {
      return globalThis.Buffer.from(new Uint8Array(arrayBufferOrView.buffer, arrayBufferOrView.byteOffset, arrayBufferOrView.byteLength));
    }
    return globalThis.Buffer.from(arrayBufferOrView ?? new Uint8Array(0));
  }
  const bytes = arrayBufferOrView instanceof ArrayBuffer
    ? new Uint8Array(arrayBufferOrView)
    : ArrayBuffer.isView(arrayBufferOrView)
      ? new Uint8Array(arrayBufferOrView.buffer, arrayBufferOrView.byteOffset, arrayBufferOrView.byteLength)
      : new Uint8Array(arrayBufferOrView ?? 0);
  bytes.toString = function toString(encoding = "utf8") {
    if (globalThis.Buffer?.from) return globalThis.Buffer.from(this).toString(encoding);
    if (encoding === "hex") return Array.from(this, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return decoder.decode(this);
  };
  return bytes;
}

function bytesFromData(data, encoding = "utf8") {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") {
    if (String(encoding).toLowerCase() === "hex") {
      const bytes = new Uint8Array(Math.floor(data.length / 2));
      let length = 0;
      for (let index = 0; index + 1 < data.length; index += 2) {
        const high = Number.parseInt(data[index], 16);
        const low = Number.parseInt(data[index + 1], 16);
        if (!Number.isFinite(high) || !Number.isFinite(low)) break;
        bytes[length++] = (high << 4) | low;
      }
      return bytes.subarray(0, length);
    }
    if (globalThis.Buffer?.from) return globalThis.Buffer.from(data, encoding);
    return encoder.encode(data);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

function validateWriteData(data) {
  if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return;
  throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
}

function decodeBytes(bytes, encoding = "utf8") {
  if (encoding === "buffer" || encoding == null) return bufferFrom(bytes);
  if (globalThis.Buffer?.from) return globalThis.Buffer.from(bytes).toString(encoding);
  return decoder.decode(bytes);
}

function allocationLimitForEncoding(encoding) {
  const configured = Number(globalThis.__cottontailSyntheticAllocationLimit);
  if (!Number.isFinite(configured) || configured <= 0) return Number.MAX_SAFE_INTEGER;
  const normalized = String(encoding ?? "buffer").toLowerCase();
  if (normalized === "hex") return configured * 2;
  if (normalized === "base64" || normalized === "base64url") return configured * 3;
  if (normalized === "utf8" || normalized === "utf-8" || normalized === "ucs2" || normalized === "ucs-2" || normalized === "utf16le" || normalized === "utf-16le") {
    return configured * 4;
  }
  return configured;
}

function makeOutOfMemoryError(path = undefined) {
  const suffix = path == null ? "" : `, read '${normalizePath(path)}'`;
  const error = new Error(`ENOMEM: not enough memory${suffix}`);
  error.errno = -(Number(constantsObject.ENOMEM) || 12);
  error.code = "ENOMEM";
  error.syscall = "read";
  if (path != null) error.path = normalizePath(path);
  return error;
}

function readFdToEndSync(fd, options = undefined, path = undefined) {
  const encoding = normalizeEncoding(options);
  validateFd(fd);
  const allocationLimit = allocationLimitForEncoding(encoding);
  try {
    const stats = fstatSync(fd);
    if (stats.isFile() && stats.size > allocationLimit) throw makeOutOfMemoryError(path);
  } catch (error) {
    if (error?.code === "ENOMEM") throw error;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = new Uint8Array(64 * 1024);
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
    if (bytesRead <= 0) break;
    if (total + bytesRead > allocationLimit) throw makeOutOfMemoryError(path);
    chunks.push(chunk.slice(0, bytesRead));
    total += bytesRead;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return encoding ? decodeBytes(out, encoding) : bufferFrom(out);
}

function writeAllToFdSync(fd, data, options = undefined) {
  const encoding = normalizeEncoding(options, "utf8");
  const bytes = bytesFromData(data, encoding);
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(fd, bytes, written, bytes.byteLength - written, null);
    if (count <= 0) break;
    written += count;
  }
}

class FileBlob {
  constructor(parts = [], options = {}) {
    const chunks = parts.map((part) => bytesFromData(part));
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    this.type = String(options?.type ?? "");
    this.size = size;
    this._bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      this._bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  }

  async arrayBuffer() {
    return this._bytes.slice().buffer;
  }

  async text() {
    return decoder.decode(this._bytes);
  }

  slice(start = 0, end = this.size, type = this.type) {
    return new FileBlob([this._bytes.slice(Number(start), Number(end))], { type });
  }
}

function parseMode(mode) {
  return typeof mode === "string" ? parseInt(mode, 8) : Number(mode);
}

function validateOpenInteger(value, name) {
  if (!Number.isInteger(value)) {
    const error = new RangeError(
      `The value of "${name}" is out of range. It must be an integer. Received ${String(value)}`,
    );
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  if (value < 0 || value > 0xffffffff) {
    throw outOfRange(name, ">= 0 and <= 4294967295", value);
  }
  return value;
}

function normalizeOpenFlags(flags) {
  if (typeof flags === "string") return flags;
  if (typeof flags !== "number") throw invalidArgType("flags", "of type string or number", flags);
  return validateOpenInteger(flags, "flags");
}

function normalizeOpenMode(mode) {
  if (typeof mode !== "number" && typeof mode !== "string") {
    throw invalidArgType("mode", "of type number or string", mode);
  }
  return validateOpenInteger(parseMode(mode), "mode");
}

function ensureParent(path) {
  const parent = dirname(path);
  if (parent && parent !== path && !existsSync(parent)) mkdirSync(parent, { recursive: true });
}

function modeMatches(mode, mask) {
  return (Number(mode) & (constants.S_IFMT ?? 0o170000)) === mask;
}

const statsPositionalFields = [
  "dev", "mode", "nlink", "uid", "gid", "rdev", "blksize", "ino", "size", "blocks",
  "atimeMs", "mtimeMs", "ctimeMs", "birthtimeMs",
];

// Node's Stats constructor accepts positional numeric arguments:
// new Stats(dev, mode, nlink, uid, gid, rdev, blksize, ino, size, blocks,
//           atimeMs, mtimeMs, ctimeMs, birthtimeMs)
function normalizeStatsInput(args) {
  if (args.length <= 1 && (args[0] == null || typeof args[0] === "object")) return args[0] ?? {};
  return Object.fromEntries(statsPositionalFields.map((field, index) => [field, args[index]]));
}

export class Stats {
  constructor(...args) {
    const result = normalizeStatsInput(args);
    this._initialize(result);
  }

  _initialize(result = {}) {
    this.dev = result.dev;
    this.ino = result.ino;
    this.mode = result.mode;
    this.nlink = result.nlink;
    this.uid = result.uid;
    this.gid = result.gid;
    this.rdev = result.rdev;
    this.size = result.size;
    this.blksize = result.blksize;
    this.blocks = result.blocks;
    this.atimeMs = result.atimeMs;
    this.mtimeMs = result.mtimeMs;
    this.ctimeMs = result.ctimeMs;
    this.birthtimeMs = result.birthtimeMs;
  }

  isFile() { return modeMatches(this.mode, constants.S_IFREG ?? 0o100000); }
  isDirectory() { return modeMatches(this.mode, constants.S_IFDIR ?? 0o040000); }
  isBlockDevice() { return modeMatches(this.mode, constants.S_IFBLK ?? 0o060000); }
  isCharacterDevice() { return modeMatches(this.mode, constants.S_IFCHR ?? 0o020000); }
  isSymbolicLink() { return modeMatches(this.mode, constants.S_IFLNK ?? 0o120000); }
  isFIFO() { return modeMatches(this.mode, constants.S_IFIFO ?? 0o010000); }
  isSocket() { return modeMatches(this.mode, constants.S_IFSOCK ?? 0o140000); }
}

class BigIntStats {
  constructor(result = {}) {
    this.dev = toBigIntStat(result.dev);
    this.ino = toBigIntStat(result.ino);
    this.mode = toBigIntStat(result.mode);
    this.nlink = toBigIntStat(result.nlink);
    this.uid = toBigIntStat(result.uid);
    this.gid = toBigIntStat(result.gid);
    this.rdev = toBigIntStat(result.rdev);
    this.size = toBigIntStat(result.size);
    this.blksize = toBigIntStat(result.blksize);
    this.blocks = toBigIntStat(result.blocks);
    this.atimeMs = toBigIntStat(result.atimeMs);
    this.mtimeMs = toBigIntStat(result.mtimeMs);
    this.ctimeMs = toBigIntStat(result.ctimeMs);
    this.birthtimeMs = toBigIntStat(result.birthtimeMs);
    this.atimeNs = msToNs(result.atimeMs);
    this.mtimeNs = msToNs(result.mtimeMs);
    this.ctimeNs = msToNs(result.ctimeMs);
    this.birthtimeNs = msToNs(result.birthtimeMs);
  }

  isFile() { return modeMatches(Number(this.mode), constants.S_IFREG ?? 0o100000); }
  isDirectory() { return modeMatches(Number(this.mode), constants.S_IFDIR ?? 0o040000); }
  isBlockDevice() { return modeMatches(Number(this.mode), constants.S_IFBLK ?? 0o060000); }
  isCharacterDevice() { return modeMatches(Number(this.mode), constants.S_IFCHR ?? 0o020000); }
  isSymbolicLink() { return modeMatches(Number(this.mode), constants.S_IFLNK ?? 0o120000); }
  isFIFO() { return modeMatches(Number(this.mode), constants.S_IFIFO ?? 0o010000); }
  isSocket() { return modeMatches(Number(this.mode), constants.S_IFSOCK ?? 0o140000); }
}

function installLazyStatsDates(prototype, bigint = false) {
  for (const [property, milliseconds] of [
    ["atime", "atimeMs"],
    ["mtime", "mtimeMs"],
    ["ctime", "ctimeMs"],
    ["birthtime", "birthtimeMs"],
  ]) {
    Object.defineProperty(prototype, property, {
      get() {
        const raw = this[milliseconds];
        const value = new Date(bigint && typeof raw === "bigint" ? Number(raw) : raw);
        Object.defineProperty(this, property, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return value;
      },
      set(value) {
        Object.defineProperty(this, property, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
      enumerable: true,
      configurable: true,
    });
  }
}

installLazyStatsDates(Stats.prototype);
installLazyStatsDates(BigIntStats.prototype, true);

function toBigIntStat(value) {
  return BigInt(Math.trunc(Number(value) || 0));
}

function msToNs(value) {
  return BigInt(Math.trunc((Number(value) || 0) * 1000000));
}

function wantsBigInt(options) {
  return Boolean(options && typeof options === "object" && options.bigint === true);
}

function shouldSuppressMissing(options) {
  return Boolean(options && typeof options === "object" && options.throwIfNoEntry === false);
}

function makeStats(result, options = undefined) {
  return wantsBigInt(options) ? new BigIntStats(result) : new Stats(result);
}

function makeStatFs(result, options = undefined) {
  if (!wantsBigInt(options)) return result;
  const out = {};
  for (const [key, value] of Object.entries(result ?? {})) out[key] = toBigIntStat(value);
  return out;
}

// Node's Dirent constructor takes a libuv dirent type (UV_DIRENT_*), not a
// file mode. Map those to S_IF* mode bits; UV_DIRENT_UNKNOWN (0) maps to 0 so
// every is*() check returns false.
const uvDirentTypeToMode = [
  0, // UV_DIRENT_UNKNOWN
  0o100000, // UV_DIRENT_FILE -> S_IFREG
  0o040000, // UV_DIRENT_DIR -> S_IFDIR
  0o120000, // UV_DIRENT_LINK -> S_IFLNK
  0o010000, // UV_DIRENT_FIFO -> S_IFIFO
  0o140000, // UV_DIRENT_SOCKET -> S_IFSOCK
  0o020000, // UV_DIRENT_CHAR -> S_IFCHR
  0o060000, // UV_DIRENT_BLOCK -> S_IFBLK
];

export class Dirent {
  #mode;

  constructor(name, typeOrStats, path) {
    this.name = name;
    this.path = path;
    this.parentPath = path;
    this.#mode = typeOrStats instanceof Dirent
      ? typeOrStats.#mode
      : typeof typeOrStats === "object" && typeOrStats !== null
        ? Number(typeOrStats.mode) || 0
      : uvDirentTypeToMode[Number(typeOrStats)] ?? 0;
  }

  isDirectory() { return modeMatches(this.#mode, constants.S_IFDIR ?? 0o040000); }
  isFile() { return modeMatches(this.#mode, constants.S_IFREG ?? 0o100000); }
  isBlockDevice() { return modeMatches(this.#mode, constants.S_IFBLK ?? 0o060000); }
  isCharacterDevice() { return modeMatches(this.#mode, constants.S_IFCHR ?? 0o020000); }
  isSymbolicLink() { return modeMatches(this.#mode, constants.S_IFLNK ?? 0o120000); }
  isFIFO() { return modeMatches(this.#mode, constants.S_IFIFO ?? 0o010000); }
  isSocket() { return modeMatches(this.#mode, constants.S_IFSOCK ?? 0o140000); }
}

Object.defineProperty(Dirent.prototype, Symbol.toStringTag, {
  value: "Dirent",
  configurable: true,
});

function makeDirClosedError() {
  const error = new Error("Directory handle was closed");
  error.code = "ERR_DIR_CLOSED";
  return error;
}

export class Dir {
  constructor(path, options = {}) {
    this.path = normalizePath(path);
    this.options = options ?? {};
    this.closed = false;
    this.entriesList = readdirSync(this.path, { withFileTypes: true });
    this.index = 0;
  }

  read(callback = undefined) {
    if (this.closed) throw makeDirClosedError();
    if (callback !== undefined && typeof callback !== "function") {
      throw makeInvalidCallbackError("callback", callback);
    }
    if (typeof callback === "function") {
      queueMicrotask(() => {
        try { callback(null, this.readSync()); } catch (error) { callback(error); }
      });
      return;
    }
    return Promise.resolve().then(() => this.readSync());
  }

  readSync() {
    if (this.closed) throw makeDirClosedError();
    return this.index < this.entriesList.length ? this.entriesList[this.index++] : null;
  }

  close(callback = undefined) {
    if (this.closed) throw makeDirClosedError();
    if (typeof callback === "function") {
      queueMicrotask(() => {
        try { this.closeSync(); callback(null); } catch (error) { callback(error); }
      });
      return;
    }
    this.closeSync();
    return Promise.resolve();
  }

  closeSync() {
    if (this.closed) throw makeDirClosedError();
    this.closed = true;
  }

  async *entries() {
    while (true) {
      const entry = this.readSync();
      if (entry == null) break;
      yield entry;
    }
  }

  [Symbol.asyncIterator]() {
    return this.entries();
  }
}

export function existsSync(path) {
  try {
    validatePathArg(path);
    return cottontail.existsSync(normalizePath(path));
  } catch {
    return false;
  }
}

export function accessSync(path, mode = F_OK) {
  const normalizedPath = normalizePath(path);
  try {
    cottontail.accessSync(normalizedPath, Number(mode ?? F_OK));
  } catch (error) {
    throw makeFsError(error, normalizedPath, "access");
  }
}

export function readFileSync(path, options = undefined) {
  if (typeof path === "number") return readFdToEndSync(path, options);
  validatePathArg(path);
  normalizeEncoding(options);
  const normalizedPath = normalizePath(path);
  const flag = typeof options === "object" && options?.flag != null ? options.flag : "r";
  let fd;
  try {
    fd = openSync(normalizedPath, flag);
  } catch (error) {
    throw error?.code ? error : makeFsError(error, normalizedPath, "open");
  }
  try {
    return readFdToEndSync(fd, options, normalizedPath);
  } finally {
    closeSync(fd);
  }
}

export function writeFileSync(path, data, options = undefined) {
  normalizeEncoding(options, "utf8");
  validateWriteData(data);
  if (typeof path === "number") {
    writeAllToFdSync(path, data, options);
    return;
  }
  validatePathArg(path);
  const flag = typeof options === "object" && options?.flag != null ? options.flag : "w";
  const encoding = normalizeEncoding(options, "utf8");
  if (typeof flag === "string" && flag.includes("a")) {
    appendFileSync(path, data, options);
    return;
  }
  const normalizedPath = normalizePath(path);
  const mode = typeof options === "object" && options?.mode != null ? parseMode(options.mode) : 0o666;
  const flush = typeof options === "object" && options?.flush != null ? options.flush : false;
  if (typeof flush !== "boolean") throw invalidArgType("flush", "of type boolean", flush);
  const fd = openSync(normalizedPath, flag, mode);
  try {
    writeAllToFdSync(fd, data, { encoding });
    if (flush) fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function appendFileSync(path, data, options = undefined) {
  const encoding = normalizeEncoding(options, "utf8");
  validateWriteData(data);
  const flag = typeof options === "object" && options?.flag != null ? options.flag : "a";
  const mode = typeof options === "object" && options?.mode != null ? parseMode(options.mode) : 0o666;
  const flush = typeof options === "object" && options?.flush != null ? options.flush : false;
  if (typeof flush !== "boolean") throw invalidArgType("flush", "of type boolean", flush);
  const fd = typeof path === "number" ? path : openSync(path, flag, mode);
  try {
    writeSync(fd, bytesFromData(data, encoding));
    if (flush) fsyncSync(fd);
  } finally {
    if (typeof path !== "number") closeSync(fd);
  }
}

export function openSync(path, flags = "r", mode = 0o666) {
  validatePathArg(path);
  const normalizedPath = normalizePath(path);
  flags = normalizeOpenFlags(flags);
  const normalizedMode = normalizeOpenMode(mode ?? 0o666);
  try {
    return cottontail.openFd(normalizedPath, flags ?? "r", normalizedMode);
  } catch (error) {
    throw makeFsError(error, normalizedPath, "open");
  }
}

export function closeSync(fd) {
  fd = validateFd(fd);
  try {
    // COTTONTAIL-COMPAT: the current host close primitive has no return
    // channel, so validate first to preserve Node's EBADF contract.
    cottontail.fstatSync(fd);
    cottontail.closeFd(fd);
  } catch (error) {
    throw makeFdError(error, fd, "close");
  }
}

export function readSync(fd, buffer, offset = 0, length = undefined, position = null) {
  fd = validateFd(fd);
  if (buffer && typeof buffer === "object" && !ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
    position = buffer.position ?? null;
    length = buffer.length;
    offset = buffer.offset ?? 0;
    buffer = buffer.buffer ?? globalThis.Buffer?.alloc?.(16384) ?? new Uint8Array(16384);
  } else if (offset && typeof offset === "object") {
    position = offset.position ?? null;
    length = offset.length;
    offset = offset.offset ?? 0;
  }
  const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const range = validateBufferRange(view, Number(offset ?? 0), length == null ? undefined : Number(length));
  position = validatePosition(position);
  if (range.length === 0) return 0;
  try {
    return Number(cottontail.fdReadAt(fd, range.buffer, range.offset, range.length, position));
  } catch (error) {
    throw makeFdError(error, fd, "read");
  }
}

export function writeSync(fd, data, offset = undefined, length = undefined, position = null) {
  fd = validateFd(fd);
  if (typeof data === "string") {
    const encoding = normalizeEncoding(typeof length === "string" ? length : "utf8", "utf8");
    position = validatePosition(offset ?? null);
    const bytes = bytesFromData(data, encoding);
    if (bytes.byteLength === 0) return 0;
    try {
      return Number(cottontail.fdWriteAt(fd, bytes, 0, bytes.byteLength, position));
    } catch (error) {
      throw makeFdError(error, fd, "write");
    }
  }
  if (offset && typeof offset === "object") {
    position = offset.position ?? null;
    length = offset.length;
    offset = offset.offset ?? 0;
  }
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const range = validateBufferRange(view, Number(offset ?? 0), length == null ? undefined : Number(length));
  position = validatePosition(position);
  if (range.length === 0) return 0;
  try {
    return Number(cottontail.fdWriteAt(fd, range.buffer, range.offset, range.length, position));
  } catch (error) {
    throw makeFdError(error, fd, "write");
  }
}

export function readvSync(fd, buffers, position = null) {
  fd = validateFd(fd);
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "an Array of ArrayBufferView instances", buffers);
  position = validatePosition(position);
  let total = 0;
  let currentPosition = position;
  for (const buffer of buffers) {
    const count = readSync(fd, buffer, 0, buffer.byteLength, currentPosition);
    total += count;
    if (currentPosition != null) currentPosition += count;
    if (count < buffer.byteLength) break;
  }
  return total;
}

export function writevSync(fd, buffers, position = null) {
  fd = validateFd(fd);
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "an Array of ArrayBufferView instances", buffers);
  position = validatePosition(position);
  let total = 0;
  let currentPosition = position;
  for (const buffer of buffers) {
    const count = writeSync(fd, buffer, 0, buffer.byteLength, currentPosition);
    total += count;
    if (currentPosition != null) currentPosition += count;
  }
  return total;
}

function makeCodedFsError(code, message, path, syscall) {
  const error = new Error(`${code}: ${message}, ${syscall} '${path}'`);
  error.errno = -(Number(constantsObject[code]) || 5);
  error.code = code;
  error.syscall = syscall;
  error.path = path;
  return error;
}

function normalizeCopyMode(mode) {
  if (mode == null) return 0;
  if (typeof mode !== "number") {
    const error = new TypeError("mode must be int32 or null/undefined");
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (!Number.isFinite(mode) || mode < 0 || mode > 7) {
    const error = new RangeError("mode is out of range: >= 0 and <= 7");
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  return Math.trunc(mode);
}

function makeCopyFileError(error, source, destination) {
  const normalized = error?.code ? error : makeFsError(error, source, "copyfile");
  const code = normalized.code || "EIO";
  const reason = messageByCode[code] ?? String(normalized.message ?? code)
    .replace(/^\w+:\s*/, "")
    .replace(/,\s*\w+.*$/, "");
  normalized.code = code;
  normalized.errno ??= -(Number(constantsObject[code]) || 5);
  normalized.syscall = "copyfile";
  normalized.path = source;
  normalized.dest = destination;
  normalized.message = `${code}: ${reason}, copyfile '${source}' -> '${destination}'`;
  return normalized;
}

export function copyFileSync(source, destination, mode = 0) {
  validatePathArg(source, "src");
  validatePathArg(destination, "dest");
  mode = normalizeCopyMode(mode);
  const sourceText = normalizePath(source);
  const destinationText = normalizePath(destination);
  const exclusive = (mode & (constants.COPYFILE_EXCL ?? 1)) !== 0;
  const forceClone = (mode & (constants.COPYFILE_FICLONE_FORCE ?? 4)) !== 0;
  const preferClone = forceClone || (mode & (constants.COPYFILE_FICLONE ?? 2)) !== 0;

  try {
    const sourceStat = statSync(sourceText);
    if (!sourceStat.isFile()) {
      throw makeCodedFsError("ENOTSUP", "operation not supported", sourceText, "copyfile");
    }

    let destinationLinkStat;
    try {
      destinationLinkStat = lstatSync(destinationText);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (exclusive && destinationLinkStat) {
      throw makeCodedFsError("EEXIST", "file already exists", destinationText, "copyfile");
    }

    if (!exclusive && destinationLinkStat) {
      try {
        const destinationStat = statSync(destinationText);
        if (sourceStat.dev === destinationStat.dev && sourceStat.ino === destinationStat.ino && !forceClone) return;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    if (preferClone) {
      try {
        cottontail.cloneFileSync(sourceText, destinationText, exclusive);
        return;
      } catch (error) {
        if (forceClone) throw error;
      }
    }

    const sourceFd = openSync(sourceText, "r");
    let destinationFd = -1;
    try {
      destinationFd = openSync(destinationText, exclusive ? "wx" : "w", Number(sourceStat.mode));
      const buffer = new Uint8Array(64 * 1024);
      for (;;) {
        const bytesRead = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const count = writeSync(destinationFd, buffer, written, bytesRead - written, null);
          if (count === 0) throw makeCodedFsError("EIO", "short write", destinationText, "copyfile");
          written += count;
        }
      }
      fchmodSync(destinationFd, Number(sourceStat.mode));
    } finally {
      try {
        if (destinationFd >= 0) closeSync(destinationFd);
      } finally {
        closeSync(sourceFd);
      }
    }
  } catch (error) {
    throw makeCopyFileError(error, sourceText, destinationText);
  }
}

export function cpSync(source, destination, options) {
  return cpSyncImpl(
    normalizeCopyPath(source, "src"),
    normalizeCopyPath(destination, "dest"),
    options,
    cpOperations,
  );
}

const cpOperations = {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
};

export function chmodSync(path, mode) {
  cottontail.chmodSync(normalizePath(path), parseMode(mode));
}

export function lchmodSync(path, mode) {
  cottontail.lchmodSync(normalizePath(path), parseMode(mode));
}

export function fchmodSync(fd, mode) {
  cottontail.fchmodSync(Number(fd), parseMode(mode));
}

export function chownSync(path, uid, gid) {
  cottontail.chownSync(normalizePath(path), Number(uid), Number(gid), true);
}

export function lchownSync(path, uid, gid) {
  cottontail.chownSync(normalizePath(path), Number(uid), Number(gid), false);
}

export function fchownSync(fd, uid, gid) {
  cottontail.fchownSync(Number(fd), Number(uid), Number(gid));
}

function parseMkdirOptions(options) {
  if (options == null || typeof options === "number" || typeof options === "string") {
    return { recursive: false };
  }
  if (typeof options !== "object") {
    throw makeInvalidArgTypeError("options", "of type object or integer", options);
  }
  if (options.recursive !== undefined && typeof options.recursive !== "boolean") {
    const error = new TypeError(
      `The "recursive" property must be of type boolean, got ${typeof options.recursive}`,
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  return { recursive: Boolean(options.recursive) };
}

export function mkdirSync(path, options = {}) {
  validatePathArg(path);
  const { recursive } = parseMkdirOptions(options);
  const target = normalizePath(path);
  if (target.length === 0) throw makeFsError({ code: "ENOENT" }, target, "mkdir");
  if (!recursive) {
    try {
      cottontail.mkdirSync(target, false);
    } catch (error) {
      throw makeFsError(error, target, "mkdir");
    }
    return undefined;
  }

  const absolute = resolve(target);
  const existing = statSync(absolute, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isDirectory()) return undefined;
    const error = new Error(`EEXIST: file already exists, mkdir '${target}'`);
    error.errno = -(Number(constantsObject.EEXIST) || 17);
    error.code = "EEXIST";
    error.syscall = "mkdir";
    error.path = target;
    throw error;
  }

  // Collect missing ancestors from deepest to shallowest.
  const missing = [];
  let current = absolute;
  while (!existsSync(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  const base = statSync(current, { throwIfNoEntry: false });
  if (base && !base.isDirectory()) {
    const error = new Error(`ENOTDIR: not a directory, mkdir '${target}'`);
    error.errno = -(Number(constantsObject.ENOTDIR) || 20);
    error.code = "ENOTDIR";
    error.syscall = "mkdir";
    error.path = target;
    throw error;
  }
  for (let index = missing.length - 1; index >= 0; index -= 1) {
    try {
      cottontail.mkdirSync(missing[index], false);
    } catch (error) {
      throw makeFsError(error, missing[index], "mkdir");
    }
  }
  // Node returns the path of the first directory that had to be created.
  return missing.length > 0 ? missing[missing.length - 1] : undefined;
}

export function mkdtempSync(prefix, options = undefined) {
  validatePathArg(prefix, "prefix");
  const encoding = normalizeEncoding(options);
  const normalizedPrefix = normalizePath(prefix);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let suffix = "";
    for (let index = 0; index < 6; index += 1) {
      suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    const path = `${normalizedPrefix}${suffix}`;
    try {
      cottontail.mkdirSync(path, false);
      return encoding === "buffer" ? bufferFrom(encoder.encode(path)) : path;
    } catch (error) {
      const out = makeFsError(error, path, "mkdtemp");
      if (out.code === "EEXIST") continue;
      throw out;
    }
  }
  throw makeFsError({ code: "EEXIST" }, normalizedPrefix, "mkdtemp");
}

export function mkdtempDisposableSync(prefix) {
  const path = mkdtempSync(prefix);
  const disposable = {
    path,
    remove() {
      rmSync(path, { recursive: true, force: true });
    },
  };
  if (typeof Symbol.dispose === "symbol") disposable[Symbol.dispose] = disposable.remove;
  return disposable;
}

export function rmSync(path, options = {}) {
  const normalizedPath = normalizePath(path);
  try {
    cottontail.rmSync(normalizedPath, Boolean(options?.recursive), Boolean(options?.force));
  } catch (error) {
    if (options?.force && String(error?.message ?? error).includes("No such file")) return;
    throw makeFsError(error, normalizedPath, "rm");
  }
}

export function rmdirSync(path, options = {}) {
  if (options?.recursive) return rmSync(path, { recursive: true, force: false });
  const normalizedPath = normalizePath(path);
  try {
    cottontail.rmdirSync(normalizedPath);
  } catch (error) {
    throw makeFsError(error, normalizedPath, "rmdir");
  }
}

export function unlinkSync(path) {
  const normalizedPath = normalizePath(path);
  try {
    cottontail.unlinkSync(normalizedPath);
  } catch (error) {
    const out = makeFsError(error, normalizedPath, "unlink");
    if (out.code === "EISDIR" && globalThis.process?.platform !== "linux") {
      out.code = "EPERM";
      out.errno = -(Number(constantsObject.EPERM) || 1);
      out.message = `EPERM: operation not permitted, unlink '${normalizedPath}'`;
    }
    throw out;
  }
}

export function renameSync(oldPath, newPath) {
  const oldName = normalizePath(oldPath);
  const newName = normalizePath(newPath);
  try {
    cottontail.renameSync(oldName, newName);
  } catch (error) {
    const out = makeFsError(error, oldName, "rename");
    out.dest = newName;
    throw out;
  }
}

export function linkSync(existingPath, newPath) {
  cottontail.linkSync(normalizePath(existingPath), normalizePath(newPath));
}

export function symlinkSync(target, path, type = undefined) {
  void type;
  cottontail.symlinkSync(String(target), normalizePath(path));
}

export function readlinkSync(path, options = undefined) {
  const encoding = normalizeEncoding(options);
  const normalizedPath = normalizePath(path);
  try {
    const value = cottontail.readlinkSync(normalizedPath);
    return encoding === "buffer" ? bufferFrom(encoder.encode(value)) : value;
  } catch (error) {
    throw makeFsError(error, normalizedPath, "readlink");
  }
}

export function readdirSync(path, options = undefined) {
  const withFileTypes = Boolean(options?.withFileTypes);
  const recursive = Boolean(options?.recursive);
  const encoding = normalizeEncoding(options);
  const root = normalizePath(path);
  const out = [];

  const visit = (directory, relativePrefix = "") => {
    let sourceEntries;
    try {
      sourceEntries = cottontail.readDirSync(directory);
    } catch (error) {
      throw makeFsError(error, directory, "scandir");
    }

    const directories = recursive ? [] : null;
    for (const entry of sourceEntries) {
      if (withFileTypes) {
        const mode = Number(entry.mode) || 0;
        const dirent = new Dirent(
          encoding === "buffer" ? bufferFrom(encoder.encode(entry.name)) : entry.name,
          entry,
          directory,
        );
        out.push(dirent);
        if (recursive && modeMatches(mode, constants.S_IFDIR ?? 0o040000)) directories.push(entry.name);
      } else {
        const relativeName = relativePrefix ? join(relativePrefix, entry.name) : entry.name;
        const encodedName = encoding === "buffer" ? bufferFrom(encoder.encode(relativeName)) : relativeName;
        out.push(encodedName);
        if (recursive && modeMatches(Number(entry.mode) || 0, constants.S_IFDIR ?? 0o040000)) {
          directories.push(entry.name);
        }
      }
    }

    for (const name of directories ?? []) {
      const nextRelative = relativePrefix ? join(relativePrefix, name) : name;
      visit(join(directory, name), nextRelative);
    }
  };

  visit(root);
  return out;
}

export function opendirSync(path, options = {}) {
  return new Dir(path, options);
}

export function statSync(path, options = undefined) {
  validatePathArg(path);
  const normalizedPath = normalizePath(path);
  try {
    return makeStats(cottontail.statSync(normalizedPath, true), options);
  } catch (error) {
    if (shouldSuppressMissing(options)) return undefined;
    throw makeFsError(error, normalizedPath, "stat");
  }
}

export function lstatSync(path, options = undefined) {
  validatePathArg(path);
  const normalizedPath = normalizePath(path);
  try {
    return makeStats(cottontail.statSync(normalizedPath, false), options);
  } catch (error) {
    if (shouldSuppressMissing(options)) return undefined;
    throw makeFsError(error, normalizedPath, "lstat");
  }
}

export function fstatSync(fd, options = undefined) {
  fd = validateFd(fd);
  try {
    return makeStats(cottontail.fstatSync(fd), options);
  } catch (error) {
    throw makeFdError(error, fd, "fstat");
  }
}

export function statfsSync(path, options = undefined) {
  return makeStatFs(cottontail.statfsSync(normalizePath(path)), options);
}

export function realpathSync(path, options = undefined) {
  const encoding = normalizeEncoding(options);
  const normalizedPath = normalizePath(path);
  try {
    const value = cottontail.realpathSync(normalizedPath);
    return encoding === "buffer" ? bufferFrom(encoder.encode(value)) : value;
  } catch (error) {
    throw makeFsError(error, normalizedPath, "realpath");
  }
}

realpathSync.native = realpathSync;

export function fsyncSync(fd) {
  fd = validateFd(fd);
  try { cottontail.fsyncSync(fd); } catch (error) { throw makeFdError(error, fd, "fsync"); }
}

export function fdatasyncSync(fd) {
  fd = validateFd(fd);
  try { cottontail.fdatasyncSync(fd); } catch (error) { throw makeFdError(error, fd, "fdatasync"); }
}

export function ftruncateSync(fd, len = 0) {
  fd = validateFd(fd);
  len = validateInteger(len ?? 0, "len", 0, Number.MAX_SAFE_INTEGER);
  try { cottontail.ftruncateSync(fd, len); } catch (error) { throw makeFdError(error, fd, "ftruncate"); }
}

export function truncateSync(path, len = 0) {
  len = validateInteger(len ?? 0, "len", 0, Number.MAX_SAFE_INTEGER);
  const normalizedPath = normalizePath(path);
  try { cottontail.truncateSync(normalizedPath, len); } catch (error) { throw makeFsError(error, normalizedPath, "truncate"); }
}

export function futimesSync(fd, atime, mtime) {
  cottontail.futimesSync(Number(fd), _toUnixTimestamp(atime), _toUnixTimestamp(mtime));
}

export function utimesSync(path, atime, mtime) {
  cottontail.utimesSync(normalizePath(path), _toUnixTimestamp(atime), _toUnixTimestamp(mtime), true);
}

export function lutimesSync(path, atime, mtime) {
  cottontail.utimesSync(normalizePath(path), _toUnixTimestamp(atime), _toUnixTimestamp(mtime), false);
}

export function _toUnixTimestamp(time) {
  if (time instanceof Date) return time.getTime() / 1000;
  if (typeof time === "string" && time.trim() !== "") return Number(time);
  if (typeof time === "number") return time;
  throw new TypeError("time must be a Date, number, or numeric string");
}

export async function openAsBlob(path, options = {}) {
  const BlobCtor = globalThis.Blob ?? FileBlob;
  return new BlobCtor([readFileSync(path)], { type: options?.type ?? "" });
}

// The vendored Node stream prototypes expose several getter-only,
// non-configurable accessors (closed, writableEnded, ...). Plain assignment to
// those throws in strict mode, so instance state is installed as own data
// properties which shadow the prototype accessors.
function defineOwnState(target, values) {
  for (const key of Object.keys(values)) {
    Object.defineProperty(target, key, {
      value: values[key],
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function normalizeStreamOptions(options) {
  if (options == null || typeof options === "function") return {};
  if (typeof options === "string") return { encoding: normalizeEncoding(options) };
  if (typeof options !== "object") throw invalidArgType("options", "of type string or object", options);
  const copy = {};
  for (const key in options) copy[key] = options[key];
  if (copy.encoding != null) copy.encoding = normalizeEncoding(copy.encoding);
  if (copy.signal != null) validateAbortSignal(copy.signal);
  return copy;
}

function streamPrematureCloseError() {
  const error = new Error("Premature close");
  error.code = "ERR_STREAM_PREMATURE_CLOSE";
  return error;
}

class ReadStreamImpl extends Readable {
  constructor(path, options = {}) {
    options = normalizeStreamOptions(options);
    // Lifecycle (open/close/destroy) is managed by this class, not the engine.
    super({ ...options, autoDestroy: false, emitClose: false });
    const hasFd = Object.prototype.hasOwnProperty.call(options, "fd") && options.fd != null;
    const fd = hasFd ? validateFd(options.fd) : null;
    if (!hasFd) validatePathArg(path);
    const start = options.start == null ? null : validateInteger(options.start, "start", 0, Number.MAX_SAFE_INTEGER);
    const end = options.end == null || options.end === Infinity
      ? null
      : validateInteger(options.end, "end", 0, Number.MAX_SAFE_INTEGER);
    if (start != null && end != null && start > end) throw outOfRange("start", `<= ${end}`, start);
    defineOwnState(this, {
      path: hasFd ? path : normalizePath(path),
      flags: options?.flags || "r",
      mode: options?.mode ?? 0o666,
      fd,
      autoClose: options?.autoClose !== false,
      destroyed: false,
      closed: false,
      readable: true,
      readableEnded: false,
      bytesRead: 0,
      pending: true,
      start,
      end,
      pos: start,
      highWaterMark: Math.max(1, Math.min(Number(options?.highWaterMark || 64 * 1024), 1024 * 1024)),
      encoding: options?.encoding,
      _ownsFd: fd == null || Number.isNaN(fd),
      _paused: false,
      _closed: false,
      _opened: false,
      _reading: false,
      _abortListener: null,
    });

    if (options.signal) {
      this._abortListener = () => this.destroy(abortReasonForStream(options.signal));
      if (options.signal.aborted) queueMicrotask(this._abortListener);
      else options.signal.addEventListener("abort", this._abortListener, { once: true });
      this.once("close", () => options.signal.removeEventListener("abort", this._abortListener));
    }

    queueMicrotask(() => {
      if (this.destroyed) return;
      try { this._open(); } catch (error) { this.destroy(error); }
    });
  }

  _read() {
    if (this._paused || this.destroyed || this.readableEnded) return;
    queueMicrotask(() => this._pump());
  }

  _open() {
    if (this._opened) return;
    const opensOwnFd = this.fd == null || Number.isNaN(this.fd);
    if (opensOwnFd) {
      this.fd = openSync(this.path, this.flags, this.mode);
      this._ownsFd = true;
    }
    this._opened = true;
    this.pending = false;
    // Streams created over an existing fd (e.g. FileHandle streams) never
    // emit "open"/"ready" in Node.
    if (opensOwnFd) {
      this.emit("open", this.fd);
      this.emit("ready");
    }
  }

  _close() {
    if (this._closed) return;
    this._closed = true;
    this.closed = true;
    if (this.fd != null) {
      try { closeSync(this.fd); } catch {}
    }
    this.fd = null;
    this.emit("close");
  }

  _pump() {
    if (this.destroyed || this.readableEnded || this._paused || this._reading) return;
    this._reading = true;
    try {
      this._open();
      if (this.destroyed || this._paused) return;
      const remaining = this.end == null || this.pos == null ? this.highWaterMark : Math.max(0, this.end - this.pos + 1);
      const length = Math.min(this.highWaterMark, remaining);
      if (length <= 0) {
        this._finishRead();
        return;
      }
      const chunk = new Uint8Array(length);
      const bytesRead = readSync(this.fd, chunk, 0, length, this.pos);
      if (bytesRead <= 0) {
        this._finishRead();
        return;
      }
      this.bytesRead += bytesRead;
      if (this.pos != null) this.pos += bytesRead;
      const value = chunk.subarray(0, bytesRead);
      this.push(this.encoding ? decodeBytes(value, this.encoding) : bufferFrom(value));
      if (bytesRead < length) this._finishRead();
      else queueMicrotask(() => this._pump());
    } catch (error) {
      this.destroy(error);
    } finally {
      this._reading = false;
    }
  }

  _finishRead() {
    if (this.readableEnded) return;
    this.readableEnded = true;
    this.readable = false;
    this.push(null);
    if (this.autoClose) {
      this.destroyed = true;
      this._close();
    }
  }

  close(callback = undefined) {
    const error = this.readableEnded ? undefined : streamPrematureCloseError();
    if (callback) this.once("close", () => callback(error));
    queueMicrotask(() => {
      if (this._closed) return;
      try { this._open(); } catch (openError) {
        if (callback && error === undefined) callback(openError);
      }
      this.destroy();
    });
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed && this.fd == null) return this;
    this.destroyed = true;
    this.readable = false;
    if (error) this.emit("error", error);
    this._close();
    return this;
  }

  pause() {
    this._paused = true;
    // Inform the stream engine so on("data") does not auto-resume an
    // explicitly paused stream.
    if (typeof super.pause === "function") super.pause();
    return this;
  }

  resume() {
    if (typeof super.resume === "function") super.resume();
    if (!this._paused) return this;
    this._paused = false;
    queueMicrotask(() => this._pump());
    return this;
  }
}

function abortReasonForStream(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.cause = reason;
  return error;
}

export function ReadStream(path, options = {}) {
  return new ReadStreamImpl(path, options);
}
ReadStream.prototype = ReadStreamImpl.prototype;
Object.defineProperty(ReadStream.prototype, "constructor", { value: ReadStream, writable: true, configurable: true });
Object.setPrototypeOf(ReadStream, ReadStreamImpl);

export const FileReadStream = ReadStream;
export const Utf8Stream = ReadStream;

export function createReadStream(path, options = {}) {
  return new ReadStream(path, options);
}

class WriteStreamImpl extends Writable {
  constructor(path, options = {}) {
    options = normalizeStreamOptions(options);
    // Lifecycle (open/close/destroy) is managed by this class, not the engine.
    super({ ...options, autoDestroy: false, emitClose: false });
    const hasFd = Object.prototype.hasOwnProperty.call(options, "fd") && options.fd != null;
    const fd = hasFd ? validateFd(options.fd) : null;
    if (!hasFd) validatePathArg(path);
    const start = options.start == null ? null : validateInteger(options.start, "start", 0, Number.MAX_SAFE_INTEGER);
    const highWaterMark = Math.max(1, Math.min(Number(options?.highWaterMark || 16 * 1024), 1024 * 1024));
    defineOwnState(this, {
      path: hasFd ? path : normalizePath(path),
      flags: options?.flags || "w",
      mode: options?.mode ?? 0o666,
      fd,
      autoClose: options?.autoClose !== false,
      bytesWritten: 0,
      pending: true,
      destroyed: false,
      writable: true,
      writableEnded: false,
      closed: false,
      start,
      pos: start,
      highWaterMark,
      writableHighWaterMark: highWaterMark,
      writableLength: 0,
      writableNeedDrain: false,
      _ownsFd: fd == null || Number.isNaN(fd),
      flush: options.flush === true,
      _abortListener: null,
      _finalizing: false,
      _finished: false,
    });
    if (options.flush != null && typeof options.flush !== "boolean") {
      throw invalidArgType("options.flush", "of type boolean", options.flush);
    }
    if (options.signal) {
      this._abortListener = () => this.destroy(abortReasonForStream(options.signal));
      if (options.signal.aborted) queueMicrotask(this._abortListener);
      else options.signal.addEventListener("abort", this._abortListener, { once: true });
      this.once("close", () => options.signal.removeEventListener("abort", this._abortListener));
    }
    queueMicrotask(() => {
      try { this._open(); } catch (error) { this.destroy(error); }
    });
  }

  _open() {
    if (!this.pending) return;
    if (this.destroyed) return;
    const opensOwnFd = this.fd == null || Number.isNaN(this.fd);
    if (opensOwnFd) {
      ensureParent(normalizePath(this.path));
      this.fd = openSync(this.path, this.flags, this.mode);
      this._ownsFd = true;
    }
    this.pending = false;
    // Streams created over an existing fd (e.g. FileHandle streams) never
    // emit "open"/"ready" in Node.
    if (opensOwnFd) {
      this.emit("open", this.fd);
      this.emit("ready");
    }
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    try {
      if (this.pending) this._open();
      const bytes = bytesFromData(chunk, encoding ?? "utf8");
      this.writableLength += bytes.byteLength;
      const bytesWritten = writeSync(this.fd, bytes, 0, bytes.byteLength, this.pos);
      if (this.pos != null) this.pos += bytesWritten;
      this.bytesWritten += bytesWritten;
      const overHighWaterMark = this.writableLength >= this.highWaterMark;
      if (overHighWaterMark) this.writableNeedDrain = true;
      queueMicrotask(() => {
        this.writableLength = Math.max(0, this.writableLength - bytes.byteLength);
        if (this.writableNeedDrain && this.writableLength === 0) {
          this.writableNeedDrain = false;
          this.emit("drain");
        }
        if (callback) callback(null);
      });
      return !overHighWaterMark;
    } catch (error) {
      if (callback) callback(error);
      this.emit("error", error);
      return false;
    }
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this.writableEnded) {
      if (typeof callback === "function") {
        if (this._finished) queueMicrotask(callback);
        else this.once("finish", callback);
      }
      return this;
    }
    if (this.pending) {
      try { this._open(); } catch (error) {
        this.destroy(error);
        if (typeof callback === "function") queueMicrotask(() => callback(error));
        return this;
      }
    }
    if (chunk != null) this.write(chunk, encoding);
    this.writableEnded = true;
    this.writable = false;
    if (typeof callback === "function") this.once("finish", callback);
    if (this._finalizing) return this;
    this._finalizing = true;
    queueMicrotask(() => {
      if (this.destroyed || this._finished) return;
      if (this.flush && this.fd != null) {
        try { fsyncSync(this.fd); } catch (error) { this.destroy(error); return; }
      }
      this._finished = true;
      this.emit("finish");
      if (this.autoClose) this.destroy();
    });
    return this;
  }

  close(callback = undefined) {
    if (callback) this.once("close", callback);
    this.end();
    if (!this.autoClose) this.once("finish", () => this.destroy());
    return this;
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (this.fd != null) {
      try { closeSync(this.fd); } catch {}
    }
    this.fd = null;
    if (error) this.emit("error", error);
    this.closed = true;
    queueMicrotask(() => this.emit("close"));
    return this;
  }

  destroySoon() {
    return this.end();
  }
}

export function WriteStream(path, options = {}) {
  return new WriteStreamImpl(path, options);
}
WriteStream.prototype = WriteStreamImpl.prototype;
Object.defineProperty(WriteStream.prototype, "constructor", { value: WriteStream, writable: true, configurable: true });
Object.setPrototypeOf(WriteStream, WriteStreamImpl);

export const FileWriteStream = WriteStream;

export function createWriteStream(path, options = {}) {
  return new WriteStream(path, options);
}

function callbackify(action, callbackName = "callback", validate = undefined) {
  return (...args) => {
    const callback = args[args.length - 1];
    if (typeof callback !== "function") throw makeInvalidCallbackError(callbackName, callback);
    const callArgs = args.slice(0, -1);
    validate?.(...callArgs);
    queueMicrotask(() => {
      try { callback(null, action(...callArgs)); } catch (error) { callback(error); }
    });
  };
}

export const access = callbackify(accessSync);
export function appendFile(path, data, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  if (typeof path !== "number") validatePathArg(path);
  validateWriteData(data);
  normalizeEncoding(options, "utf8");
  const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
  runAbortable(() => appendFileSync(path, data, options), signal).then(
    () => callback(null),
    error => callback(error),
  );
}
export const chmod = callbackify(chmodSync);
export const chown = callbackify(chownSync);
export function close(fd, callback = undefined) {
  fd = validateFd(fd);
  if (callback !== undefined && typeof callback !== "function") {
    throw makeInvalidCallbackError("callback", callback);
  }
  queueMicrotask(() => {
    try {
      closeSync(fd);
      callback?.(null);
    } catch (error) {
      callback?.(error);
    }
  });
}
export const copyFile = callbackify(copyFileSync);
export function cp(source, destination, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("cb", callback);
  fsPromisesDefault.cp(source, destination, options).then(
    () => callback(),
    callback,
  );
}
export const fchmod = callbackify(fchmodSync);
export const fchown = callbackify(fchownSync);
export const fdatasync = callbackify(fdatasyncSync);
export const fstat = callbackify(fstatSync);
export const fsync = callbackify(fsyncSync);
export const ftruncate = callbackify(ftruncateSync);
export const futimes = callbackify(futimesSync);
export const lchmod = callbackify(lchmodSync);
export const lchown = callbackify(lchownSync);
export const link = callbackify(linkSync);
export const lstat = callbackify(lstatSync);
export const lutimes = callbackify(lutimesSync);
export function mkdir(path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  // Node validates the path and options synchronously.
  validatePathArg(path);
  parseMkdirOptions(options ?? {});
  queueMicrotask(() => {
    try { callback(null, mkdirSync(path, options ?? {})); } catch (error) { callback(error); }
  });
}
export const mkdtemp = callbackify(mkdtempSync, "callback", (prefix, options) => {
  validatePathArg(prefix, "prefix");
  normalizeEncoding(options);
});
export function open(path, flags, mode, callback) {
  if (typeof mode === "function") {
    callback = mode;
    mode = 0o666;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  validatePathArg(path);
  normalizeOpenFlags(flags);
  normalizeOpenMode(mode ?? 0o666);
  queueMicrotask(() => {
    try { callback(null, openSync(path, flags, mode ?? 0o666)); } catch (error) { callback(error); }
  });
}
export const opendir = callbackify(opendirSync);
export function readFile(path, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  if (typeof path !== "number") validatePathArg(path);
  normalizeEncoding(options);
  const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
  runAbortable(() => readFileSync(path, options), signal).then(
    value => callback(null, value),
    error => callback(error),
  );
}
export const readdir = callbackify(readdirSync, "callback", (path, options) => {
  validatePathArg(path);
  normalizeEncoding(options);
});
export const readlink = callbackify(readlinkSync, "callback", (path, options) => {
  validatePathArg(path);
  normalizeEncoding(options);
});
export const realpath = callbackify(realpathSync, "callback", (path, options) => {
  validatePathArg(path);
  normalizeEncoding(options);
});
export const rename = callbackify(renameSync);
export const rm = callbackify(rmSync);
export const rmdir = callbackify(rmdirSync);
export const stat = callbackify(statSync);
export const statfs = callbackify(statfsSync);
export const symlink = callbackify(symlinkSync);
export const truncate = callbackify(truncateSync);
export const unlink = callbackify(unlinkSync);
export const utimes = callbackify(utimesSync);
export function writeFile(path, data, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  if (typeof path !== "number") validatePathArg(path);
  validateWriteData(data);
  normalizeEncoding(options, "utf8");
  const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
  runAbortable(() => writeFileSync(path, data, options), signal).then(
    () => callback(null),
    error => callback(error),
  );
}

export function exists(path, callback) {
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  queueMicrotask(() => callback(existsSync(path)));
}

export function read(fd, buffer, offset, length, position, callback) {
  if (typeof buffer === "function") {
    callback = buffer;
    buffer = globalThis.Buffer?.alloc?.(16384) ?? new Uint8Array(16384);
    offset = 0;
    length = buffer.byteLength;
    position = null;
  } else if (buffer && typeof buffer === "object" && !ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
    callback = offset;
    const options = buffer;
    buffer = options.buffer ?? globalThis.Buffer?.alloc?.(16384) ?? new Uint8Array(16384);
    offset = options.offset ?? 0;
    length = options.length ?? buffer.byteLength - offset;
    position = options.position ?? null;
  } else if (offset && typeof offset === "object") {
    callback = length;
    position = offset.position ?? null;
    length = offset.length;
    offset = offset.offset ?? 0;
  }
  if (typeof position === "function") {
    callback = position;
    position = null;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  validateFd(fd);
  validateBufferRange(buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer, offset ?? 0, length);
  validatePosition(position);
  queueMicrotask(() => {
    try {
      const bytesRead = readSync(fd, buffer, offset, length, position);
      callback(null, bytesRead, buffer);
    } catch (error) {
      callback(error);
    }
  });
}

export function write(fd, data, offset = undefined, length = undefined, position = undefined, callback = undefined) {
  if (typeof offset === "function") {
    callback = offset;
    offset = undefined;
    length = undefined;
    position = undefined;
  } else if (typeof length === "function") {
    callback = length;
    length = undefined;
    position = undefined;
  } else if (typeof position === "function") {
    callback = position;
    position = undefined;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  validateFd(fd);
  if (typeof data === "string") {
    validatePosition(offset ?? null);
    normalizeEncoding(typeof length === "string" ? length : "utf8", "utf8");
  } else {
    const options = offset && typeof offset === "object" ? offset : null;
    validateBufferRange(
      data instanceof ArrayBuffer ? new Uint8Array(data) : data,
      options?.offset ?? offset ?? 0,
      options?.length ?? length,
    );
    validatePosition(options?.position ?? position ?? null);
  }
  queueMicrotask(() => {
    try {
      const bytesWritten = writeSync(fd, data, offset, length, position);
      callback(null, bytesWritten, data);
    } catch (error) {
      callback(error);
    }
  });
}

export function readv(fd, buffers, position = null, callback = undefined) {
  if (typeof position === "function") {
    callback = position;
    position = null;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  validateFd(fd);
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "an Array of ArrayBufferView instances", buffers);
  validatePosition(position);
  queueMicrotask(() => {
    try { callback(null, readvSync(fd, buffers, position), buffers); } catch (error) { callback(error); }
  });
}

export function writev(fd, buffers, position = null, callback = undefined) {
  if (typeof position === "function") {
    callback = position;
    position = null;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  validateFd(fd);
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "an Array of ArrayBufferView instances", buffers);
  validatePosition(position);
  queueMicrotask(() => {
    try { callback(null, writevSync(fd, buffers, position), buffers); } catch (error) { callback(error); }
  });
}

const customPromisify = Symbol.for("nodejs.util.promisify.custom");
Object.defineProperty(exists, customPromisify, {
  configurable: true,
  value(path) {
    return new Promise(resolve => exists(path, resolve));
  },
});
Object.defineProperty(read, customPromisify, {
  configurable: true,
  value(...args) {
    return new Promise((resolve, reject) => {
      read(...args, (error, bytesRead, buffer) => error ? reject(error) : resolve({ bytesRead, buffer }));
    });
  },
});
Object.defineProperty(write, customPromisify, {
  configurable: true,
  value(...args) {
    return new Promise((resolve, reject) => {
      write(...args, (error, bytesWritten, buffer) => error ? reject(error) : resolve({ bytesWritten, buffer }));
    });
  },
});
Object.defineProperty(readv, customPromisify, {
  configurable: true,
  value(...args) {
    return new Promise((resolve, reject) => {
      readv(...args, (error, bytesRead, buffers) => error ? reject(error) : resolve({ bytesRead, buffers }));
    });
  },
});
Object.defineProperty(writev, customPromisify, {
  configurable: true,
  value(...args) {
    return new Promise((resolve, reject) => {
      writev(...args, (error, bytesWritten, buffers) => error ? reject(error) : resolve({ bytesWritten, buffers }));
    });
  },
});

function snapshot(path, recursive, validateRoot = false) {
  const root = normalizePath(path);
  const linkStats = lstatSync(root);
  const stats = linkStats.isSymbolicLink() ? statSync(root) : linkStats;
  if (validateRoot && (Number(stats.mode) & 0o444) === 0) {
    const error = new Error("Permission denied");
    error.code = "EACCES";
    throw makeFsError(error, root, "watch");
  }
  const entries = new Map();
  const add = (relative, fullPath, entryStats = lstatSync(fullPath)) => {
    entries.set(relative, {
      identity: `${entryStats.dev}:${entryStats.ino}`,
      metadata: `${entryStats.mode}:${entryStats.size}:${entryStats.mtimeMs}:${entryStats.ctimeMs}:${entryStats.birthtimeMs}`,
    });
  };
  if (!stats.isDirectory()) {
    add(String(root).split("/").pop() || "", root, stats);
    return entries;
  }
  const walk = (dir, prefix = "") => {
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if (prefix) return;
      throw error;
    }
    for (const entry of children) {
      const name = String(entry.name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const fullPath = join(dir, name);
      let entryStats;
      try {
        entryStats = lstatSync(fullPath);
      } catch {
        continue;
      }
      add(relative, fullPath, entryStats);
      if (recursive && entryStats.isDirectory()) {
        walk(fullPath, relative);
      }
    }
  };
  walk(root);
  return entries;
}

function watchFilename(name, options) {
  const encoding = normalizeEncoding(options, "utf8");
  const bytes = bufferFrom(encoder.encode(name));
  return encoding === "buffer" ? bytes : bytes.toString(encoding);
}

function watchAbortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name !== "AbortError") return reason;
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (reason !== undefined) error.cause = reason;
  return error;
}

function diffSnapshots(previous, current) {
  const events = [];
  for (const [name, signature] of current) {
    if (!previous.has(name)) events.push(["rename", name]);
    else if (previous.get(name).identity !== signature.identity) events.push(["rename", name]);
    else if (previous.get(name).metadata !== signature.metadata) events.push(["change", name]);
  }
  for (const name of previous.keys()) {
    if (!current.has(name)) events.push(["rename", name]);
  }
  return events;
}

export function watch(path, options = {}, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  if (typeof options === "string") options = { encoding: options };
  normalizeEncoding(options, "utf8");
  validateAbortSignal(options?.signal);
  const filename = normalizePath(path);
  const recursive = Boolean(options?.recursive);
  const listeners = new Map();
  let closed = false;
  let persistent = options?.persistent !== false;
  let last;
  try {
    last = snapshot(filename, recursive, true);
  } catch (error) {
    if (error?.syscall === "watch") throw error;
    throw makeFsError(error, filename, "watch");
  }
  let timer = null;
  let abortQueued = false;
  const watcher = {
    close() {
      if (closed) return;
      closed = true;
      if (timer != null) clearInterval(timer);
      options?.signal?.removeEventListener?.("abort", abort);
      emit("close");
    },
    addListener(name, handler) {
      return watcher.on(name, handler);
    },
    on(name, handler) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
      return watcher;
    },
    once(name, handler) {
      const wrapped = (...args) => {
        watcher.off(name, wrapped);
        handler(...args);
      };
      return watcher.on(name, wrapped);
    },
    off(name, handler) {
      const handlers = listeners.get(name) ?? [];
      listeners.set(name, handlers.filter((item) => item !== handler));
      return watcher;
    },
    removeListener(name, handler) {
      return watcher.off(name, handler);
    },
    removeAllListeners(name = undefined) {
      if (name == null) listeners.clear();
      else listeners.delete(name);
      return watcher;
    },
    emit(name, ...args) {
      emit(name, ...args);
      return true;
    },
    ref() {
      if (!closed) {
        persistent = true;
        timer?.ref?.();
      }
      return watcher;
    },
    unref() {
      persistent = false;
      timer?.unref?.();
      return watcher;
    },
    hasRef() { return !closed && (timer?.hasRef?.() ?? persistent); },
  };
  const emit = (name, ...args) => {
    for (const handler of listeners.get(name) ?? []) handler(...args);
  };
  if (listener) watcher.on("change", listener);
  function abort() {
    if (closed || abortQueued) return;
    abortQueued = true;
    queueMicrotask(() => {
      abortQueued = false;
      if (closed) return;
      try {
        emit("error", watchAbortError(options?.signal));
      } finally {
        watcher.close();
      }
    });
  }
  if (options?.signal?.aborted) abort();
  else options?.signal?.addEventListener?.("abort", abort, { once: true });
  timer = setInterval(() => {
    if (closed) return;
    try {
      const next = snapshot(filename, recursive);
      for (const [eventType, filename] of diffSnapshots(last, next)) {
        emit("change", eventType, watchFilename(filename, options));
      }
      last = next;
    } catch (error) {
      try {
        emit("error", makeFsError(error, filename, "watch"));
      } finally {
        watcher.close();
      }
    }
  }, Number(options?.interval || 500));
  if (!persistent) timer?.unref?.();
  return watcher;
}

function zeroStats(options = undefined) {
  return makeStats(Object.fromEntries(statsPositionalFields.map((field) => [field, 0])), options);
}

function statSnapshot(path, options = undefined) {
  try { return statSync(path, options); } catch { return zeroStats(options); }
}

function statsEqual(a, b) {
  return a.size === b.size &&
    a.mode === b.mode &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.nlink === b.nlink &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.rdev === b.rdev &&
    a.blksize === b.blksize &&
    a.blocks === b.blocks &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.birthtimeMs === b.birthtimeMs;
}

const fileWatchers = globalThis.__cottontailFileWatchers ??= new Map();

export function watchFile(path, options = {}, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  if (typeof listener !== "function") throw new TypeError("The \"listener\" argument must be of type function");
  const filename = normalizePath(path);
  const statOptions = options?.bigint ? { bigint: true } : undefined;
  let entry = fileWatchers.get(filename);
  if (!entry) {
    let initialMissing = false;
    let previous;
    try {
      previous = statSync(filename, statOptions);
    } catch {
      previous = zeroStats(statOptions);
      initialMissing = true;
    }
    entry = {
      previous,
      listeners: new Set(),
      timer: null,
    };
    entry.timer = setInterval(() => {
      const current = statSnapshot(filename, statOptions);
      if (statsEqual(current, entry.previous)) return;
      const previous = entry.previous;
      entry.previous = current;
      for (const handler of [...entry.listeners]) handler(current, previous);
    }, Math.max(5, Number(options?.interval || 5007)));
    if (options?.persistent === false) entry.timer?.unref?.();
    fileWatchers.set(filename, entry);
    if (initialMissing) {
      queueMicrotask(() => {
        if (fileWatchers.get(filename) !== entry) return;
        for (const handler of [...entry.listeners]) handler(entry.previous, entry.previous);
      });
    }
  }
  entry.listeners.add(listener);
  return {
    close() { unwatchFile(filename, listener); return this; },
    ref() { entry.timer?.ref?.(); return this; },
    unref() { entry.timer?.unref?.(); return this; },
    hasRef() { return entry.timer?.hasRef?.() ?? false; },
  };
}

export function unwatchFile(path, listener = undefined) {
  const filename = normalizePath(path);
  const entry = fileWatchers.get(filename);
  if (!entry) return;
  if (typeof listener === "function") entry.listeners.delete(listener);
  else entry.listeners.clear();
  if (entry.listeners.size === 0) {
    clearInterval(entry.timer);
    fileWatchers.delete(filename);
  }
}

function normalizeGlobPattern(pattern) {
  return String(pattern).replace(/\\/g, "/").replace(/^\.\//, "");
}

function globSegments(pattern) {
  return normalizeGlobPattern(pattern).split("/").filter((segment, index) => segment !== "" || index === 0);
}

function escapeRegExp(value) {
  return String(value).replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function segmentToRegExp(segment) {
  let source = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{") {
      const end = segment.indexOf("}", index + 1);
      if (end > index) {
        const alternatives = segment.slice(index + 1, end).split(",").map(escapeRegExp).join("|");
        source += `(?:${alternatives})`;
        index = end;
      } else {
        source += "\\{";
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function matchGlobSegments(patternParts, pathParts, patternIndex = 0, pathIndex = 0) {
  if (patternIndex >= patternParts.length) return pathIndex >= pathParts.length;
  const pattern = patternParts[patternIndex];
  if (pattern === "**") {
    // A trailing "/**" matches everything below the prefix but not the prefix
    // directory itself (e.g. "a/**" matches "a/b.txt" but not "a").
    if (patternIndex === patternParts.length - 1) {
      return patternIndex === 0 || pathIndex < pathParts.length;
    }
    for (let nextIndex = pathIndex; nextIndex <= pathParts.length; nextIndex += 1) {
      if (matchGlobSegments(patternParts, pathParts, patternIndex + 1, nextIndex)) return true;
    }
    return false;
  }
  if (pathIndex >= pathParts.length) return false;
  return segmentToRegExp(pattern).test(pathParts[pathIndex]) &&
    matchGlobSegments(patternParts, pathParts, patternIndex + 1, pathIndex + 1);
}

function globMatches(pattern, relativePath) {
  const normalized = normalizeGlobPattern(relativePath);
  return matchGlobSegments(globSegments(pattern), normalized.split("/").filter(Boolean));
}

function makeExcludeMatcher(exclude) {
  if (exclude == null) return () => false;
  if (typeof exclude === "function") return (entry, value) => Boolean(exclude(value));
  const patterns = (Array.isArray(exclude) ? exclude : [exclude]).map(normalizeGlobPattern);
  return (entry) => patterns.some((pattern) => globMatches(pattern, entry.relative));
}

function makeGlobDirent(entry) {
  return new Dirent(entry.name, entry.stats, entry.parentPath);
}

function walkGlobEntries(root, options = {}, prefix = "", seenDirectories = new Set(), exclude = () => false, withFileTypes = false) {
  const out = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const name = String(dirent.name);
    const fullPath = join(root, name);
    const relative = prefix ? `${prefix}/${name}` : name;
    const lstat = lstatSync(fullPath);
    const entry = {
      name,
      fullPath,
      parentPath: root,
      relative,
      stats: lstat,
    };
    const excludeValue = withFileTypes ? makeGlobDirent(entry) : entry.relative;
    const excluded = exclude(entry, excludeValue);
    if (!excluded) out.push(entry);

    let descend = lstat.isDirectory();
    if (!descend && options?.followSymlinks && lstat.isSymbolicLink()) {
      try {
        descend = statSync(fullPath).isDirectory();
      } catch {}
    }
    if (!descend || excluded) continue;

    let real = fullPath;
    try { real = realpathSync(fullPath); } catch {}
    if (seenDirectories.has(real)) continue;
    seenDirectories.add(real);
    out.push(...walkGlobEntries(fullPath, options, relative, seenDirectories, exclude, withFileTypes));
  }
  return out;
}

export function globSync(pattern, options) {
  const patterns = (Array.isArray(pattern) ? pattern : [pattern]).map(normalizeGlobPattern);
  const cwd = normalizePath(options?.cwd ?? globalThis.process?.cwd?.() ?? ".");
  const withFileTypes = Boolean(options?.withFileTypes);
  const exclude = makeExcludeMatcher(options?.exclude);
  const matches = [];
  for (const entry of walkGlobEntries(cwd, options ?? {}, "", new Set(), exclude, withFileTypes)) {
    const value = withFileTypes
      ? makeGlobDirent(entry)
      : options?.absolute ? resolve(cwd, entry.relative) : entry.relative;
    if (patterns.some((candidate) => globMatches(candidate, entry.relative))) matches.push(value);
  }
  return withFileTypes ? matches : matches.sort();
}
// Keep Node-compatible function name even if a bundler renames the binding.
Object.defineProperty(globSync, "name", { value: "globSync" });

export function glob(pattern, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  queueMicrotask(() => {
    try { callback(null, globSync(pattern, options)); } catch (error) { callback(error); }
  });
}
Object.defineProperty(glob, "name", { value: "glob" });

// The fs/promises module namespace itself. Node exposes fs.promises as the
// exact same object returned by require("fs/promises").
export const promises = fsPromisesDefault;

export default {
  Dir,
  Dirent,
  F_OK,
  FileReadStream,
  FileWriteStream,
  R_OK,
  ReadStream,
  Stats,
  Utf8Stream,
  W_OK,
  WriteStream,
  X_OK,
  _toUnixTimestamp,
  access,
  accessSync,
  appendFile,
  appendFileSync,
  chmod,
  chmodSync,
  chown,
  chownSync,
  close,
  closeSync,
  constants,
  copyFile,
  copyFileSync,
  cp,
  cpSync,
  createReadStream,
  createWriteStream,
  exists,
  existsSync,
  fchmod,
  fchmodSync,
  fchown,
  fchownSync,
  fdatasync,
  fdatasyncSync,
  fstat,
  fstatSync,
  fsync,
  fsyncSync,
  ftruncate,
  ftruncateSync,
  futimes,
  futimesSync,
  glob,
  globSync,
  lchmod,
  lchmodSync,
  lchown,
  lchownSync,
  link,
  linkSync,
  lstat,
  lstatSync,
  lutimes,
  lutimesSync,
  mkdir,
  mkdirSync,
  mkdtemp,
  mkdtempDisposableSync,
  mkdtempSync,
  open,
  openAsBlob,
  openSync,
  opendir,
  opendirSync,
  promises,
  read,
  readFile,
  readFileSync,
  readSync,
  readdir,
  readdirSync,
  readlink,
  readlinkSync,
  readv,
  readvSync,
  realpath,
  realpathSync,
  rename,
  renameSync,
  rm,
  rmSync,
  rmdir,
  rmdirSync,
  stat,
  statSync,
  statfs,
  statfsSync,
  symlink,
  symlinkSync,
  truncate,
  truncateSync,
  unlink,
  unlinkSync,
  unwatchFile,
  utimes,
  utimesSync,
  watch,
  watchFile,
  write,
  writeFile,
  writeFileSync,
  writeSync,
  writev,
  writevSync,
};
