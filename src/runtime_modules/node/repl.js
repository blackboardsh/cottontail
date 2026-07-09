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
    this.commands[keyword] = command;
  }

  clearBufferedCommand() {
    this._buffer = "";
  }

  setupHistory(_historyPath, callback = undefined) {
    callback?.(null, this);
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
    this.eval(line, this.context, "repl", (error, result) => {
      if (error) this.output?.write?.(`${error.stack ?? error}\n`);
      else if (result !== undefined) this.output?.write?.(`${this.writer(result)}\n`);
      this.displayPrompt();
    });
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

// COTTONTAIL-COMPAT: node:repl editor/history - basic REPL evaluation is implemented; terminal editing and persistent history need readline TTY integration.

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
