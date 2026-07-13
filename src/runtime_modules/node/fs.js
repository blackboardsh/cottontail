import "../bun/ffi.js";
import constantsObject from "./constants.js";
import { dirname, join, resolve } from "./path.js";
import { Readable, Writable } from "./stream.js";
// Imported last so constants/path/stream are initialized before the circular
// fs <-> fs/promises edge is evaluated. `fs.promises` must be the exact same
// object as the fs/promises module namespace (Node/Bun behavior relied on by
// upstream tests: require("fs/promises") === require("fs").promises).
import * as fsPromisesNamespace from "./fs/promises.js";

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
  if (path && typeof path === "object" && typeof path.href === "string" && path.protocol === "file:") {
    return decodeURIComponent(path.pathname);
  }
  return String(path);
}

const knownErrorCodes = [
  "EPERM", "ENOENT", "EIO", "EBADF", "EACCES", "EEXIST", "EXDEV", "ENOTDIR",
  "EISDIR", "EINVAL", "ENFILE", "EMFILE", "EROFS", "EPIPE", "ENOTEMPTY", "ELOOP",
  "ENAMETOOLONG", "ENOSPC", "EFBIG", "EAGAIN", "EBUSY", "EMLINK", "ENODEV", "ENXIO",
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
};

function makeFsError(error, path, syscall = "open") {
  const normalizedPath = normalizePath(path);
  const source = String(error?.message ?? error ?? "");
  let code = String(error?.code ?? "");
  if (!knownErrorCodes.includes(code)) {
    code = knownErrorCodes.find((candidate) => source.includes(candidate)) ?? "";
  }
  if (!code) {
    if (source.includes("No such file or directory")) code = "ENOENT";
    else if (source.includes("Permission denied") || source.includes("access denied")) code = "EACCES";
    else if (source.includes("already exists") || source.includes("File exists")) code = "EEXIST";
    else if (source.includes("Not a directory") || source.includes("NotDir")) code = "ENOTDIR";
    else if (source.includes("Is a directory") || source.includes("IsDir")) code = "EISDIR";
    else if (source.includes("Directory not empty") || source.includes("DirNotEmpty")) code = "ENOTEMPTY";
    else if (source.includes("Bad file descriptor")) code = "EBADF";
    else if (source.includes("Device not configured") || source.includes("No such device or address") || source.includes("NoDevice")) code = "ENXIO";
    else code = "EIO";
  }
  const reason = messageByCode[code] ?? (source || code);
  const out = new Error(`${code}: ${reason}, ${syscall} '${normalizedPath}'`);
  out.errno = -(Number(constantsObject[code]) || 5);
  out.code = code;
  out.syscall = syscall;
  out.path = normalizedPath;
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
  if (typeof options === "string") return options;
  if (options && typeof options === "object" && options.encoding != null) return options.encoding;
  return fallback;
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
    if (globalThis.Buffer?.from) return globalThis.Buffer.from(data, encoding);
    return encoder.encode(data);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return encoder.encode(String(data));
}

function decodeBytes(bytes, encoding = "utf8") {
  if (encoding === "buffer" || encoding == null) return bufferFrom(bytes);
  if (globalThis.Buffer?.from) return globalThis.Buffer.from(bytes).toString(encoding);
  return decoder.decode(bytes);
}

