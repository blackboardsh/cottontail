import { format, inspect } from "./util.js";

function writeStream(stream, text) {
  if (stream && typeof stream.write === "function") {
    stream.write(text);
    return;
  }
  cottontail.fdWrite?.(stream === globalThis.process?.stderr ? 2 : 1, text);
}

export class Console {
  constructor(stdout = globalThis.process?.stdout, stderr = globalThis.process?.stderr, ignoreErrors = true) {
    this._stdout = stdout;
    this._stderr = stderr || stdout;
    this._ignoreErrors = ignoreErrors;
    this._times = new Map();
    this._counts = new Map();
    this._groupIndent = "";
  }

  _write(stream, args) {
    const text = `${this._groupIndent}${format(...args)}\n`;
    try {
      writeStream(stream, text);
    } catch (error) {
      if (!this._ignoreErrors) throw error;
    }
  }

  log(...args) { this._write(this._stdout, args); }
  info(...args) { this.log(...args); }
  debug(...args) { this.log(...args); }
  error(...args) { this._write(this._stderr, args); }
  warn(...args) { this.error(...args); }
  dir(value, options = undefined) { this.log(inspect(value, options)); }
  dirxml(...args) { this.log(...args); }
  table(value) { this.log(value); }
  clear() { writeStream(this._stdout, "\x1bc"); }
  profile() {}
  profileEnd() {}
  timeStamp() {}
  context() { return this; }
  createTask() { return { run: (callback, ...args) => callback(...args) }; }

  assert(value, ...args) {
    if (!value) this.error("Assertion failed:", ...args);
  }

  trace(...args) {
    const error = new Error(format(...args));
    this.error(error.stack || error.message);
  }

  time(label = "default") {
    this._times.set(String(label), Date.now());
  }

  timeLog(label = "default", ...args) {
    const key = String(label);
    const started = this._times.get(key);
    if (started == null) return;
    this.log(`${key}: ${Date.now() - started}ms`, ...args);
  }

  timeEnd(label = "default") {
    const key = String(label);
    this.timeLog(key);
    this._times.delete(key);
  }

  count(label = "default") {
    const key = String(label);
    const next = (this._counts.get(key) || 0) + 1;
    this._counts.set(key, next);
    this.log(`${key}: ${next}`);
  }

  countReset(label = "default") {
    this._counts.set(String(label), 0);
  }

  group(...args) {
    if (args.length > 0) this.log(...args);
    this._groupIndent += "  ";
  }

  groupCollapsed(...args) { this.group(...args); }

  groupEnd() {
    this._groupIndent = this._groupIndent.slice(0, -2);
  }
}

const defaultConsole = globalThis.console instanceof Console
  ? globalThis.console
  : new Console(globalThis.process?.stdout, globalThis.process?.stderr);

export const _stdout = defaultConsole._stdout;
export const _stderr = defaultConsole._stderr;
export const _ignoreErrors = defaultConsole._ignoreErrors;
export const _times = defaultConsole._times;
export const _stdoutErrorHandler = undefined;
export const _stderrErrorHandler = undefined;
export const log = defaultConsole.log.bind(defaultConsole);
export const info = defaultConsole.info.bind(defaultConsole);
export const debug = defaultConsole.debug.bind(defaultConsole);
export const error = defaultConsole.error.bind(defaultConsole);
export const warn = defaultConsole.warn.bind(defaultConsole);
export const dir = defaultConsole.dir.bind(defaultConsole);
export const dirxml = defaultConsole.dirxml.bind(defaultConsole);
export const table = defaultConsole.table.bind(defaultConsole);
export const clear = defaultConsole.clear.bind(defaultConsole);
export const assert = defaultConsole.assert.bind(defaultConsole);
export const trace = defaultConsole.trace.bind(defaultConsole);
export const time = defaultConsole.time.bind(defaultConsole);
export const timeLog = defaultConsole.timeLog.bind(defaultConsole);
export const timeEnd = defaultConsole.timeEnd.bind(defaultConsole);
export const count = defaultConsole.count.bind(defaultConsole);
export const countReset = defaultConsole.countReset.bind(defaultConsole);
export const group = defaultConsole.group.bind(defaultConsole);
export const groupCollapsed = defaultConsole.groupCollapsed.bind(defaultConsole);
export const groupEnd = defaultConsole.groupEnd.bind(defaultConsole);
export const profile = defaultConsole.profile.bind(defaultConsole);
export const profileEnd = defaultConsole.profileEnd.bind(defaultConsole);
export const timeStamp = defaultConsole.timeStamp.bind(defaultConsole);
export const context = defaultConsole.context.bind(defaultConsole);
export const createTask = defaultConsole.createTask.bind(defaultConsole);

export default {
  Console,
  _ignoreErrors,
  _stderr,
  _stderrErrorHandler,
  _stdout,
  _stdoutErrorHandler,
  _times,
  assert,
  clear,
  context,
  count,
  countReset,
  createTask,
  debug,
  dir,
  dirxml,
  error,
  group,
  groupCollapsed,
  groupEnd,
  info,
  log,
  profile,
  profileEnd,
  table,
  time,
  timeEnd,
  timeLog,
  timeStamp,
  trace,
  warn,
};
