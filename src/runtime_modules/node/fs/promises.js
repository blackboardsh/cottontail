import constantsObject from "../constants.js";
import { EventEmitter } from "../events.js";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  Dirent,
  fchmodSync,
  fchownSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  futimesSync,
  globSync,
  lchmodSync,
  lchownSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempDisposableSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  statfsSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  watch as watchSync,
  writeFileSync,
} from "../fs.js";
import { ReadableStream as WebReadableStream } from "../stream/web.js";
import {
  allocationLimitForEncoding,
  abortReason,
  encodingFromOptions,
  invalidArgType,
  runAbortable,
  validateAbortSignal,
  validateBufferRange,
  validateFd,
  validatePosition,
} from "./internal.js";
import { cpPromiseImpl, normalizeCopyPath } from "./cp.js";

// fs.constants must be the exact same object as fsPromises.constants. Because
// fs.js and fs/promises.js form an import cycle whose evaluation order depends
// on which module is reached first, both files construct the object through a
// shared global registry: whichever module body runs first creates it and the
// other reuses it. Keep the name list below in sync with fs.js. Do not read
// fs.js bindings other than hoisted function declarations at module scope.
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
  "O_DIRECT",
  "O_NOATIME",
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

const symbolAsyncDispose = Symbol.asyncDispose ?? Symbol.for("Symbol.asyncDispose");
if (Symbol.asyncDispose == null) {
  Object.defineProperty(Symbol, "asyncDispose", { value: symbolAsyncDispose, configurable: true });
}

function installNativeFsDispatcher() {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const connectListener = globalThis.__cottontailTcpConnectListeners?.get?.(Number(event?.id));
      if (typeof connectListener === "function") {
        connectListener(event);
        return;
      }
      const fdListener = globalThis.__cottontailFdWatchListeners?.get?.(Number(event?.id));
      if (typeof fdListener === "function") {
        fdListener(event);
        return;
      }
      const tlsListener = globalThis.__cottontailTlsListeners?.get?.(Number(event?.id));
      if (typeof tlsListener === "function") tlsListener(event);
    });
  }
  return listeners;
}

function nativeFsError(event, fd, syscall) {
  const code = event?.code || "EIO";
  const error = new Error(event?.message || `${code}: ${syscall}`);
  error.code = code;
  error.errno = event?.errno == null ? undefined : -Math.abs(Number(event.errno));
  error.syscall = syscall;
  error.fd = fd;
  return error;
}

class FSReqPromise {}

function makeOutOfMemoryError() {
  const error = new Error("ENOMEM: not enough memory");
  error.errno = -(Number(constantsObject.ENOMEM) || 12);
  error.code = "ENOMEM";
  error.syscall = "read";
  return error;
}

