import { EventEmitter } from "./events.js";
import { readFileSync, writeFileSync } from "./fs.js";
import { createRequire } from "./module.js";
import { join } from "./path.js";
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

const builtinCommandNames = [".help", ".exit", ".clear", ".copy", ".load", ".save", ".editor", ".break", ".history"];

function isLikelyObjectLiteral(code) {
  const text = String(code).trim();
  return text.startsWith("{") && !text.endsWith(";");
}

function isIncompleteCode(code) {
  let braces = 0;
  let brackets = 0;
  let parentheses = 0;
  let quote = "";
  let template = false;
  let escaped = false;

  for (const character of String(code)) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (!quote && !template) {
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "`") {
        template = true;
        continue;
      }
    } else if (quote && character === quote) {
      quote = "";
      continue;
    } else if (template && character === "`") {
      template = false;
      continue;
    }
    if (quote || template) continue;
    if (character === "{") braces++;
    else if (character === "}") braces--;
    else if (character === "[") brackets++;
    else if (character === "]") brackets--;
    else if (character === "(") parentheses++;
    else if (character === ")") parentheses--;
  }

  return Boolean(quote || template || braces > 0 || brackets > 0 || parentheses > 0);
}

function formatReplError(error) {
  try {
    if (typeof error === "string") return error;
    const summary = String(error);
    const stack = typeof error?.stack === "string" ? error.stack : "";
    if (!stack) return summary || String(inspect(error));
    return stack.includes(summary) ? stack : `${summary}\n${stack}`;
  } catch {
    return "error: [failed to format error]";
  }
}

function formatReplValue(value, colors = false) {
  if (value === undefined) return "undefined";
  try {
    return Bun.inspect(value, { colors });
  } catch {
    try {
      return inspect(value, { colors });
    } catch (error) {
      throw error;
    }
  }
}

function normalizeReplError(error) {
  if (error?.name === "BuildMessage") return new SyntaxError(String(error?.message ?? error));
  if (error?.name !== "AggregateError" || !/parse error/i.test(String(error?.message ?? error))) return error;
  const detail = Array.isArray(error.errors) && error.errors.length ? String(error.errors[0]?.message ?? error.errors[0]) : String(error.message);
  const syntaxError = new SyntaxError(detail);
  syntaxError.cause = error;
  return syntaxError;
}

function installReplGlobals() {
  const cwd = process.cwd();
  const filename = join(cwd, "[repl]");
  const replRequire = createRequire(filename);
  const replModule = globalThis.module && typeof globalThis.module === "object"
    ? globalThis.module
    : { exports: {}, id: "[repl]", loaded: false, paths: [] };

  replModule.filename = filename;
  replModule.id = filename;
  globalThis.module = replModule;
  globalThis.exports = replModule.exports;
  globalThis.__filename = filename;
  globalThis.__dirname = cwd;
  globalThis.require = replRequire;
  globalThis.fs ??= replRequire("fs");
}

let importSequence = 0;

function importedBindingAssignments(clause, namespace) {
  const text = String(clause ?? "").trim();
  if (!text) return "";
  const statements = [];
  let remainder = text;

  if (!remainder.startsWith("{") && !remainder.startsWith("*")) {
    const comma = remainder.indexOf(",");
    const local = (comma < 0 ? remainder : remainder.slice(0, comma)).trim();
    if (local) statements.push(`globalThis[${JSON.stringify(local)}] = Object.prototype.hasOwnProperty.call(${namespace}, "default") ? ${namespace}.default : ${namespace};`);
    remainder = comma < 0 ? "" : remainder.slice(comma + 1).trim();
  }

  if (remainder.startsWith("*")) {
    const match = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(remainder);
    if (!match) throw new SyntaxError(`Invalid REPL import clause: ${text}`);
    statements.push(`globalThis[${JSON.stringify(match[1])}] = ${namespace};`);
  } else if (remainder.startsWith("{")) {
    const body = remainder.replace(/^\{/, "").replace(/\}$/, "");
    for (const entry of body.split(",")) {
      const part = entry.trim();
      if (!part) continue;
      const match = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part);
      if (!match) throw new SyntaxError(`Invalid REPL import binding: ${part}`);
      const imported = match[1];
      const local = match[2] ?? imported;
      statements.push(`globalThis[${JSON.stringify(local)}] = ${namespace}[${JSON.stringify(imported)}];`);
    }
  }

  return statements.join("\n");
}

