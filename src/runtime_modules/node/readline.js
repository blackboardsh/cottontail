import { EventEmitter } from "./events.js";

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

export default { Interface, createInterface };