function readFdToEndSync(fd, options = undefined) {
  const encoding = normalizeEncoding(options);
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = new Uint8Array(64 * 1024);
    const bytesRead = readSync(fd, chunk, 0, chunk.byteLength, null);
    if (bytesRead <= 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
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
    this.dev = Number(result.dev) || 0;
    this.ino = Number(result.ino) || 0;
    this.mode = Number(result.mode) || 0;
    this.nlink = Number(result.nlink) || 0;
    this.uid = Number(result.uid) || 0;
    this.gid = Number(result.gid) || 0;
    this.rdev = Number(result.rdev) || 0;
    this.size = Number(result.size) || 0;
    this.blksize = Number(result.blksize) || 0;
    this.blocks = Number(result.blocks) || 0;
    this.atimeMs = Number(result.atimeMs) || 0;
    this.mtimeMs = Number(result.mtimeMs) || 0;
    this.ctimeMs = Number(result.ctimeMs) || 0;
    this.birthtimeMs = Number(result.birthtimeMs) || 0;
    this.atime = new Date(this.atimeMs);
    this.mtime = new Date(this.mtimeMs);
    this.ctime = new Date(this.ctimeMs);
    this.birthtime = new Date(this.birthtimeMs);
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
    this.atime = new Date(Number(result.atimeMs) || 0);
    this.mtime = new Date(Number(result.mtimeMs) || 0);
    this.ctime = new Date(Number(result.ctimeMs) || 0);
    this.birthtime = new Date(Number(result.birthtimeMs) || 0);
  }

  isFile() { return modeMatches(Number(this.mode), constants.S_IFREG ?? 0o100000); }
  isDirectory() { return modeMatches(Number(this.mode), constants.S_IFDIR ?? 0o040000); }
  isBlockDevice() { return modeMatches(Number(this.mode), constants.S_IFBLK ?? 0o060000); }
  isCharacterDevice() { return modeMatches(Number(this.mode), constants.S_IFCHR ?? 0o020000); }
  isSymbolicLink() { return modeMatches(Number(this.mode), constants.S_IFLNK ?? 0o120000); }
  isFIFO() { return modeMatches(Number(this.mode), constants.S_IFIFO ?? 0o010000); }
  isSocket() { return modeMatches(Number(this.mode), constants.S_IFSOCK ?? 0o140000); }
}

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
  constructor(name, typeOrStats = 0, path = undefined) {
    this.name = name;
    this.parentPath = path;
    this.path = path;
    if (typeof typeOrStats === "object" && typeOrStats !== null) {
      this._mode = Number(typeOrStats.mode) || 0;
    } else {
      this._mode = uvDirentTypeToMode[Number(typeOrStats)] ?? 0;
    }
  }

  isDirectory() { return modeMatches(this._mode, constants.S_IFDIR ?? 0o040000); }
  isFile() { return modeMatches(this._mode, constants.S_IFREG ?? 0o100000); }
  isBlockDevice() { return modeMatches(this._mode, constants.S_IFBLK ?? 0o060000); }
  isCharacterDevice() { return modeMatches(this._mode, constants.S_IFCHR ?? 0o020000); }
  isSymbolicLink() { return modeMatches(this._mode, constants.S_IFLNK ?? 0o120000); }
  isFIFO() { return modeMatches(this._mode, constants.S_IFIFO ?? 0o010000); }
  isSocket() { return modeMatches(this._mode, constants.S_IFSOCK ?? 0o140000); }
}

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
  return cottontail.existsSync(normalizePath(path));
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
  const encoding = normalizeEncoding(options);
  const normalizedPath = normalizePath(path);
  let raw;
  try {
    raw = cottontail.readFileBuffer(normalizedPath);
  } catch (error) {
    throw makeFsError(error, normalizedPath, "open");
  }
  const bytes = makeBuffer(raw);
  return encoding ? decodeBytes(bytes, encoding) : bytes;
}

export function writeFileSync(path, data, options = undefined) {
  if (typeof path === "number") {
    writeAllToFdSync(path, data, options);
    return;
  }
  const flag = typeof options === "object" && options?.flag ? String(options.flag) : "w";
  const encoding = normalizeEncoding(options, "utf8");
  if (flag.includes("a")) {
    appendFileSync(path, data, options);
    return;
  }
  const normalizedPath = normalizePath(path);
  cottontail.writeFile(normalizedPath, bytesFromData(data, encoding));
  const mode = typeof options === "object" && options !== null ? options.mode : undefined;
  if (mode !== undefined && mode !== null) {
    try {
      cottontail.chmodSync(normalizedPath, parseMode(mode));
    } catch {}
  }
}