function nativeFdRequest(kind, fd, buffer, offset, length, position, signal = null) {
  fd = validateFd(fd);
  position = validatePosition(position);
  signal = validateAbortSignal(signal);
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (length === 0) return Promise.resolve(0);

  const start = kind === "read" ? cottontail.fsAsyncReadStart : cottontail.fsAsyncWriteStart;
  if (typeof start !== "function" || typeof cottontail.fsAsyncCancel !== "function") {
    const error = new Error("Native asynchronous file I/O is unavailable");
    error.code = "ENOSYS";
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    const activeRequest = new FSReqPromise();
    globalThis.cottontail?.activeRequestRegister?.(activeRequest);
    let id;
    let settled = false;
    let aborted = false;
    let abortError;
    const listeners = installNativeFsDispatcher();
    const cleanup = () => {
      if (id !== undefined) listeners.delete(id);
      signal?.removeEventListener("abort", onAbort);
      globalThis.cottontail?.activeRequestUnregister?.(activeRequest);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      abortError = abortReason(signal);
      if (id !== undefined) cottontail.fsAsyncCancel(id);
    };
    try {
      id = Number(start(fd, buffer, offset, length, position));
      listeners.set(id, event => {
        if (aborted) finish(reject, abortError);
        else if (event?.type === "error") finish(reject, nativeFsError(event, fd, kind));
        else finish(resolve, Number(event?.result ?? 0));
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    } catch (error) {
      finish(reject, error);
    }
  });
}

function bytesForNativeWrite(data, encoding = "utf8") {
  if (typeof data === "string") {
    return globalThis.Buffer?.from
      ? globalThis.Buffer.from(data, encoding === "buffer" ? "utf8" : encoding)
      : new TextEncoder().encode(data);
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return data;
  throw invalidArgType("data", "of type string or an instance of Buffer, TypedArray, or DataView", data);
}

async function writeAllNative(fd, data, encoding, signal = null) {
  const buffer = bytesForNativeWrite(data, encoding);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const written = await nativeFdRequest("write", fd, buffer, offset, buffer.byteLength - offset, null, signal);
    if (written <= 0) break;
    offset += written;
  }
  return offset;
}

async function readFileFdNative(fd, options = undefined) {
  const encoding = encodingFromOptions(options);
  const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
  if (signal?.aborted) throw abortReason(signal);
  const allocationLimit = allocationLimitForEncoding(encoding);
  try {
    const stats = fstatSync(fd);
    if (stats.isFile() && stats.size > allocationLimit) throw makeOutOfMemoryError();
  } catch (error) {
    if (error?.code === "ENOMEM") throw error;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const chunk = globalThis.Buffer?.allocUnsafe?.(64 * 1024) ?? new Uint8Array(64 * 1024);
    const bytesRead = await nativeFdRequest("read", fd, chunk, 0, chunk.byteLength, null, signal);
    if (bytesRead === 0) break;
    if (total + bytesRead > allocationLimit) throw makeOutOfMemoryError();
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  let output;
  try {
    output = globalThis.Buffer?.allocUnsafe?.(total) ?? new Uint8Array(total);
  } catch {
    throw makeOutOfMemoryError();
  }
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (encoding && encoding !== "buffer") {
    return globalThis.Buffer?.from ? globalThis.Buffer.from(output).toString(encoding) : new TextDecoder().decode(output);
  }
  return globalThis.Buffer?.from ? globalThis.Buffer.from(output) : output;
}

async function writeFileFdNative(fd, data, options = undefined) {
  const encoding = encodingFromOptions(options, "utf8");
  const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
  const flush = options && typeof options === "object" && options.flush != null ? options.flush : false;
  if (typeof flush !== "boolean") throw invalidArgType("flush", "of type boolean", flush);
  if (signal?.aborted) throw abortReason(signal);
  await writeAllNative(fd, data, encoding, signal);
  if (flush) fsyncSync(fd);
}

export async function access(path, mode = constants.F_OK) {
  return accessSync(path, mode);
}

export async function appendFile(path, data, options = undefined) {
  const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
  if (path instanceof FileHandle) {
    return path._withRef("writeFile", () => writeFileFdNative(path.fd, data, options));
  }
  if (typeof path === "number") return writeFileFdNative(path, data, options);
  return runAbortable(() => appendFileSync(path, data, options), signal);
}

export async function chmod(path, mode) {
  return chmodSync(path, mode);
}

export async function chown(path, uid, gid) {
  return chownSync(path, uid, gid);
}

export async function close(fd) {
  return closeSync(fd);
}

export async function fchmod(fd, mode) {
  return fchmodSync(fd, mode);
}

export async function fchown(fd, uid, gid) {
  return fchownSync(fd, uid, gid);
}

export async function fstat(fd, options = undefined) {
  return fstatSync(fd, options);
}

export async function fsync(fd) {
  return fsyncSync(fd);
}

export async function fdatasync(fd) {
  return fdatasyncSync(fd);
}

export async function ftruncate(fd, len = 0) {
  return ftruncateSync(fd, len);
}

export async function futimes(fd, atime, mtime) {
  return futimesSync(fd, atime, mtime);
}

export async function read(fd, bufferOrOptions = undefined, offset = 0, length = undefined, position = null) {
  let buffer = bufferOrOptions;
  if (buffer == null || (typeof buffer === "object" && !ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer))) {
    const options = buffer ?? {};
    buffer = options.buffer ?? globalThis.Buffer?.alloc?.(16384) ?? new Uint8Array(16384);
    offset = options.offset ?? 0;
    length = options.length ?? buffer.byteLength - offset;
    position = options.position ?? null;
  }
  const range = validateBufferRange(buffer, offset, length);
  const bytesRead = await nativeFdRequest("read", fd, range.buffer, range.offset, range.length, position);
  return { bytesRead, buffer };
}

export async function write(fd, data, offsetOrPosition = undefined, lengthOrEncoding = undefined, position = null) {
  if (typeof data === "string") {
    const stringPosition = typeof offsetOrPosition === "number" || typeof offsetOrPosition === "bigint"
      ? offsetOrPosition
      : null;
    const encoding = encodingFromOptions(typeof lengthOrEncoding === "string" ? lengthOrEncoding : "utf8", "utf8");
    const bytes = bytesForNativeWrite(data, encoding);
    const bytesWritten = await nativeFdRequest("write", fd, bytes, 0, bytes.byteLength, stringPosition);
    return { bytesWritten, buffer: data };
  }
  const offset = offsetOrPosition ?? 0;
  const range = validateBufferRange(data, offset, lengthOrEncoding);
  const bytesWritten = await nativeFdRequest("write", fd, range.buffer, range.offset, range.length, position);
  return { bytesWritten, buffer: data };
}

export async function readv(fd, buffers, position = null) {
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "an ArrayBufferView[]", buffers);
  position = validatePosition(position);
  let bytesRead = 0;
  for (const buffer of buffers) {
    const range = validateBufferRange(buffer);
    const count = await nativeFdRequest("read", fd, range.buffer, 0, range.length, position);
    bytesRead += count;
    if (position !== null) position += count;
    if (count < range.length) break;
  }
  return { bytesRead, buffers };
}

