import { EventEmitter } from "./events.js";
import { Readable, Writable } from "./stream.js";

function normalizeFd(fd) {
  const normalized = Number(fd);
  if (!Number.isInteger(normalized) || normalized < 0) {
    const error = new RangeError(`"fd" must be a positive integer: ${String(fd)}`);
    error.code = "ERR_INVALID_FD";
    throw error;
  }
  return normalized;
}

export function isatty(fd) {
  try {
    if (typeof cottontail?.isatty === "function") return Boolean(cottontail.isatty(fd));
  } catch {}
  if (fd === 0) return Boolean(globalThis.process?.stdin?.isTTY);
  if (fd === 1) return Boolean(globalThis.process?.stdout?.isTTY);
  if (fd === 2) return Boolean(globalThis.process?.stderr?.isTTY);
  return false;
}

// Node keeps these as legacy function constructors. In particular, both are
// intentionally callable without `new`.
export function ReadStream(fd) {
  if (!(this instanceof ReadStream)) return new ReadStream(fd);
  EventEmitter.call(this);
  this.fd = normalizeFd(fd);
  this.isRaw = false;
  this.isTTY = isatty(this.fd);
  this.readable = true;
}

Object.setPrototypeOf(ReadStream, Readable);
Object.setPrototypeOf(ReadStream.prototype, Readable.prototype);

ReadStream.prototype.setRawMode = function setRawMode(mode) {
  const enabled = Boolean(mode);
  cottontail.terminalSetRawMode?.(this.fd, enabled);
  this.isRaw = enabled;
  return this;
};
ReadStream.prototype.ref = function ref() { return this; };
ReadStream.prototype.unref = function unref() { return this; };

export function WriteStream(fd) {
  if (!(this instanceof WriteStream)) return new WriteStream(fd);
  EventEmitter.call(this);
  this.fd = normalizeFd(fd);
  this.isTTY = isatty(this.fd);
  this.writable = true;
}

Object.setPrototypeOf(WriteStream, Writable);
Object.setPrototypeOf(WriteStream.prototype, Writable.prototype);

Object.defineProperties(WriteStream.prototype, {
  columns: {
    configurable: true,
    enumerable: true,
    get() {
      const target = this.fd === 2 ? globalThis.process?.stderr : globalThis.process?.stdout;
      if (target && target !== this) {
        const columns = Number(target.columns);
        if (Number.isFinite(columns) && columns >= 0) return columns;
      }
      return Number(globalThis.process?.env?.COLUMNS) || 80;
    },
  },
  rows: {
    configurable: true,
    enumerable: true,
    get() {
      const target = this.fd === 2 ? globalThis.process?.stderr : globalThis.process?.stdout;
      if (target && target !== this) {
        const rows = Number(target.rows);
        if (Number.isFinite(rows) && rows >= 0) return rows;
      }
      return Number(globalThis.process?.env?.LINES) || 24;
    },
  },
});

WriteStream.prototype.write = function write(chunk, encoding = undefined, callback = undefined) {
  if (typeof encoding === "function") {
    callback = encoding;
    encoding = undefined;
  }
  const status = typeof cottontail.fdWriteStatus === "function"
    ? Number(cottontail.fdWriteStatus(this.fd, chunk))
    : cottontail.fdWrite?.(this.fd, chunk) === true ? 0 : 5;
  if (status === 0) {
    if (typeof callback === "function") queueMicrotask(() => callback(undefined));
    return true;
  }
  const error = new Error(`EIO: write, fd ${this.fd}`);
  error.code = "EIO";
  error.errno = -status;
  error.syscall = "write";
  if (typeof callback === "function") queueMicrotask(() => callback(error));
  if (!this.emit("error", error)) throw error;
  return false;
};

WriteStream.prototype.getColorDepth = function getColorDepth(env = globalThis.process?.env ?? {}) {
  if (globalThis.process?.platform === "win32") return 24;
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return 24;
  if (env.TERM_PROGRAM === "iTerm.app") {
    const version = Number.parseInt(String(env.TERM_PROGRAM_VERSION ?? ""), 10);
    return Number.isFinite(version) && version >= 3 ? 24 : 8;
  }
  if (env.TERM_PROGRAM === "Hyper" || env.TERM_PROGRAM === "MacTerm") return 24;
  if (env.TERM_PROGRAM === "Apple_Terminal" || /-256(?:color)?$/i.test(String(env.TERM ?? ""))) return 8;
  return 1;
};
WriteStream.prototype.hasColors = function hasColors(count = 16) {
  return this.isTTY && count <= 256;
};
WriteStream.prototype.getWindowSize = function getWindowSize() {
  return [this.columns, this.rows];
};
WriteStream.prototype.clearLine = function clearLine() { return true; };
WriteStream.prototype.clearScreenDown = function clearScreenDown() { return true; };
WriteStream.prototype.cursorTo = function cursorTo() { return true; };
WriteStream.prototype.moveCursor = function moveCursor() { return true; };
WriteStream.prototype.ref = function ref() { return this; };
WriteStream.prototype.unref = function unref() { return this; };
WriteStream.prototype.end = function end() { return this; };
WriteStream.prototype.destroy = function destroy() { return this; };

// Write-only stream: async iteration completes immediately (matches the
// Symbol.asyncIterator exposed on process.stdout/stderr).
WriteStream.prototype[Symbol.asyncIterator] = async function* asyncIterator() {};

export default { isatty, ReadStream, WriteStream };
