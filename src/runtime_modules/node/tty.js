import { EventEmitter } from "./events.js";

export function isatty(fd) {
  try {
    if (typeof cottontail?.isatty === "function") return Boolean(cottontail.isatty(fd));
  } catch {}
  if (fd === 0) return Boolean(globalThis.process?.stdin?.isTTY);
  if (fd === 1) return Boolean(globalThis.process?.stdout?.isTTY);
  if (fd === 2) return Boolean(globalThis.process?.stderr?.isTTY);
  return false;
}

export class ReadStream extends EventEmitter {
  constructor(fd) {
    super();
    this.fd = fd;
    this.isRaw = false;
    this.isTTY = isatty(fd);
    this.readable = true;
  }

  setRawMode(mode) {
    this.isRaw = Boolean(mode);
    return this;
  }

  ref() { return this; }
  unref() { return this; }
  pause() { return this; }
  resume() { return this; }
  destroy() { return this; }
}

export class WriteStream extends EventEmitter {
  constructor(fd) {
    super();
    this.fd = fd;
    this.isTTY = isatty(fd);
    this.writable = true;
  }

  get columns() {
    const target = this.fd === 2 ? globalThis.process?.stderr : globalThis.process?.stdout;
    return target?.columns ?? (Number(globalThis.process?.env?.COLUMNS) || 80);
  }

  get rows() {
    const target = this.fd === 2 ? globalThis.process?.stderr : globalThis.process?.stdout;
    return target?.rows ?? (Number(globalThis.process?.env?.LINES) || 24);
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    const target = this.fd === 2 ? globalThis.process?.stderr : globalThis.process?.stdout;
    const ok = target?.write?.(chunk) ?? true;
    if (typeof callback === "function") queueMicrotask(() => callback());
    return ok;
  }

  getColorDepth() {
    return this.isTTY ? 8 : 1;
  }

  hasColors(count = 16) {
    return this.isTTY && count <= 256;
  }

  getWindowSize() {
    return [this.columns, this.rows];
  }

  clearLine() { return true; }
  clearScreenDown() { return true; }
  cursorTo() { return true; }
  moveCursor() { return true; }
  ref() { return this; }
  unref() { return this; }
  end() { return this; }
  destroy() { return this; }

  // Write-only stream: async iteration completes immediately (matches the
  // Symbol.asyncIterator exposed on process.stdout/stderr).
  async *[Symbol.asyncIterator]() {}
}

export default { isatty, ReadStream, WriteStream };
