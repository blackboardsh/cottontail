import { EventEmitter } from "./events.js";
import { inspect } from "./util.js";

export const REPL_MODE_SLOPPY = Symbol("repl-sloppy");
export const REPL_MODE_STRICT = Symbol("repl-strict");
export const builtinModules = [
  "assert",
  "buffer",
  "child_process",
  "console",
  "crypto",
  "events",
  "fs",
  "module",
  "net",
  "os",
  "path",
  "process",
  "stream",
  "timers",
  "url",
  "util",
];
export const _builtinLibs = builtinModules;

export class Recoverable extends SyntaxError {
  constructor(error) {
    super(error?.message ?? String(error ?? "Recoverable"));
    this.err = error;
  }
}

export function writer(value) {
  return inspect(value);
}

export function isValidSyntax(code) {
  try {
    new Function(String(code));
    return true;
  } catch (error) {
    return false;
  }
}

export class REPLServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.input = options.input ?? globalThis.process?.stdin;
    this.output = options.output ?? globalThis.process?.stdout;
    this.context = options.context ?? {};
    this.eval = options.eval ?? defaultEval;
    this.writer = options.writer ?? writer;
    this.prompt = options.prompt ?? "> ";
    this.closed = false;
    this._buffer = "";
    this.history = [];
    this.historySize = Math.max(0, Number(options.historySize ?? 1000) || 0);
    this.removeHistoryDuplicates = Boolean(options.removeHistoryDuplicates);
    this._historyPath = null;
    this._onData = (chunk) => this._handleData(chunk);
    this.input?.on?.("data", this._onData);
    if (options.terminal !== false) this.displayPrompt();
  }

  displayPrompt() {
    this.output?.write?.(this.prompt);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input?.off?.("data", this._onData);
    this.emit("exit");
  }

  defineCommand(keyword, command) {
    this.commands ??= Object.create(null);
    this.commands[String(keyword).replace(/^\./, "")] = command;
  }

  clearBufferedCommand() {
    this._buffer = "";
  }

  setupHistory(historyPath, callback = undefined) {
    this._historyPath = String(historyPath);
    try {
      if (cottontail.existsSync?.(this._historyPath)) {
        const text = String(cottontail.readFile?.(this._historyPath) ?? "");
        this.history = text.split(/\r?\n/).filter(Boolean).reverse().slice(0, this.historySize || undefined);
      }
      callback?.(null, this);
    } catch (error) {
      callback?.(error);
    }
  }

  _handleData(chunk) {
    this._buffer += String(chunk);
    for (;;) {
      const newline = this._buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this._buffer.slice(0, newline).replace(/\r$/, "");
      this._buffer = this._buffer.slice(newline + 1);
      this._evalLine(line);
    }
  }

  _evalLine(line) {
    if (line === ".exit") {
      this.close();
      return;
    }
    if (line.startsWith(".")) {
      this._runCommand(line);
      return;
    }
    this._addHistory(line);
    this.eval(line, this.context, "repl", (error, result) => {
      if (error) this.output?.write?.(`${error.stack ?? error}\n`);
      else if (result !== undefined) this.output?.write?.(`${this.writer(result)}\n`);
      this.displayPrompt();
    });
  }

  _runCommand(line) {
    const [keyword, ...rest] = line.slice(1).trim().split(/\s+/);
    if (keyword === "clear") {
      this.context = {};
      this.output?.write?.("Clearing context...\n");
      this.displayPrompt();
      return;
    }
    if (keyword === "help") {
      const names = ["break", "clear", "exit", "help", "save", "load", ...(this.commands ? Object.keys(this.commands) : [])];
      this.output?.write?.(`${[...new Set(names)].map((name) => `.${name}`).join("\n")}\n`);
      this.displayPrompt();
      return;
    }
    const command = this.commands?.[keyword];
    if (typeof command === "function") command.call(this, rest.join(" "));
    else if (typeof command?.action === "function") command.action.call(this, rest.join(" "));
    else this.output?.write?.(`Invalid REPL keyword\n`);
    if (!this.closed) this.displayPrompt();
  }

  _addHistory(line) {
    if (!line.trim() || this.historySize === 0) return;
    if (this.removeHistoryDuplicates) this.history = this.history.filter((entry) => entry !== line);
    if (this.history[0] !== line) this.history.unshift(line);
    if (this.history.length > this.historySize) this.history.length = this.historySize;
    this._persistHistory();
  }

  _persistHistory() {
    if (!this._historyPath) return;
    try {
      const text = `${[...this.history].reverse().join("\n")}${this.history.length ? "\n" : ""}`;
      cottontail.writeFile?.(this._historyPath, text);
    } catch {}
  }
}

function defaultEval(code, context, _filename, callback) {
  try {
    const result = Function("context", "code", "with (context) { return eval(code); }")(context, String(code));
    callback(null, result);
  } catch (error) {
    callback(error);
  }
}

export function start(options = {}) {
  return new REPLServer(typeof options === "string" ? { prompt: options } : options);
}

export default {
  REPLServer,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  Recoverable,
  _builtinLibs,
  builtinModules,
  isValidSyntax,
  start,
  writer,
};