function lowerStaticImports(source) {
  const pattern = /(^|[;\n])\s*import\s+(?:(.*?)\s+from\s+)?(["'])((?:\\.|(?!\3)[\s\S])*?)\3\s*;?/gm;
  let changed = false;
  const code = String(source).replace(pattern, (_whole, boundary, clause, _quote, rawSpecifier) => {
    changed = true;
    const namespace = `__cottontailReplImport${importSequence++}`;
    const specifier = JSON.parse(`"${rawSpecifier.replace(/"/g, '\\"')}"`);
    const assignment = importedBindingAssignments(clause, namespace);
    return `${boundary === ";" ? ";" : boundary}const ${namespace} = globalThis.require(${JSON.stringify(specifier)});${assignment ? `\n${assignment}` : ""}`;
  });
  return { code, changed };
}

class BuiltinReplEvaluator {
  constructor() {
    this.typescript = new Bun.Transpiler({ loader: "tsx", deadCodeElimination: false });
    this.repl = new Bun.Transpiler({ loader: "js", replMode: true });
  }

  transform(source) {
    const original = String(source);
    const imports = lowerStaticImports(original);
    const prepared = isLikelyObjectLiteral(imports.code) ? `(${imports.code})` : imports.code;
    let javascript = this.typescript.transformSync(prepared);

    if (!javascript.trim()) {
      const trimmed = original.trim();
      if (/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*;?$/.test(trimmed)) return trimmed;
      return "";
    }

    if (/\bawait\b/.test(javascript)) return this.repl.transformSync(javascript);

    // Global indirect eval preserves `var` and function declarations between
    // entries and permits Node-style redeclaration. Keep this post-TypeScript
    // rewrite at top level so block/function-local lexical semantics remain
    // unchanged. Named classes need an explicit global assignment because
    // global lexical class bindings do not survive separate eval calls.
    javascript = javascript.replace(/^(?:const|let)\s/gm, "var ");
    javascript = javascript.replace(
      /^class\s+([A-Za-z_$][\w$]*)\b/gm,
      (_match, name) => `globalThis[${JSON.stringify(name)}] = class ${name}`,
    );
    return javascript;
  }

  async evaluate(source) {
    let transformed;
    try {
      transformed = this.transform(source);
    } catch (error) {
      throw normalizeReplError(error);
    }
    if (!transformed.trim()) return undefined;
    let result = (0, eval)(transformed);
    result = await result;
    if (result !== null && (typeof result === "object" || typeof result === "function") &&
        Object.prototype.hasOwnProperty.call(result, "value")) {
      result = result.value;
    }
    if (result !== undefined) globalThis._ = result;
    return result;
  }
}

class BuiltinReplSession {
  constructor() {
    this.input = process.stdin;
    this.output = process.stdout;
    this.terminal = Boolean(this.input?.isTTY && this.output?.isTTY);
    this.colors = this.terminal && !process.env.NO_COLOR;
    this.evaluator = new BuiltinReplEvaluator();
    this.line = "";
    this.multiline = "";
    this.editor = false;
    this.editorBuffer = "";
    this.history = [];
    this.historyIndex = 0;
    this.temporaryLine = "";
    this.queue = [];
    this.processing = false;
    this.inputEnded = false;
    this.closed = false;
    this.skipLineFeed = false;
    this.pendingEscape = "";
  }

  write(value) {
    this.output.write(String(value));
  }

  prompt() {
    if (this.closed) return;
    this.write(this.editor || this.multiline ? "... " : "> ");
  }

  redraw() {
    if (!this.terminal || this.closed) return;
    this.write(`\r\x1b[2K${this.editor || this.multiline ? "... " : "> "}${this.line}`);
  }

  addHistory(code) {
    const value = String(code).replace(/\n$/, "");
    if (!value || this.history[this.history.length - 1] === value) return;
    this.history.push(value);
    if (this.history.length > 1000) this.history.shift();
    this.historyIndex = this.history.length;
    this.temporaryLine = "";
  }

  historyPrevious() {
    if (!this.history.length) return;
    if (this.historyIndex === this.history.length) this.temporaryLine = this.line;
    if (this.historyIndex > 0) this.historyIndex--;
    this.line = this.history[this.historyIndex] ?? this.line;
    this.redraw();
  }

  historyNext() {
    if (this.historyIndex < this.history.length) this.historyIndex++;
    this.line = this.historyIndex === this.history.length ? this.temporaryLine : (this.history[this.historyIndex] ?? "");
    this.redraw();
  }

  complete() {
    if (!this.line.startsWith(".")) return;
    const matches = builtinCommandNames.filter(name => name.startsWith(this.line));
    if (matches.length === 1) {
      this.line = `${matches[0]} `;
      this.redraw();
    }
  }

  submitLine() {
    const line = this.line;
    this.line = "";
    if (this.terminal) this.write("\n");
    this.queue.push({ type: "line", value: line });
    void this.processQueue();
  }

  ctrlC() {
    if (this.editor) {
      this.editor = false;
      this.editorBuffer = "";
    }
    this.multiline = "";
    this.line = "";
    this.write("^C\n");
    this.prompt();
  }

  ctrlD() {
    if (this.editor) {
      const pendingLine = this.line;
      this.line = "";
      this.write("\n");
      this.queue.push({ type: "editor-end", value: pendingLine });
      void this.processQueue();
      return;
    }
    if (!this.line && !this.multiline) {
      this.queue.push({ type: "exit" });
      void this.processQueue();
    }
  }

  consume(text) {
    let data = this.pendingEscape + String(text);
    this.pendingEscape = "";
    for (let index = 0; index < data.length; index++) {
      const character = data[index];
      if (character === "\x1b") {
        if (index + 2 >= data.length) {
          this.pendingEscape = data.slice(index);
          break;
        }
        const sequence = data.slice(index, index + 3);
        if (sequence === "\x1b[A") this.historyPrevious();
        else if (sequence === "\x1b[B") this.historyNext();
        index += 2;
        continue;
      }
      if (character === "\x03") {
        this.ctrlC();
        continue;
      }
      if (character === "\x04") {
        this.ctrlD();
        continue;
      }
      if (character === "\t") {
        this.complete();
        continue;
      }
      if (character === "\x7f" || character === "\b") {
        this.line = this.line.slice(0, -1);
        this.redraw();
        continue;
      }
      if (character === "\r") {
        this.skipLineFeed = true;
        this.submitLine();
        continue;
      }
      if (character === "\n") {
        if (this.skipLineFeed) {
          this.skipLineFeed = false;
          continue;
        }
        this.submitLine();
        continue;
      }
      this.skipLineFeed = false;
      if (character >= " ") {
        this.line += character;
        this.redraw();
      }
    }
  }

  async evaluateAndPrint(source, copy = false) {
    try {
      const result = await this.evaluator.evaluate(source);
      if (copy) {
        const text = result === undefined ? "undefined" : (typeof result === "string" ? result : formatReplValue(result, false));
        if (this.terminal) this.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
        this.write(`Copied ${text.length} characters to clipboard\n`);
      } else {
        this.write(`${formatReplValue(result, this.colors)}\n`);
      }
    } catch (error) {
      globalThis._error = error;
      this.write(`${formatReplError(error)}\n`);
    }
  }

  commandFor(prefix) {
    return builtinCommandNames.find(name => name === prefix || (prefix.length > 1 && name.startsWith(prefix)));
  }

  async runCommand(line) {
    const separator = line.indexOf(" ");
    const prefix = separator < 0 ? line : line.slice(0, separator);
    const argument = separator < 0 ? "" : line.slice(separator + 1).trim();
    const command = this.commandFor(prefix);
    if (!command) {
      this.write(`Unknown command: ${prefix}\nType .help for available commands\n`);
      return;
    }
    if (command === ".exit") {
      this.finish();
    } else if (command === ".help") {
      this.write("\nREPL Commands:\n");
      for (const name of builtinCommandNames) this.write(`  ${name}\n`);
      this.write("\nSpecial Variables:\n  _\n  _error\n\n");
    } else if (command === ".clear") {
      this.write("\x1b[2J\x1b[3J\x1b[H");
    } else if (command === ".break") {
      this.multiline = "";
      this.line = "";
    } else if (command === ".history") {
      this.write("\nCommand History:\n");
      const start = Math.max(0, this.history.length - 20);
      for (let index = start; index < this.history.length; index++) this.write(`  ${index + 1}  ${this.history[index]}\n`);
      this.write("\n");
    } else if (command === ".load") {
      if (!argument) this.write("Usage: .load <filename>\n");
      else {
        try {
          this.write(`Loading ${argument}...\n`);
          await this.evaluateAndPrint(readFileSync(argument, "utf8"));
        } catch (error) {
          this.write(`${formatReplError(error)}\n`);
        }
      }
    } else if (command === ".save") {
      if (!argument) this.write("Usage: .save <filename>\n");
      else {
        try {
          writeFileSync(argument, `${this.history.join("\n")}${this.history.length ? "\n" : ""}`);
          this.write(`Session saved to ${argument}\n`);
        } catch (error) {
          this.write(`${formatReplError(error)}\n`);
        }
      }
    } else if (command === ".copy") {
      if (argument) await this.evaluateAndPrint(argument, true);
      else {
        const result = globalThis._;
        const text = result === undefined ? "undefined" : (typeof result === "string" ? result : formatReplValue(result, false));
        if (this.terminal) this.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
        this.write(`Copied ${text.length} characters to clipboard\n`);
      }
    } else if (command === ".editor") {
      this.editor = true;
      this.editorBuffer = "";
      this.write("// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\n");
    }
  }

  async handleLine(line) {
    if (this.editor) {
      this.editorBuffer += `${line}\n`;
      return;
    }
    if (line.startsWith(".")) {
      await this.runCommand(line);
      return;
    }
    if (!line && !this.multiline) return;

    const code = this.multiline ? `${this.multiline}${line}\n` : line;
    if (isIncompleteCode(code)) {
      this.multiline = code.endsWith("\n") ? code : `${code}\n`;
      return;
    }
    this.multiline = "";
    this.addHistory(code);
    await this.evaluateAndPrint(code);
  }

  async processQueue() {
    if (this.processing || this.closed) return;
    this.processing = true;
    try {
      while (!this.closed && this.queue.length) {
        const item = this.queue.shift();
        if (item.type === "exit") this.finish();
        else if (item.type === "editor-end") {
          if (item.value) this.editorBuffer += item.value;
          const source = this.editorBuffer;
          this.editor = false;
          this.editorBuffer = "";
          this.addHistory(source);
          await this.evaluateAndPrint(source);
        }
        else if (item.type === "evaluate") {
          this.addHistory(item.value);
          await this.evaluateAndPrint(item.value);
        } else await this.handleLine(item.value);
      }
    } finally {
      this.processing = false;
    }
    if (!this.closed && this.inputEnded) this.finish();
    else if (!this.closed) this.prompt();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    if (this.terminal) {
      try { cottontail.terminalSetRawMode?.(0, false); } catch {}
      this.input.isRaw = false;
    }
    this.input.off?.("data", this.onData);
    this.input.off?.("end", this.onEnd);
    this.input.off?.("error", this.onError);
    this.input.pause?.();
    this.resolve?.();
  }

  async run() {
    installReplGlobals();
    if (this.terminal) {
      try { cottontail.terminalSetRawMode?.(0, true); } catch {}
      this.input.isRaw = true;
    }
    this.onData = chunk => this.consume(Buffer.from(chunk).toString());
    this.onEnd = () => {
      this.inputEnded = true;
      if (!this.processing && this.queue.length === 0) this.finish();
    };
    this.onError = error => {
      this.write(`${formatReplError(error)}\n`);
      this.finish();
    };
    const completed = new Promise(resolve => { this.resolve = resolve; });
    this.input.on("data", this.onData);
    this.input.on("end", this.onEnd);
    this.input.on("error", this.onError);
    this.input.resume?.();
    this.write(`Welcome to Bun v${Bun.version}\n`);
    this.write("Type .copy [code] to copy to clipboard. .help for more info.\n\n");
    this.prompt();
    await completed;
  }
}

export async function runBuiltinCLI() {
  const session = new BuiltinReplSession();
  await session.run();
}

export async function runBuiltinEval(source, printResult = false) {
  installReplGlobals();
  const evaluator = new BuiltinReplEvaluator();
  try {
    const result = await evaluator.evaluate(String(source));
    if (printResult) {
      process.once("beforeExit", () => process.stdout.write(`${formatReplValue(result, false)}\n`));
    }
  } catch (error) {
    globalThis._error = error;
    process.stderr.write(`${formatReplError(error)}\n`);
    process.exitCode = 1;
  }
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