export function appendFileSync(path, data, options = undefined) {
  const encoding = normalizeEncoding(options, "utf8");
  const fd = typeof path === "number" ? path : openSync(path, "a");
  try {
    writeSync(fd, bytesFromData(data, encoding));
  } finally {
    if (typeof path !== "number") closeSync(fd);
  }
}

export function openSync(path, flags = "r", mode = 0o666) {
  const normalizedPath = normalizePath(path);
  try {
    return cottontail.openFd(normalizedPath, flags ?? "r", Number(mode ?? 0o666));
  } catch (error) {
    throw makeFsError(error, normalizedPath, "open");
  }
}

export function closeSync(fd) {
  cottontail.closeFd(Number(fd));
}

export function readSync(fd, buffer, offset = 0, length = undefined, position = null) {
  if (buffer && typeof buffer === "object" && !ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
    position = buffer.position ?? null;
    length = buffer.length;
    offset = buffer.offset ?? 0;
    buffer = buffer.buffer;
  }
  const view = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : buffer;
  const byteLength = length == null ? view.byteLength - Number(offset || 0) : Number(length);
  return Number(cottontail.fdReadAt(Number(fd), view, Number(offset || 0), byteLength, position ?? null));
}

export function writeSync(fd, data, offset = undefined, length = undefined, position = null) {
  if (typeof data === "string") {
    const bytes = bytesFromData(data, typeof length === "string" ? length : "utf8");
    return Number(cottontail.fdWriteAt(Number(fd), bytes, 0, bytes.byteLength, offset ?? null));
  }
  if (data && typeof data === "object" && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer)) {
    position = data.position ?? null;
    length = data.length;
    offset = data.offset ?? 0;
    data = data.buffer;
  }
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const byteLength = length == null ? view.byteLength - Number(offset || 0) : Number(length);
  return Number(cottontail.fdWriteAt(Number(fd), view, Number(offset || 0), byteLength, position ?? null));
}

export function readvSync(fd, buffers, position = null) {
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

export function copyFileSync(source, destination, mode = 0) {
  const destinationText = normalizePath(destination);
  if ((Number(mode) & (constants.COPYFILE_EXCL ?? 1)) !== 0 && existsSync(destinationText)) {
    throw makeCodedFsError("EEXIST", "file already exists", destinationText, "copyfile");
  }
  writeFileSync(destinationText, readFileSync(source));
}

function stripTrailingSlashes(path) {
  let text = String(path);
  while (text.length > 1 && text.endsWith("/")) text = text.slice(0, -1);
  return text;
}

function cpEntrySync(source, destination, options) {
  if (options.filter && !options.filter(source, destination)) return;
  const stats = lstatSync(source);
  if (stats.isDirectory()) {
    if (!options.recursive) {
      const error = makeCodedFsError("EISDIR", "illegal operation on a directory", source, "cp");
      throw error;
    }
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      cpEntrySync(join(source, String(entry.name)), join(destination, String(entry.name)), options);
    }
    return;
  }

  const destinationStats = lstatSync(destination, { throwIfNoEntry: false });
  if (destinationStats && !options.force) {
    if (options.errorOnExist) {
      throw makeCodedFsError("EEXIST", "file already exists", destination, "cp");
    }
    return;
  }

  ensureParent(destination);
  if (stats.isSymbolicLink()) {
    if (destinationStats) unlinkSync(destination);
    symlinkSync(readlinkSync(source), destination);
  } else {
    writeFileSync(destination, readFileSync(source));
  }
}

export function cpSync(source, destination, options = {}) {
  const opts = options ?? {};
  cpEntrySync(
    stripTrailingSlashes(normalizePath(source)),
    stripTrailingSlashes(normalizePath(destination)),
    {
      recursive: Boolean(opts.recursive),
      force: opts.force === undefined ? true : Boolean(opts.force),
      errorOnExist: Boolean(opts.errorOnExist),
      filter: typeof opts.filter === "function" ? opts.filter : null,
      mode: opts.mode ?? 0,
    },
  );
}

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
    throw makeInvalidArgTypeError("options.recursive", "of type boolean", options.recursive);
  }
  return { recursive: Boolean(options.recursive) };
}

