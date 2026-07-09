import { EventEmitter } from "./events.js";

function writeControl(stream, text, callback = undefined) {
  const done = typeof callback === "function" ? callback : () => {};
  if (stream && typeof stream.write === "function") {
    stream.write(text, done);
  } else {
    done();
  }
  return true;
}

function keyFromSequence(sequence) {
  if (sequence === "\r" || sequence === "\n") return { sequence, name: "return", ctrl: false, meta: false, shift: false };
  if (sequence === "\t") return { sequence, name: "tab", ctrl: false, meta: false, shift: false };
  if (sequence === "\x7f") return { sequence, name: "backspace", ctrl: false, meta: false, shift: false };
  if (sequence === "\x1b[A") return { sequence, name: "up", ctrl: false, meta: false, shift: false };
  if (sequence === "\x1b[B") return { sequence, name: "down", ctrl: false, meta: false, shift: false };
  if (sequence === "\x1b[C") return { sequence, name: "right", ctrl: false, meta: false, shift: false };
  if (sequence === "\x1b[D") return { sequence, name: "left", ctrl: false, meta: false, shift: false };
  const code = sequence.charCodeAt(0);
  if (code > 0 && code < 27) return { sequence, name: String.fromCharCode(code + 96), ctrl: true, meta: false, shift: false };
  return { sequence, name: sequence.length === 1 ? sequence.toLowerCase() : undefined, ctrl: false, meta: sequence.startsWith("\x1b"), shift: sequence.length === 1 && sequence.toUpperCase() === sequence && sequence.toLowerCase() !== sequence };
}

export class Interface extends EventEmitter {
  constructor(options = {}) {
    super();
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.terminal = Boolean(options.terminal);
    this.closed = false;
    this._buffer = "";

    this._onData = (chunk) => {
      const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      this._buffer += text;
      for (;;) {
        const newlineIndex = this._buffer.search(/\r?\n/);
        if (newlineIndex < 0) break;
        const end = this._buffer[newlineIndex] === "\r" && this._buffer[newlineIndex + 1] === "\n"
          ? newlineIndex + 2
          : newlineIndex + 1;
        const line = this._buffer.slice(0, newlineIndex);
        this._buffer = this._buffer.slice(end);
        this.emit("line", line);
      }
    };
    this._onClose = () => this.close();

    this.input?.on?.("data", this._onData);
    this.input?.on?.("end", this._onClose);
    this.input?.on?.("close", this._onClose);
    this.input?.resume?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this._buffer.length > 0) {
      const line = this._buffer.replace(/\r$/, "");
      this._buffer = "";
      this.emit("line", line);
    }
    this.input?.off?.("data", this._onData);
    this.input?.off?.("end", this._onClose);
    this.input?.off?.("close", this._onClose);
    this.emit("close");
  }

  pause() {
    this.input?.pause?.();
    return this;
  }

  resume() {
    this.input?.resume?.();
    return this;
  }

  write(data) {
    this.output?.write?.(data);
  }

  question(query, callback) {
    if (query) this.output?.write?.(query);
    const onLine = (line) => {
      this.off("line", onLine);
      callback(line);
    };
    this.on("line", onLine);
  }
}

export function createInterface(options = {}) {
  return new Interface(options);
}

export function clearLine(stream, dir = 0, callback = undefined) {
  const code = Number(dir) < 0 ? "\x1b[1K" : Number(dir) > 0 ? "\x1b[0K" : "\x1b[2K";
  return writeControl(stream, code, callback);
}

export function clearScreenDown(stream, callback = undefined) {
  return writeControl(stream, "\x1b[0J", callback);
}

export function cursorTo(stream, x, y = undefined, callback = undefined) {
  if (typeof y === "function") {
    callback = y;
    y = undefined;
  }
  const code = y == null ? `\x1b[${Number(x) + 1}G` : `\x1b[${Number(y) + 1};${Number(x) + 1}H`;
  return writeControl(stream, code, callback);
}

export function moveCursor(stream, dx, dy, callback = undefined) {
  let code = "";
  const x = Number(dx) || 0;
  const y = Number(dy) || 0;
  if (x < 0) code += `\x1b[${-x}D`;
  else if (x > 0) code += `\x1b[${x}C`;
  if (y < 0) code += `\x1b[${-y}A`;
  else if (y > 0) code += `\x1b[${y}B`;
  return writeControl(stream, code, callback);
}

export function emitKeypressEvents(stream, _interface = undefined) {
  if (!stream || stream.__cottontailKeypressEvents) return;
  Object.defineProperty(stream, "__cottontailKeypressEvents", { value: true, configurable: true });
  stream.on?.("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    for (let index = 0; index < text.length; index += 1) {
      let sequence = text[index];
      if (sequence === "\x1b" && index + 2 < text.length && text[index + 1] === "[") {
        sequence = text.slice(index, index + 3);
        index += 2;
      }
      stream.emit?.("keypress", sequence, keyFromSequence(sequence));
    }
  });
}

class PromisesInterface extends Interface {
  question(query, options = {}) {
    return new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error("AbortError"));
        return;
      }
      const onAbort = () => {
        this.off("line", onLine);
        reject(options.signal.reason ?? new Error("AbortError"));
      };
      const onLine = (line) => {
        this.off("line", onLine);
        options?.signal?.removeEventListener?.("abort", onAbort);
        resolve(line);
      };
      if (query) this.output?.write?.(query);
      options?.signal?.addEventListener?.("abort", onAbort, { once: true });
      this.on("line", onLine);
    });
  }
}

class Readline extends PromisesInterface {}

function createPromisesInterface(options = {}) {
  return new PromisesInterface(options);
}

export const promises = {
  Interface: PromisesInterface,
  Readline,
  createInterface: createPromisesInterface,
};

export default {
  Interface,
  clearLine,
  clearScreenDown,
  createInterface,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
  promises,
};