export async function writev(fd, buffers, position = null) {
  if (!Array.isArray(buffers)) throw invalidArgType("buffers", "an ArrayBufferView[]", buffers);
  position = validatePosition(position);
  let bytesWritten = 0;
  for (const buffer of buffers) {
    const range = validateBufferRange(buffer);
    const count = await nativeFdRequest("write", fd, range.buffer, 0, range.length, position);
    bytesWritten += count;
    if (position !== null) position += count;
    if (count < range.length) break;
  }
  return { bytesWritten, buffers };
}

export async function copyFile(source, destination, mode = 0) {
  return copyFileSync(source, destination, mode);
}

export function cp(source, destination, options) {
  return cpPromiseImpl(
    normalizeCopyPath(source, "src"),
    normalizeCopyPath(destination, "dest"),
    options,
    getCpOperations(),
  );
}

function getCpOperations() {
  return {
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
}

export async function* glob(pattern, options) {
  for (const item of globSync(pattern, options)) yield item;
}
// Keep Node-compatible function name even if a bundler renames the binding.
Object.defineProperty(glob, "name", { value: "glob" });

export async function lchmod(path, mode) {
  return lchmodSync(path, mode);
}

export async function lchown(path, uid, gid) {
  return lchownSync(path, uid, gid);
}

export async function link(existingPath, newPath) {
  return linkSync(existingPath, newPath);
}

export async function lstat(path, options = undefined) {
  return lstatSync(path, options);
}

export async function lutimes(path, atime, mtime) {
  return lutimesSync(path, atime, mtime);
}

export async function mkdir(path, options = {}) {
  return mkdirSync(path, options);
}

export async function mkdtemp(prefix, options = undefined) {
  return mkdtempSync(prefix, options);
}

export async function mkdtempDisposable(prefix) {
  return mkdtempDisposableSync(prefix);
}

let nextFileHandleAsyncId = 1;

function badFileDescriptor(syscall) {
  const error = new Error("Bad file descriptor");
  error.code = "EBADF";
  error.name = "SystemError";
  error.syscall = syscall;
  return error;
}

function createReadLinesInterface(stream) {
  let closed = false;
  const lines = {
    close() {
      closed = true;
      stream.close?.();
    },
    async *[Symbol.asyncIterator]() {
      let buffered = "";
      try {
        for await (const chunk of stream) {
          if (closed) break;
          buffered += String(chunk);
          for (;;) {
            const match = buffered.match(/\r?\n/);
            if (!match) break;
            const line = buffered.slice(0, match.index);
            buffered = buffered.slice(match.index + match[0].length);
            yield line;
          }
        }
        if (!closed && buffered.length > 0) yield buffered.replace(/\r$/, "");
      } finally {
        if (!closed) lines.close();
      }
    },
  };
  return lines;
}

class FileHandle extends EventEmitter {
  constructor(fd, path, flags = "r") {
    super();
    this.fd = fd;
    this.path = path;
    this.flags = flags;
    this._asyncId = nextFileHandleAsyncId++;
    this._closed = false;
    this._closing = false;
    this._refs = 1;
    this._closePromise = null;
    this._closeResolve = null;
    this._closeReject = null;
  }

  _assertOpen(syscall) {
    if (this.fd < 0 || this._closing) throw badFileDescriptor(syscall);
    return this.fd;
  }

  _emitClose() {
    if (this._closed) return;
    this._closed = true;
    this.emit("close");
  }

  _finishClose() {
    if (!this._closing || this._refs !== 0 || this.fd < 0) return;
    const fd = this.fd;
    this.fd = -1;
    try {
      closeSync(fd);
      this._closeResolve?.();
    } catch (error) {
      this._closeReject?.(error);
    }
  }

  _unref() {
    if (this._refs <= 0) return;
    this._refs -= 1;
    this._finishClose();
  }

  _acquireStreamRef(syscall) {
    const fd = this._assertOpen(syscall);
    this._refs += 1;
    return fd;
  }

  _releaseStreamRef() {
    this._unref();
    return this._closePromise;
  }

  _withRef(syscall, operation) {
    let result;
    let acquired = false;
    try {
      this._assertOpen(syscall);
      this._refs += 1;
      acquired = true;
      result = operation();
    } catch (error) {
      if (acquired) this._unref();
      return Promise.reject(error);
    }
    return Promise.resolve(result).finally(() => this._unref());
  }

  appendFile(data, options = undefined) {
    return this._withRef("writeFile", () => appendFile(this.fd, data, options));
  }
  chmod(mode) { return this._withRef("fchmod", () => fchmodSync(this.fd, mode)); }
  chown(uid, gid) { return this._withRef("fchown", () => fchownSync(this.fd, uid, gid)); }
  close() {
    if (this.fd < 0) return this._closePromise ?? Promise.resolve();
    if (this._closePromise) return this._closePromise;
    this._closing = true;
    this._refs -= 1;
    this._closePromise = new Promise((resolve, reject) => {
      this._closeResolve = resolve;
      this._closeReject = reject;
    });
    const closePromise = this._closePromise;
    closePromise.then(
      () => this._clearClosePromise(closePromise),
      () => this._clearClosePromise(closePromise),
    );
    this._emitClose();
    this._finishClose();
    return closePromise;
  }
  _clearClosePromise(closePromise) {
    if (this._closePromise !== closePromise) return;
    this._closePromise = null;
    this._closeResolve = null;
    this._closeReject = null;
  }
  createReadStream(options = {}) {
    this._assertOpen("createReadStream");
    return createReadStream(this.path, { highWaterMark: 64 * 1024, ...options, fd: this });
  }
  createWriteStream(options = {}) {
    this._assertOpen("createWriteStream");
    return createWriteStream(this.path, { highWaterMark: 64 * 1024, ...options, fd: this });
  }
  datasync() { return this._withRef("fdatasync", () => fdatasyncSync(this.fd)); }
  getAsyncId() { return this._asyncId; }
  read(bufferOrOptions = undefined, offset = undefined, length = undefined, position = undefined) {
    let buffer = bufferOrOptions;
    if (!ArrayBuffer.isView(buffer) && !(buffer instanceof ArrayBuffer)) {
      if (buffer != null && (typeof buffer !== "object" || Array.isArray(buffer))) {
        return Promise.reject(invalidArgType("options", "of type object", buffer));
      }
      const options = buffer ?? {};
      buffer = options.buffer ?? globalThis.Buffer?.alloc?.(16384) ?? new Uint8Array(16384);
      offset = options.offset ?? 0;
      length = options.length ?? buffer.byteLength - offset;
      position = options.position ?? null;
    } else if (offset && typeof offset === "object") {
      const options = offset;
      offset = options.offset ?? 0;
      length = options.length ?? buffer.byteLength - offset;
      position = options.position ?? null;
    } else {
      offset ??= 0;
      length ??= buffer.byteLength - offset;
      position ??= null;
    }
    return this._withRef("read", () => read(this.fd, buffer, offset, length, position));
  }
  readFile(options = undefined) { return this._withRef("readFile", () => readFile(this.fd, options)); }
  readLines(options = {}) {
    return createReadLinesInterface(this.createReadStream({ ...options, encoding: options?.encoding ?? "utf8" }));
  }
  readableWebStream(options = {}) {
    this._assertOpen("readableWebStream");
    const highWaterMark = Math.max(1, Math.min(Number(options?.highWaterMark || 64 * 1024), 1024 * 1024));
    return new WebReadableStream({
      pull: (controller) => {
        try {
          const chunk = new Uint8Array(highWaterMark);
          const bytesRead = readSync(this.fd, chunk, 0, chunk.byteLength, null);
          if (bytesRead <= 0) {
            controller.close();
            return;
          }
          controller.enqueue(chunk.subarray(0, bytesRead));
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }
  readv(buffers, position = null) {
    return this._withRef("readv", () => readv(this.fd, buffers, position));
  }
  stat(options = undefined) { return this._withRef("fstat", () => fstatSync(this.fd, options)); }
  sync() { return this._withRef("fsync", () => fsyncSync(this.fd)); }
  truncate(len = 0) { return this._withRef("ftruncate", () => ftruncateSync(this.fd, len)); }
  utimes(atime, mtime) { return this._withRef("futimes", () => futimesSync(this.fd, atime, mtime)); }
  write(data, offsetOrOptions = undefined, length = undefined, position = undefined) {
    if (typeof data === "string") {
      // write(string[, position[, encoding]]): default position null writes at
      // the current file offset (so append-mode handles keep appending).
      const stringPosition = typeof offsetOrOptions === "number" || typeof offsetOrOptions === "bigint" ? offsetOrOptions : null;
      const encoding = typeof length === "string" ? length : "utf8";
      return this._withRef("write", () => write(this.fd, data, stringPosition, encoding));
    }
    let offset = offsetOrOptions;
    if (offset !== null && typeof offset === "object") {
      position = offset.position ?? null;
      length = offset.length;
      offset = offset.offset ?? 0;
    }
    return this._withRef("write", () => write(this.fd, data, offset ?? 0, length, position ?? null));
  }
  writeFile(data, options = undefined) {
    return this._withRef("writeFile", () => writeFile(this.fd, data, {
      ...(typeof options === "object" && options !== null ? options : {}),
      encoding: typeof options === "string" ? options : options?.encoding,
      flag: this.flags,
    }));
  }
  writev(buffers, position = null) {
    return this._withRef("writev", () => writev(this.fd, buffers, position));
  }
  [symbolAsyncDispose]() { return this.close(); }
}

export async function open(path, flags = "r", mode = 0o666) {
  return new FileHandle(openSync(path, flags, mode), String(path), flags);
}

export async function opendir(path, options = {}) {
  return opendirSync(path, options);
}

export function readFile(path, options = undefined) {
  try {
    const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (path instanceof FileHandle) {
      return path._withRef("readFile", () => readFileFdNative(path.fd, options));
    }
    if (typeof path === "number") return readFileFdNative(path, options);
    return runAbortable(() => readFileSync(path, options), signal);
  } catch (error) {
    return Promise.reject(error);
  }
}

// COTTONTAIL-COMPAT: The current host exposes a synchronous directory scanner.
// Coalesce only simultaneously submitted recursive reads so promise-based
// stress does not serialize hundreds of identical native walks.
const pendingRecursiveReaddir = new Map();

function cloneReaddirResult(result) {
  const cloned = new Array(result.length);
  for (let index = 0; index < result.length; index += 1) {
    const value = result[index];
    if (value instanceof Dirent) {
      const name = ArrayBuffer.isView(value.name)
        ? globalThis.Buffer?.from(value.name) ?? value.name.slice()
        : value.name;
      cloned[index] = new Dirent(name, value, value.parentPath);
    } else if (ArrayBuffer.isView(value)) {
      cloned[index] = globalThis.Buffer?.from(value) ?? value.slice();
    } else {
      cloned[index] = value;
    }
  }
  return cloned;
}

export function readdir(path, options = undefined) {
  if (!options || typeof options !== "object" || !options.recursive) {
    return Promise.resolve().then(() => readdirSync(path, options));
  }

  const key = JSON.stringify([
    path && typeof path === "object" && typeof path.href === "string" ? path.href : String(path),
    Boolean(options.withFileTypes),
    options.encoding ?? null,
  ]);
  let operation = pendingRecursiveReaddir.get(key);
  if (!operation) {
    operation = Promise.resolve().then(() => readdirSync(path, options));
    pendingRecursiveReaddir.set(key, operation);
    const clear = () => {
      if (pendingRecursiveReaddir.get(key) === operation) pendingRecursiveReaddir.delete(key);
    };
    operation.then(clear, clear);
  }
  return operation.then(cloneReaddirResult);
}

export async function readlink(path, options = undefined) {
  return readlinkSync(path, options);
}

export async function realpath(path, options = undefined) {
  return realpathSync(path, options);
}

export async function rename(oldPath, newPath) {
  return renameSync(oldPath, newPath);
}

export async function rm(path, options = {}) {
  return rmSync(path, options);
}

export async function rmdir(path, options = {}) {
  return rmdirSync(path, options);
}

export async function stat(path, options = undefined) {
  return statSync(path, options);
}

export async function statfs(path, options = undefined) {
  return statfsSync(path, options);
}

export async function symlink(target, path, type = undefined) {
  return symlinkSync(target, path, type);
}

export async function truncate(path, len = 0) {
  return truncateSync(path, len);
}

export async function unlink(path) {
  return unlinkSync(path);
}

export async function utimes(path, atime, mtime) {
  return utimesSync(path, atime, mtime);
}

export function watch(path, options = {}) {
  const events = [];
  const waiters = [];
  let terminalError = null;
  let closed = false;

  const settleWaiters = () => {
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      if (events.length > 0) {
        waiter.resolve({ value: events.shift(), done: false });
      } else if (terminalError) {
        waiter.reject(terminalError);
      } else if (closed) {
        waiter.resolve({ value: undefined, done: true });
      } else {
        waiters.unshift(waiter);
        break;
      }
    }
  };

  const watcher = watchSync(path, options, (eventType, filename) => {
    events.push({ eventType, filename });
    settleWaiters();
  });
  watcher.once("error", error => {
    terminalError = error;
    settleWaiters();
  });
  watcher.once("close", () => {
    closed = true;
    settleWaiters();
  });

  const iterator = {
    next() {
      if (events.length > 0) {
        return Promise.resolve({ value: events.shift(), done: false });
      }
      if (terminalError) return Promise.reject(terminalError);
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    return() {
      events.length = 0;
      watcher.close();
      closed = true;
      settleWaiters();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(error) {
      watcher.close();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return iterator;
}

function isStreamLikeData(data) {
  if (data == null || typeof data === "string") return false;
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return false;
  if (typeof data !== "object" && typeof data !== "function") return false;
  return typeof data[Symbol.asyncIterator] === "function" ||
    typeof data[Symbol.iterator] === "function" ||
    (typeof data.pipe === "function" && typeof data.on === "function");
}

async function writeChunkToFd(fd, chunk, encoding, signal) {
  if (typeof chunk === "string") {
    await writeAllNative(fd, chunk, encoding, signal);
    return;
  }
  if (ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer) {
    await writeAllNative(fd, chunk, encoding, signal);
    return;
  }
  const error = new TypeError(
    'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.',
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
}

async function writeFileIterable(path, data, options, encoding, signal) {
  const flag = (typeof options === "object" && options?.flag) || "w";
  // Open before touching the iterator so path errors (e.g. EISDIR) surface
  // without consuming the input, matching Node.
  const fileHandleFd = path instanceof FileHandle
    ? path._assertOpen("writeFile")
    : path !== null && typeof path === "object" && typeof path.fd === "number"
      ? path.fd
      : null;
  const fd = fileHandleFd ?? (typeof path === "number" ? path : openSync(path, flag, 0o666));
  const ownsFd = fileHandleFd == null && typeof path !== "number";
  try {
    for await (const chunk of data) {
      if (signal?.aborted) throw abortReason(signal);
      await writeChunkToFd(fd, chunk, encoding, signal);
    }
  } finally {
    if (ownsFd) closeSync(fd);
  }
}

export function writeFile(path, data, options = undefined) {
  try {
    const encoding = encodingFromOptions(options, "utf8");
    const signal = validateAbortSignal(options && typeof options === "object" ? options.signal : null);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    if (path instanceof FileHandle) {
      return path._withRef("writeFile", () => isStreamLikeData(data)
        ? writeFileIterable(path.fd, data, options, encoding, signal)
        : writeFileFdNative(path.fd, data, options));
    }
    if (isStreamLikeData(data)) return writeFileIterable(path, data, options, encoding, signal);
    if (typeof path === "number") return writeFileFdNative(path, data, options);
    return runAbortable(() => writeFileSync(path, data, options), signal);
  } catch (error) {
    return Promise.reject(error);
  }
}

// Bun extends fs.promises with exists(); it never rejects.
export async function exists(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export default {
  access,
  appendFile,
  exists,
  chmod,
  chown,
  close,
  constants,
  copyFile,
  cp,
  fchmod,
  fchown,
  fstat,
  fsync,
  fdatasync,
  ftruncate,
  futimes,
  glob,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  mkdtempDisposable,
  open,
  opendir,
  read,
  readFile,
  readdir,
  readlink,
  readv,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  write,
  writeFile,
  writev,
};