export function mkdirSync(path, options = {}) {
  validatePathArg(path);
  const { recursive } = parseMkdirOptions(options);
  const target = normalizePath(path);
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

export function mkdtempSync(prefix) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const path = `${String(prefix)}${suffix}`;
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });
      return path;
    }
  }
  throw new Error(`mkdtempSync failed for prefix ${prefix}`);
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
  cottontail.rmSync(normalizePath(path), Boolean(options?.recursive), Boolean(options?.force));
}

export function rmdirSync(path, options = {}) {
  if (options?.recursive) return rmSync(path, { recursive: true, force: false });
  cottontail.rmdirSync(normalizePath(path));
}

export function unlinkSync(path) {
  cottontail.unlinkSync(normalizePath(path));
}

export function renameSync(oldPath, newPath) {
  cottontail.renameSync(normalizePath(oldPath), normalizePath(newPath));
}

export function linkSync(existingPath, newPath) {
  cottontail.linkSync(normalizePath(existingPath), normalizePath(newPath));
}

export function symlinkSync(target, path, type = undefined) {
  void type;
  cottontail.symlinkSync(String(target), normalizePath(path));
}

export function readlinkSync(path, options = undefined) {
  const value = cottontail.readlinkSync(normalizePath(path));
  return normalizeEncoding(options) === "buffer" ? bufferFrom(encoder.encode(value)) : value;
}

export function readdirSync(path, options = undefined) {
  const withFileTypes = Boolean(options?.withFileTypes);
  const recursive = Boolean(options?.recursive);
  const encoding = normalizeEncoding(options);
  const root = normalizePath(path);
  const entries = cottontail.readDirSync(root).map((entry) => {
    const name = encoding === "buffer" ? bufferFrom(encoder.encode(entry.name)) : entry.name;
    return withFileTypes ? new Dirent(name, entry, root) : name;
  });
  if (!recursive) return entries;

  const out = [...entries];
  for (const entry of entries) {
    const name = String(withFileTypes ? entry.name : entry);
    const childPath = join(root, name);
    if ((withFileTypes ? entry : lstatSync(childPath)).isDirectory()) {
      for (const child of readdirSync(childPath, options)) {
        if (withFileTypes) out.push(child);
        else out.push(join(name, String(child)));
      }
    }
  }
  return out;
}

export function opendirSync(path, options = {}) {
  return new Dir(path, options);
}

export function statSync(path, options = undefined) {
  const normalizedPath = normalizePath(path);
  try {
    return makeStats(cottontail.statSync(normalizedPath, true), options);
  } catch (error) {
    if (shouldSuppressMissing(options)) return undefined;
    throw makeFsError(error, normalizedPath, "stat");
  }
}

export function lstatSync(path, options = undefined) {
  const normalizedPath = normalizePath(path);
  try {
    return makeStats(cottontail.statSync(normalizedPath, false), options);
  } catch (error) {
    if (shouldSuppressMissing(options)) return undefined;
    throw makeFsError(error, normalizedPath, "lstat");
  }
}

export function fstatSync(fd, options = undefined) {
  return makeStats(cottontail.fstatSync(Number(fd)), options);
}

export function statfsSync(path, options = undefined) {
  return makeStatFs(cottontail.statfsSync(normalizePath(path)), options);
}

export function realpathSync(path, options = undefined) {
  const value = cottontail.realpathSync(normalizePath(path));
  return normalizeEncoding(options) === "buffer" ? bufferFrom(encoder.encode(value)) : value;
}

realpathSync.native = realpathSync;

export function fsyncSync(fd) {
  cottontail.fsyncSync(Number(fd));
}

export function fdatasyncSync(fd) {
  cottontail.fdatasyncSync(Number(fd));
}

