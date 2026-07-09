import "../bun/ffi.js";
import constantsObject from "./constants.js";
import { dirname, join, resolve } from "./path.js";
import { Readable, Writable } from "./stream.js";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

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

export const constants = Object.freeze(Object.fromEntries(
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

function normalizeEncoding(options, fallback = undefined) {
  if (typeof options === "string") return options;
  if (options && typeof options === "object" && options.encoding != null) return options.encoding;
  return fallback;
}

function bufferFrom(bytes) {
  return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : makeBuffer(bytes);
}

function makeBuffer(arrayBufferOrView) {
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

export class Stats {
  constructor(result = {}) {
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

function makeStats(result) {
  return new Stats(result);
}

export class Dirent {
  constructor(name, typeOrStats = 0, path = undefined) {
    this.name = name;
    this.parentPath = path;
    this.path = path;
    this._mode = typeof typeOrStats === "object" ? Number(typeOrStats.mode) || 0 : Number(typeOrStats) || 0;
  }

  isDirectory() { return modeMatches(this._mode, constants.S_IFDIR ?? 0o040000); }
  isFile() { return modeMatches(this._mode, constants.S_IFREG ?? 0o100000); }
  isBlockDevice() { return modeMatches(this._mode, constants.S_IFBLK ?? 0o060000); }
  isCharacterDevice() { return modeMatches(this._mode, constants.S_IFCHR ?? 0o020000); }
  isSymbolicLink() { return modeMatches(this._mode, constants.S_IFLNK ?? 0o120000); }
  isFIFO() { return modeMatches(this._mode, constants.S_IFIFO ?? 0o010000); }
  isSocket() { return modeMatches(this._mode, constants.S_IFSOCK ?? 0o140000); }
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
    if (typeof callback === "function") {
      queueMicrotask(() => {
        try { callback(null, this.readSync()); } catch (error) { callback(error); }
      });
      return;
    }
    return Promise.resolve().then(() => this.readSync());
  }

  readSync() {
    if (this.closed) throw new Error("Directory handle is closed");
    return this.index < this.entriesList.length ? this.entriesList[this.index++] : null;
  }

  close(callback = undefined) {
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
  cottontail.accessSync(normalizePath(path), Number(mode ?? F_OK));
}

export function readFileSync(path, options = undefined) {
  const encoding = normalizeEncoding(options);
  const bytes = makeBuffer(cottontail.readFileBuffer(normalizePath(path)));
  return encoding ? decodeBytes(bytes, encoding) : bytes;
}

export function writeFileSync(path, data, options = undefined) {
  const flag = typeof options === "object" && options?.flag ? String(options.flag) : "w";
  const encoding = normalizeEncoding(options, "utf8");
  if (flag.includes("a")) {
    appendFileSync(path, data, options);
    return;
  }
  cottontail.writeFile(normalizePath(path), bytesFromData(data, encoding));
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
  return cottontail.openFd(normalizePath(path), flags ?? "r", Number(mode ?? 0o666));
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

export function writeSync(fd, data, offset = 0, length = undefined, position = null) {
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

export function copyFileSync(source, destination, mode = 0) {
  const destinationText = normalizePath(destination);
  if ((Number(mode) & (constants.COPYFILE_EXCL ?? 1)) !== 0 && existsSync(destinationText)) {
    throw new Error(`EEXIST: file already exists, copyfile '${source}' -> '${destination}'`);
  }
  writeFileSync(destinationText, readFileSync(source));
}

function copyDirectorySync(source, destination, options) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      if (!options.recursive) throw new Error(`EISDIR: illegal operation on a directory, copyfile '${from}'`);
      copyDirectorySync(from, to, options);
    } else if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else {
      copyFileSync(from, to, options.mode ?? 0);
    }
  }
}

export function cpSync(source, destination, options = {}) {
  const from = normalizePath(source);
  const to = normalizePath(destination);
  const stats = lstatSync(from);
  if (stats.isDirectory()) {
    if (!options?.recursive) throw new Error(`EISDIR: illegal operation on a directory, copyfile '${from}'`);
    copyDirectorySync(from, to, options ?? {});
  } else if (stats.isSymbolicLink()) {
    symlinkSync(readlinkSync(from), to);
  } else {
    copyFileSync(from, to, options?.mode ?? 0);
  }
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

export function mkdirSync(path, options = {}) {
  const recursive = typeof options === "object" ? Boolean(options?.recursive) : false;
  cottontail.mkdirSync(normalizePath(path), recursive);
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
  return rmSync(path, { recursive: false, force: false });
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
  void options;
  return makeStats(cottontail.statSync(normalizePath(path), true));
}

export function lstatSync(path, options = undefined) {
  void options;
  return makeStats(cottontail.statSync(normalizePath(path), false));
}

export function fstatSync(fd, options = undefined) {
  void options;
  return makeStats(cottontail.fstatSync(Number(fd)));
}

export function statfsSync(path, options = undefined) {
  void options;
  return cottontail.statfsSync(normalizePath(path));
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

export class ReadStream extends Readable {
  constructor(path, options = {}) {
    super();
    this.path = path;
    this.flags = options?.flags || "r";
    this.mode = options?.mode ?? 0o666;
    this.fd = Object.prototype.hasOwnProperty.call(options ?? {}, "fd") ? Number(options.fd) : null;
    this.autoClose = options?.autoClose !== false;
    this.destroyed = false;
    this.readableEnded = false;
    this.bytesRead = 0;
    this.pending = true;
    this.start = options?.start == null ? null : Number(options.start);
    this.end = options?.end == null ? null : Number(options.end);
    this.pos = this.start;
    this.highWaterMark = Math.max(1, Math.min(Number(options?.highWaterMark || 64 * 1024), 1024 * 1024));
    this.encoding = options?.encoding;
    this._ownsFd = this.fd == null || Number.isNaN(this.fd);

    queueMicrotask(() => this._pump());
  }

  _open() {
    if (this.fd == null || Number.isNaN(this.fd)) {
      this.fd = openSync(this.path, this.flags, this.mode);
      this._ownsFd = true;
    }
    this.pending = false;
    this.emit("open", this.fd);
    this.emit("ready");
  }

  _close() {
    if (this.fd != null && (this.autoClose || this._ownsFd)) {
      try { closeSync(this.fd); } catch {}
    }
    this.fd = null;
    this.emit("close");
  }

  _pump() {
    if (this.destroyed) return;
    try {
      this._open();
      while (!this.destroyed) {
        const remaining = this.end == null || this.pos == null ? this.highWaterMark : Math.max(0, this.end - this.pos + 1);
        const length = Math.min(this.highWaterMark, remaining);
        if (length <= 0) break;
        const chunk = new Uint8Array(length);
        const bytesRead = readSync(this.fd, chunk, 0, length, this.pos);
        if (bytesRead <= 0) break;
        this.bytesRead += bytesRead;
        if (this.pos != null) this.pos += bytesRead;
        const value = chunk.subarray(0, bytesRead);
        this.push(this.encoding ? decodeBytes(value, this.encoding) : bufferFrom(value));
        if (bytesRead < length) break;
      }
      this.readableEnded = true;
      this.destroyed = true;
      this.push(null);
      this._close();
    } catch (error) {
      this.destroy(error);
    }
  }

  close(callback = undefined) {
    if (callback) this.once("close", callback);
    this.destroy();
  }

  destroy(error = undefined) {
    if (this.destroyed && this.fd == null) return this;
    this.destroyed = true;
    if (error) this.emit("error", error);
    this._close();
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
    super();
    this.path = path;
    this.flags = options?.flags || "w";
    this.mode = options?.mode ?? 0o666;
    this.fd = Object.prototype.hasOwnProperty.call(options ?? {}, "fd") ? Number(options.fd) : null;
    this.autoClose = options?.autoClose !== false;
    this.bytesWritten = 0;
    this.pending = true;
    this.destroyed = false;
    this._ownsFd = this.fd == null || Number.isNaN(this.fd);
    queueMicrotask(() => this._open());
  }

  _open() {
    if (this.destroyed) return;
    if (this.fd == null || Number.isNaN(this.fd)) {
      ensureParent(normalizePath(this.path));
      this.fd = openSync(this.path, this.flags, this.mode);
      this._ownsFd = true;
    }
    this.pending = false;
    this.emit("open", this.fd);
    this.emit("ready");
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    try {
      if (this.pending) this._open();
      const bytes = bytesFromData(chunk, encoding ?? "utf8");
      this.bytesWritten += writeSync(this.fd, bytes);
      if (callback) callback(null);
    } catch (error) {
      if (callback) callback(error);
      this.emit("error", error);
    }
    return true;
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
    this.emit("finish");
    this.close(callback);
  }

  close(callback = undefined) {
    if (callback) this.once("close", callback);
    this.destroy();
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (this.fd != null && (this.autoClose || this._ownsFd)) {
      try { closeSync(this.fd); } catch {}
    }
    this.fd = null;
    if (error) this.emit("error", error);
    this.emit("close");
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

function callbackify(action) {
  return (...args) => {
    const callback = args[args.length - 1];
    if (typeof callback !== "function") throw new TypeError("Callback must be a function");
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
export const cp = callbackify(cpSync);
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
export const mkdir = callbackify(mkdirSync);
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
  if (typeof callback !== "function") throw new TypeError("Callback must be a function");
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
  if (typeof callback !== "function") throw new TypeError("Callback must be a function");
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
  if (typeof callback !== "function") throw new TypeError("Callback must be a function");
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
  if (typeof callback !== "function") throw new TypeError("Callback must be a function");
  queueMicrotask(() => {
    try { callback(null, readvSync(fd, buffers, position), buffers); } catch (error) { callback(error); }
  });
}

export function writev(fd, buffers, position = null, callback = undefined) {
  if (typeof position === "function") {
    callback = position;
    position = null;
  }
  if (typeof callback !== "function") throw new TypeError("Callback must be a function");
  queueMicrotask(() => {
    try { callback(null, writevSync(fd, buffers, position), buffers); } catch (error) { callback(error); }
  });
}

function snapshot(path, recursive) {
  const command = recursive
    ? `cd '${String(path).replace(/'/g, "'\\''")}' && find . -type f -o -type d | sort`
    : `cd '${String(path).replace(/'/g, "'\\''")}' && ls -A | sort`;
  const result = cottontail.spawnSync("sh", ["-c", command], { stdio: "pipe" });
  return result.status === 0 ? result.stdout : "";
}

export function watch(path, options = {}, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  const listeners = new Map();
  let closed = false;
  let last = snapshot(normalizePath(path), Boolean(options?.recursive));
  const watcher = {
    close() {
      closed = true;
      clearInterval(timer);
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
    ref() { return watcher; },
    unref() { return watcher; },
  };
  const emit = (name, ...args) => {
    for (const handler of listeners.get(name) ?? []) handler(...args);
  };
  if (listener) watcher.on("change", listener);
  const timer = setInterval(() => {
    if (closed) return;
    const next = snapshot(normalizePath(path), Boolean(options?.recursive));
    if (next !== last) {
      last = next;
      emit("change", "change", "");
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

function globToRegExp(pattern) {
  const globstar = "\x00";
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, globstar)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll(globstar, ".*");
  return new RegExp(`^${escaped}$`);
}

function walkFiles(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : String(entry.name);
    out.push(relative);
    if (entry.isDirectory()) out.push(...walkFiles(join(root, String(entry.name)), relative));
  }
  return out;
}

export function globSync(pattern, options = {}) {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const cwd = normalizePath(options?.cwd ?? ".");
  const matches = [];
  for (const item of walkFiles(cwd)) {
    if (patterns.some((candidate) => globToRegExp(candidate).test(item))) {
      matches.push(options?.absolute ? resolve(cwd, item) : item);
    }
  }
  return matches;
}

export function glob(pattern, options = {}, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  if (typeof callback === "function") {
    queueMicrotask(() => {
      try { callback(null, globSync(pattern, options)); } catch (error) { callback(error); }
    });
    return;
  }
  return Promise.resolve(globSync(pattern, options));
}

// COTTONTAIL-COMPAT: node:fs glob/watch/streams - simplified JS implementations cover common behavior; harden against Node's full option/error edge cases.

export const promises = {
  access: async (path, mode = F_OK) => accessSync(path, mode),
  appendFile: async (path, data, options = undefined) => appendFileSync(path, data, options),
  chmod: async (path, mode) => chmodSync(path, mode),
  chown: async (path, uid, gid) => chownSync(path, uid, gid),
  constants,
  copyFile: async (source, destination, mode = 0) => copyFileSync(source, destination, mode),
  cp: async (source, destination, options = {}) => cpSync(source, destination, options),
  glob: async (pattern, options = {}) => globSync(pattern, options),
  lchmod: async (path, mode) => lchmodSync(path, mode),
  lchown: async (path, uid, gid) => lchownSync(path, uid, gid),
  link: async (existingPath, newPath) => linkSync(existingPath, newPath),
  lstat: async (path, options = undefined) => lstatSync(path, options),
  lutimes: async (path, atime, mtime) => lutimesSync(path, atime, mtime),
  mkdir: async (path, options = {}) => mkdirSync(path, options),
  mkdtemp: async (prefix) => mkdtempSync(prefix),
  mkdtempDisposable: async (prefix) => mkdtempDisposableSync(prefix),
  open: async (path, flags = "r", mode = 0o666) => new FileHandle(openSync(path, flags, mode), normalizePath(path)),
  opendir: async (path, options = {}) => opendirSync(path, options),
  readFile: async (path, options = undefined) => readFileSync(path, options),
  readdir: async (path, options = undefined) => readdirSync(path, options),
  readlink: async (path, options = undefined) => readlinkSync(path, options),
  realpath: async (path, options = undefined) => realpathSync(path, options),
  rename: async (oldPath, newPath) => renameSync(oldPath, newPath),
  rm: async (path, options = {}) => rmSync(path, options),
  rmdir: async (path, options = {}) => rmdirSync(path, options),
  stat: async (path, options = undefined) => statSync(path, options),
  statfs: async (path, options = undefined) => statfsSync(path, options),
  symlink: async (target, path, type = undefined) => symlinkSync(target, path, type),
  truncate: async (path, len = 0) => truncateSync(path, len),
  unlink: async (path) => unlinkSync(path),
  utimes: async (path, atime, mtime) => utimesSync(path, atime, mtime),
  watch: async (path, options = {}) => watch(path, options),
  writeFile: async (path, data, options = undefined) => writeFileSync(path, data, options),
};

class FileHandle {
  constructor(fd, path) {
    this.fd = fd;
    this.path = path;
  }

  appendFile(data, options = undefined) { return promises.appendFile(this.fd, data, options); }
  chmod(mode) { return Promise.resolve(fchmodSync(this.fd, mode)); }
  chown(uid, gid) { return Promise.resolve(fchownSync(this.fd, uid, gid)); }
  close() { const fd = this.fd; this.fd = -1; return Promise.resolve(closeSync(fd)); }
  datasync() { return Promise.resolve(fdatasyncSync(this.fd)); }
  read(buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
    return Promise.resolve({ bytesRead: readSync(this.fd, buffer, offset, length, position), buffer });
  }
  readFile(options = undefined) { return Promise.resolve(readFileSync(this.path, options)); }
  stat(options = undefined) { return Promise.resolve(fstatSync(this.fd, options)); }
  sync() { return Promise.resolve(fsyncSync(this.fd)); }
  truncate(len = 0) { return Promise.resolve(ftruncateSync(this.fd, len)); }
  utimes(atime, mtime) { return Promise.resolve(futimesSync(this.fd, atime, mtime)); }
  write(data, offset = 0, length = undefined, position = null) {
    return Promise.resolve({ bytesWritten: writeSync(this.fd, data, offset, length, position), buffer: data });
  }
  writeFile(data, options = undefined) { return promises.writeFile(this.path, data, options); }
}

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