export function ftruncateSync(fd, len = 0) {
  cottontail.ftruncateSync(Number(fd), Number(len ?? 0));
}

export function truncateSync(path, len = 0) {
  cottontail.truncateSync(normalizePath(path), Number(len ?? 0));
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

export class ReadStream extends Readable {
  constructor(path, options = {}) {
    // Lifecycle (open/close/destroy) is managed by this class, not the engine.
    super({ autoDestroy: false, emitClose: false });
    const fd = Object.prototype.hasOwnProperty.call(options ?? {}, "fd") ? Number(options.fd) : null;
    const start = options?.start == null ? null : Number(options.start);
    defineOwnState(this, {
      path,
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
      end: options?.end == null ? null : Number(options.end),
      pos: start,
      highWaterMark: Math.max(1, Math.min(Number(options?.highWaterMark || 64 * 1024), 1024 * 1024)),
      encoding: options?.encoding,
      _ownsFd: fd == null || Number.isNaN(fd),
      _paused: false,
      _closed: false,
      _opened: false,
      _reading: false,
    });

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
    if (callback) this.once("close", callback);
    this.destroy();
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

export const FileReadStream = ReadStream;
export const Utf8Stream = ReadStream;

export function createReadStream(path, options = {}) {
  return new ReadStream(path, options);
}

export class WriteStream extends Writable {
  constructor(path, options = {}) {
    // Lifecycle (open/close/destroy) is managed by this class, not the engine.
    super({ autoDestroy: false, emitClose: false });
    const fd = Object.prototype.hasOwnProperty.call(options ?? {}, "fd") ? Number(options.fd) : null;
    const start = options?.start == null ? null : Number(options.start);
    const highWaterMark = Math.max(1, Math.min(Number(options?.highWaterMark || 16 * 1024), 1024 * 1024));
    defineOwnState(this, {
      path,
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
    });
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
    if (chunk != null) this.write(chunk, encoding);
    this.writableEnded = true;
    this.emit("finish");
    if (this.autoClose) this.close(callback);
    else if (typeof callback === "function") queueMicrotask(callback);
    return this;
  }

  close(callback = undefined) {
    if (callback) this.once("close", callback);
    this.destroy();
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
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

export const FileWriteStream = WriteStream;

export function createWriteStream(path, options = {}) {
  return new WriteStream(path, options);
}

function callbackify(action, callbackName = "callback") {
  return (...args) => {
    const callback = args[args.length - 1];
    if (typeof callback !== "function") throw makeInvalidCallbackError(callbackName, callback);
    const callArgs = args.slice(0, -1);
    queueMicrotask(() => {
      try { callback(null, action(...callArgs)); } catch (error) { callback(error); }
    });
  };
}

export const access = callbackify(accessSync);
export const appendFile = callbackify(appendFileSync);
export const chmod = callbackify(chmodSync);
export const chown = callbackify(chownSync);
export const close = callbackify(closeSync);
export const copyFile = callbackify(copyFileSync);
// Node names fs.cp's callback argument "cb" in its validation error.
export const cp = callbackify(cpSync, "cb");
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
export const mkdtemp = callbackify(mkdtempSync);
export const open = callbackify(openSync);
export const opendir = callbackify(opendirSync);
export const readFile = callbackify(readFileSync);
export const readdir = callbackify(readdirSync);
export const readlink = callbackify(readlinkSync);
export const realpath = callbackify(realpathSync);
export const rename = callbackify(renameSync);
export const rm = callbackify(rmSync);
export const rmdir = callbackify(rmdirSync);
export const stat = callbackify(statSync);
export const statfs = callbackify(statfsSync);
export const symlink = callbackify(symlinkSync);
export const truncate = callbackify(truncateSync);
export const unlink = callbackify(unlinkSync);
export const utimes = callbackify(utimesSync);
export const writeFile = callbackify(writeFileSync);

export function exists(path, callback) {
  if (typeof callback !== "function") throw makeInvalidCallbackError("callback", callback);
  queueMicrotask(() => callback(existsSync(path)));
}

export function read(fd, buffer, offset, length, position, callback) {
  if (typeof offset === "object") {
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
  queueMicrotask(() => {
    try { callback(null, writevSync(fd, buffers, position), buffers); } catch (error) { callback(error); }
  });
}

function snapshot(path, recursive) {
  const root = normalizePath(path);
  const stats = lstatSync(root);
  const entries = new Map();
  const add = (relative, fullPath, entryStats = lstatSync(fullPath)) => {
    entries.set(relative, `${entryStats.mode}:${entryStats.size}:${entryStats.mtimeMs}:${entryStats.ctimeMs}:${entryStats.birthtimeMs}`);
  };
  if (!stats.isDirectory()) {
    add(String(root).split("/").pop() || "", root, stats);
    return entries;
  }
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = String(entry.name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const fullPath = join(dir, name);
      const entryStats = lstatSync(fullPath);
      add(relative, fullPath, entryStats);
      if (recursive && entryStats.isDirectory()) walk(fullPath, relative);
    }
  };
  walk(root);
  return entries;
}

function watchFilename(name, options) {
  const encoding = normalizeEncoding(options, "utf8");
  return encoding === "buffer" ? bufferFrom(encoder.encode(name)) : name;
}

function diffSnapshots(previous, current) {
  const events = [];
  for (const [name, signature] of current) {
    if (!previous.has(name)) events.push(["rename", name]);
    else if (previous.get(name) !== signature) events.push(["change", name]);
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
  const listeners = new Map();
  let closed = false;
  let last = snapshot(normalizePath(path), Boolean(options?.recursive));
  let timer = null;
  const watcher = {
    close() {
      if (closed) return;
      closed = true;
      if (timer != null) clearInterval(timer);
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
    ref() { return watcher; },
    unref() { return watcher; },
  };
  const emit = (name, ...args) => {
    for (const handler of listeners.get(name) ?? []) handler(...args);
  };
  if (listener) watcher.on("change", listener);
  const abort = () => watcher.close();
  if (options?.signal?.aborted) watcher.close();
  else options?.signal?.addEventListener?.("abort", abort, { once: true });
  if (closed) return watcher;
  timer = setInterval(() => {
    if (closed) return;
    try {
      const next = snapshot(normalizePath(path), Boolean(options?.recursive));
      for (const [eventType, filename] of diffSnapshots(last, next)) {
        emit("change", eventType, watchFilename(filename, options));
      }
      last = next;
    } catch (error) {
      emit("error", error);
      watcher.close();
    }
  }, Number(options?.interval || 500));
  return watcher;
}

function zeroStats() {
  return makeStats({});
}

function statSnapshot(path) {
  try { return statSync(path); } catch { return zeroStats(); }
}

function statsEqual(a, b) {
  return a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.birthtimeMs === b.birthtimeMs &&
    a.atimeMs === b.atimeMs;
}

const fileWatchers = globalThis.__cottontailFileWatchers ??= new Map();

export function watchFile(path, options = {}, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  if (typeof listener !== "function") throw new TypeError("The \"listener\" argument must be of type function");
  const filename = normalizePath(path);
  let entry = fileWatchers.get(filename);
  if (!entry) {
    entry = {
      previous: statSnapshot(filename),
      listeners: new Set(),
      timer: null,
    };
    entry.timer = setInterval(() => {
      const current = statSnapshot(filename);
      if (statsEqual(current, entry.previous)) return;
      const previous = entry.previous;
      entry.previous = current;
      for (const handler of [...entry.listeners]) handler(current, previous);
    }, Math.max(1, Number(options?.interval || 5007)));
    fileWatchers.set(filename, entry);
  }
  entry.listeners.add(listener);
  return {
    close() { unwatchFile(filename, listener); return this; },
    ref() { return this; },
    unref() { return this; },
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
export const promises = fsPromisesNamespace;

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
