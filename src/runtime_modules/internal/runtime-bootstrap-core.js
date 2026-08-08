import { bunCompatVersion, processObject as earlyProcessObject } from "./runtime-process-bootstrap.js";
import { createWritableStdio } from "../node/stdio.js";
import { installDotenvLoader } from "./dotenv.js";
import { renderTable } from "./console-table.js";

const bunSleepSetTimeout = globalThis.setTimeout.bind(globalThis);

// Stash the pristine Promise.prototype.then before any module (async_hooks,
// the test runner, or user code) can replace it. Internal machinery must
// never flow through a user-overridden `then`.
globalThis[Symbol.for("cottontail.nativePromiseThen")] ??= Promise.prototype.then;

function remapStackString(value) {
  const remap = globalThis.__cottontailRemapStackString;
  return typeof remap === "function" ? remap(value) : String(value);
}

// Set once the console formatter below is built; see its assignment.
let bootstrapInspect;

// A thrown value's own accessors are user code and may throw. Reading them
// while formatting must never turn the report into "Unknown JavaScript
// exception"; Bun keeps printing and marks the property as a getter.
function safeRead(value, key) {
  try {
    return value == null ? undefined : value[key];
  } catch {
    return undefined;
  }
}

// Read an own property via its descriptor rather than a live get, so a
// booby-trapped accessor (e.g. err-fd-fixture's throwing `fd` getter) can't
// abort the report the way `safeRead` invoking the getter would.
function ownDescriptorValue(object, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

// Coded system errors (ENOENT, EEXIST, ...) print with no "Error:" prefix and
// a right-aligned path/syscall/errno/code block, matching Bun's SystemError
// printer. Returns null for anything that isn't a coded system error so the
// generic formatter below takes over.
function formatUncaughtSystemError(error) {
  if (!error || typeof error !== "object") return null;
  const code = ownDescriptorValue(error, "code");
  const syscall = ownDescriptorValue(error, "syscall");
  const errno = ownDescriptorValue(error, "errno");
  const message = ownDescriptorValue(error, "message");
  if (typeof code !== "string" || typeof syscall !== "string" ||
      typeof errno !== "number" || typeof message !== "string") {
    return null;
  }
  const path = ownDescriptorValue(error, "path");
  const fields = [
    ...(path === undefined ? [] : [["path", JSON.stringify(path)]]),
    ["syscall", JSON.stringify(syscall)],
    ["errno", String(errno)],
    ["code", JSON.stringify(code)],
  ];
  return `${message}\n${fields.map(([key, field], index) =>
    `${key.padStart(8)}: ${field}${index + 1 === fields.length ? "" : ","}`).join("\n")}`;
}

function normalizeUncaughtReferenceError(error) {
  if (safeRead(error, "name") !== "ReferenceError" ||
      typeof error.message !== "string" ||
      !error.message.startsWith("Can't find variable: ")) {
    return undefined;
  }
  const normalizedMessage = `${error.message.slice("Can't find variable: ".length)} is not defined`;
  const headers = [`ReferenceError: ${error.message}`, `ReferenceError: ${normalizedMessage}`];
  try { error.message = normalizedMessage; } catch {}
  if (typeof error.stack === "string") {
    try { error.stack = error.stack.replace(headers[0], headers[1]); } catch {}
  }
  return headers;
}

globalThis.__cottontailNormalizeUncaughtException ??= error => {
  normalizeUncaughtReferenceError(error);
  return error;
};

globalThis.__cottontailFormatUncaughtException ??= (error) => {
  const stackValue = safeRead(error, "stack");
  if (safeRead(error, "__cottontailFormattedStack") === true && typeof stackValue === "string") {
    return stackValue;
  }
  const messageValue = safeRead(error, "message");
  if (safeRead(error, "name") === "ResolveMessage" && typeof messageValue === "string") {
    return `error: ${messageValue}`;
  }
  const systemError = formatUncaughtSystemError(error);
  if (systemError !== null) return systemError;
  const referenceErrorHeaders = normalizeUncaughtReferenceError(error);
  if (error && typeof stackValue === "string") {
    let stack = remapStackString(stackValue);
    if (referenceErrorHeaders) stack = stack.replace(referenceErrorHeaders[0], referenceErrorHeaders[1]);
    let header = "";
    try {
      header = Error.prototype.toString.call(error);
    } catch {}
    if (safeRead(error, "name") === "AssertionError" && safeRead(error, "code") === "ERR_ASSERTION") {
      header = `AssertionError [ERR_ASSERTION]: ${messageValue}`;
    }
    if (referenceErrorHeaders) header = referenceErrorHeaders[1];
    return header && !stack.includes(header) ? `${header}\n${stack}` : stack;
  }
  if (referenceErrorHeaders) return referenceErrorHeaders[1];
  if (typeof messageValue === "string" && error && typeof error === "object") {
    // A thrown plain object: Bun reports the message, dumps the object, and
    // points at whatever location the object claims.
    const lines = [`error: ${messageValue}`];
    try {
      const inspect = globalThis.Bun?.inspect ?? bootstrapInspect;
      const dump = inspect?.(error);
      if (typeof dump === "string" && dump.length > 0) lines.push(dump);
    } catch {}
    const source = safeRead(error, "sourceURL") ?? safeRead(error, "fileName");
    const line = safeRead(error, "line") ?? safeRead(error, "lineNumber");
    const column = safeRead(error, "column") ?? safeRead(error, "columnNumber");
    if (source != null || line != null) {
      lines.push(
        `      at ${source == null ? "<script>" : String(source)}` +
          `${line == null ? "" : `:${String(line)}`}${column == null ? "" : `:${String(column)}`}`,
      );
    }
    return lines.join("\n");
  }
  if (messageValue != null) return `${safeRead(error, "name") ?? "Error"}: ${messageValue}`;
  try {
    return String(error);
  } catch {
    return "Unknown JavaScript exception";
  }
};

function installEmitter(target) {
  if (typeof target.on === "function" && typeof target.emit === "function") return;
  const listeners = target.__cottontailListeners ?? new Map();
  Object.defineProperty(target, "__cottontailListeners", {
    value: listeners,
    configurable: true,
  });
  target.on = function on(name, callback) {
    if (typeof callback !== "function") throw new TypeError("The listener must be a function");
    const callbacks = listeners.get(name) ?? [];
    callbacks.push(callback);
    listeners.set(name, callbacks);
    return this;
  };
  target.addListener = target.on;
  target.once = function once(name, callback) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      return callback.apply(this, args);
    };
    wrapped.listener = callback;
    return this.on(name, wrapped);
  };
  target.off = function off(name, callback) {
    const callbacks = listeners.get(name);
    if (!callbacks) return this;
    const filtered = callbacks.filter(item => item !== callback && item.listener !== callback);
    if (filtered.length === 0) listeners.delete(name);
    else listeners.set(name, filtered);
    return this;
  };
  target.removeListener = target.off;
  target.removeAllListeners = function removeAllListeners(name) {
    if (arguments.length === 0) listeners.clear();
    else listeners.delete(name);
    return this;
  };
  target.listeners = function listenersFor(name) {
    return (listeners.get(name) ?? []).map(callback => callback.listener ?? callback);
  };
  target.rawListeners = function rawListeners(name) {
    return [...(listeners.get(name) ?? [])];
  };
  target.listenerCount = function listenerCount(name) {
    return listeners.get(name)?.length ?? 0;
  };
  target.emit = function emit(name, ...args) {
    const callbacks = [...(listeners.get(name) ?? [])];
    if (callbacks.length === 0) return false;
    for (const callback of callbacks) callback.apply(this, args);
    return true;
  };
}

function installProcess() {
  const target = earlyProcessObject;
  target.stdout ??= createWritableStdio(1);
  target.stderr ??= createWritableStdio(2);
  installEmitter(target);
  return target;
}

const processObject = installProcess();
installDotenvLoader(processObject);
try {
  __ctMetaEnv = processObject.env;
} catch {}
// ── Console formatter (selective-bootstrap path) ──────────────────────────
// The full runtime (ffi.js) ships a richer formatter, but scripts that stay on
// the selective bootstrap never load ffi.js.  Without a replacement console,
// JSC's native console.log renders objects as "[object Object]".  We replace
// the entire console object here so that even the lightest bootstrap path
// produces Bun-compatible inspect output.
//
// IMPORTANT: property values are read via Object.getOwnPropertyDescriptor so
// that Proxy get-traps are never fired (matches Bun / ffi.js behavior).
if (globalThis.console) {
  const nativeLog = console.log?.bind(console);
  const nativeError = console.error?.bind(console);
  const nativeWarn = console.warn?.bind(console) ?? nativeError;
  let groupIndent = "";
  // console.log inspection depth: --console-depth CLI flag (surfaced by the
  // launcher as COTTONTAIL_CONSOLE_DEPTH) takes precedence over the
  // [console] depth key in bunfig.toml; both fall back to Bun's default of 2.
  // A configured depth of 0 means "unlimited" (Bun semantics).
  const bunfigConsoleDepth = () => {
    try {
      const source = String(cottontail.readFile("bunfig.toml"));
      let inConsoleSection = false;
      for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.replace(/\s+#.*$/, "").trim();
        const section = line.match(/^\[([^\]]+)\]$/);
        if (section) {
          inConsoleSection = section[1].trim() === "console";
          continue;
        }
        if (!inConsoleSection) continue;
        const depth = line.match(/^depth\s*=\s*(\d+)\s*$/);
        if (depth) return Number(depth[1]);
      }
    } catch {}
    return undefined;
  };
  const consoleDepth = (() => {
    const cliValue = globalThis.process?.env?.COTTONTAIL_CONSOLE_DEPTH;
    const configured = cliValue !== undefined && /^\d+$/.test(cliValue)
      ? Number(cliValue)
      : bunfigConsoleDepth();
    return configured === 0 ? Number.MAX_SAFE_INTEGER : (configured ?? 2);
  })();
  const identifierKeyRe = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

  const emitText = (stream, text) => {
    if (stream && typeof stream.write === "function") {
      stream.write(`${text}\n`);
      return;
    }
    nativeLog?.(text);
  };

  const indentText = (text, indentLines) => {
    const rendered = String(text);
    return groupIndent + (indentLines ? rendered.replace(/\n/g, `\n${groupIndent}`) : rendered);
  };

  const formatKey = (key) => {
    if (typeof key === "symbol") return `[${String(key)}]`;
    return identifierKeyRe.test(key) ? key : JSON.stringify(key);
  };

  const formatFunction = (value) => {
    let kind = "Function";
    try {
      const text = Function.prototype.toString.call(value);
      if (/^class[\s{]/.test(text)) return value.name ? `[class ${value.name}]` : "[class (anonymous)]";
      if (value.constructor?.name === "AsyncFunction") kind = "AsyncFunction";
      else if (value.constructor?.name === "GeneratorFunction") kind = "GeneratorFunction";
      else if (value.constructor?.name === "AsyncGeneratorFunction") kind = "AsyncGeneratorFunction";
    } catch {}
    return value.name ? `[${kind}: ${value.name}]` : `[${kind}]`;
  };

  const protoValue = (value, key) => {
    let cur = value;
    for (let d = 0; cur != null && d < 8; d += 1) {
      const desc = Object.getOwnPropertyDescriptor(cur, key);
      if (desc) return "value" in desc ? desc.value : undefined;
      cur = Object.getPrototypeOf(cur);
    }
    return undefined;
  };

  const isBufferValue = (value) =>
    // ArrayBuffer.isView is an internal-slot check that never reads a property,
    // so it can't trip a Proxy trap (Buffer.isBuffer reads `._isBuffer` in the
    // bootstrap polyfill). Gate the property-reading check behind it.
    ArrayBuffer.isView(value) &&
    typeof Buffer === "function" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(value);

  const isArrayBufferValue = (value) => {
    try {
      if (value instanceof ArrayBuffer) return true;
    } catch {}
    try {
      if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) return true;
    } catch {}
    return false;
  };

  // Element views never wrap: Bun prints every element of a typed array,
  // DataView or ArrayBuffer on the opening line.
  const typedArrayBody = (elements) => {
    let out = "";
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      out += `${i > 0 ? ", " : ""}${typeof element === "bigint" ? `${element}n` : String(element)}`;
    }
    return out;
  };

  const isPrimitiveLike = (value) =>
    value === null || (typeof value !== "object" && typeof value !== "function");

  // Bun keeps a short array whose first element is primitive on one line and
  // otherwise fills lines up to an 80 column budget, rather than emitting one
  // element per line.
  const formatArrayLike = (value, seen, depth, indent, opts) => {
    const length = value.length;
    const inner = indent + 2;
    const pad = " ".repeat(inner);
    const parts = [];
    let truncated = null;
    let count = 0;
    let emptyStart = null;
    for (let i = 0; i < length; i++) {
      if (!(i in value)) {
        if (emptyStart === null) emptyStart = i;
        continue;
      }
      if (emptyStart !== null) {
        const emptyCount = i - emptyStart;
        parts.push(emptyCount === 1 ? "empty item" : `${emptyCount} x empty items`);
        emptyStart = null;
      }
      if (count >= 100) {
        truncated = length - i;
        break;
      }
      count += 1;
      parts.push(formatValue(value[i], seen, depth + 1, inner, opts));
    }
    if (truncated === null && emptyStart !== null) {
      const emptyCount = length - emptyStart;
      parts.push(emptyCount === 1 ? "empty item" : `${emptyCount} x empty items`);
    }

    const multiline = truncated !== null ||
      length > 10 ||
      !isPrimitiveLike(0 in value ? value[0] : undefined) ||
      parts.some((part) => part.includes("\n"));
    if (!multiline) return `[ ${parts.join(", ")} ]`;

    let out = `[\n${pad}`;
    let column = inner;
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        out += ",";
        column += 1;
        if (column > 80) {
          out += `\n${pad}`;
          column = inner;
        } else {
          out += " ";
          column += 1;
        }
      }
      out += parts[i];
      column += parts[i].length;
    }
    if (truncated !== null) out += `,\n${pad}... ${truncated} more items`;
    return `${out}\n${" ".repeat(indent)}]`;
  };

  const formatValue = (value, seen, depth, indent, opts) => {
    switch (typeof value) {
      case "string": return JSON.stringify(value);
      case "number": return Object.is(value, -0) ? "-0" : String(value);
      case "bigint": return `${value}n`;
      case "boolean":
      case "undefined": return String(value);
      case "symbol": return value.toString();
      case "function": return formatFunction(value);
    }
    if (value === null) return "null";
    if (seen.has(value)) return "[Circular]";

    // Custom inspect
    if (opts.customInspect) {
      const custom = protoValue(value, inspectCustom);
      if (typeof custom === "function") {
        const remaining = opts.depth === Number.MAX_SAFE_INTEGER
          ? opts.depth
          : Math.max(opts.depth - depth, 0);
        const result = custom.call(value, remaining, {
          colors: false,
          depth: opts.depth,
          stylize: (t) => String(t),
        });
        if (result !== value) {
          return typeof result === "string"
            ? result
            : formatValue(result, seen, depth, indent, opts);
        }
      }
    }

    // Boxed primitives
    if (value instanceof String) return `[String: ${JSON.stringify(String.prototype.valueOf.call(value))}]`;
    if (value instanceof Number) return `[Number: ${formatValue(Number.prototype.valueOf.call(value), seen, depth, indent, opts)}]`;
    if (value instanceof Boolean) return `[Boolean: ${Boolean.prototype.valueOf.call(value)}]`;

    if (value instanceof Error) {
      let name = "Error", message = "", stack = "";
      try { if (value.name != null) name = String(value.name); } catch {}
      try { if (value.message != null) message = String(value.message); } catch {}
      try { const s = value.stack; if (typeof s === "string" && s.length > 0) stack = s; } catch {}
      const header = message ? `${name}: ${message}` : name;
      // Extra own enumerable properties (excluding name/message/stack)
      let extra = "";
      try {
        const keys = Reflect.ownKeys(value).filter(k => {
          if (k === "name" || k === "message" || k === "stack") return false;
          return Object.getOwnPropertyDescriptor(value, k)?.enumerable === true;
        });
        if (keys.length > 0) {
          const pad = " ".repeat(indent + 2);
          for (const key of keys) {
            const desc = Object.getOwnPropertyDescriptor(value, key);
            const rendered = formatValue(desc?.value, seen, depth + 1, indent + 2, opts);
            extra += `\n${pad}${formatKey(key)}: ${rendered},`;
          }
        }
      } catch {}
      if (!stack) return `${header}${extra}`;
      return `${stack.startsWith(name) ? stack : `${header}\n${stack.replace(/^/gm, "      ")}`}${extra}`;
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (typeof Promise !== "undefined" && value instanceof Promise) return "Promise { <pending> }";

    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        return formatArrayLike(value, seen, depth, indent, opts);
      }
      if (isBufferValue(value)) {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        let hex = "";
        for (let i = 0; i < bytes.length && i < 50; i++) hex += `${i > 0 ? " " : ""}${bytes[i].toString(16).padStart(2, "0")}`;
        const rest = bytes.length > 50 ? ` ... ${bytes.length - 50} more bytes` : "";
        return bytes.length === 0 ? "<Buffer >" : `<Buffer ${hex}${rest}>`;
      }
      if (ArrayBuffer.isView(value)) {
        const isView = value instanceof DataView;
        const name = isView
          ? "DataView"
          : Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "constructor")?.value?.name ?? "TypedArray";
        const elements = isView ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value;
        if (elements.length === 0) return `${name}(0) []`;
        return `${name}(${elements.length}) [ ${typedArrayBody(elements)} ]`;
      }
      if (isArrayBufferValue(value)) {
        const shared = typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer;
        const name = shared ? "SharedArrayBuffer" : "ArrayBuffer";
        const bytes = new Uint8Array(value);
        if (bytes.length === 0) return `${name}(0) []`;
        return `${name}(${bytes.length}) [ ${typedArrayBody(bytes)} ]`;
      }
      if (value instanceof Map) {
        if (value.size === 0) return "Map {}";
        const pad = " ".repeat(indent + 2);
        let out = `Map(${value.size}) {\n`;
        for (const [k, v] of value) {
          out += `${pad}${formatValue(k, seen, depth + 1, indent + 2, opts)}: ${formatValue(v, seen, depth + 1, indent + 2, opts)},\n`;
        }
        return `${out}${" ".repeat(indent)}}`;
      }
      if (value instanceof Set) {
        if (value.size === 0) return "Set {}";
        const pad = " ".repeat(indent + 2);
        let out = `Set(${value.size}) {\n`;
        for (const item of value) {
          out += `${pad}${formatValue(item, seen, depth + 1, indent + 2, opts)},\n`;
        }
        return `${out}${" ".repeat(indent)}}`;
      }
      if (depth > opts.depth) return "[Object ...]";

      // Prefix: constructor name or Symbol.toStringTag
      let prefix = "";
      const proto = Object.getPrototypeOf(value);
      const tag = protoValue(value, Symbol.toStringTag);
      if (typeof tag === "string") {
        if (tag !== "Object") prefix = `${tag} `;
      } else if (proto === null) {
        prefix = "[Object: null prototype] ";
      } else {
        const ctor = Object.getOwnPropertyDescriptor(proto, "constructor")?.value;
        if (ctor?.name && ctor.name !== "Object") prefix = `${ctor.name} `;
      }

      // Collect own enumerable keys via descriptors (avoids Proxy get traps)
      const keys = Reflect.ownKeys(value).filter((key) => {
        const desc = Object.getOwnPropertyDescriptor(value, key);
        return desc?.enumerable === true;
      });
      // Include prototype methods (non-constructor functions)
      if (proto && proto !== Object.prototype && proto !== null) {
        for (const key of Reflect.ownKeys(proto)) {
          if (key === "constructor" || keys.includes(key)) continue;
          const desc = Object.getOwnPropertyDescriptor(proto, key);
          if (typeof desc?.value === "function") keys.push(key);
        }
      }

      if (keys.length === 0) return `${prefix}{}`;
      const pad = " ".repeat(indent + 2);
      let out = `${prefix}{\n`;
      for (const key of keys) {
        const desc = Object.getOwnPropertyDescriptor(value, key) ?? Object.getOwnPropertyDescriptor(proto, key);
        let rendered;
        if (desc && !("value" in desc)) {
          rendered = desc.get && desc.set ? "[Getter/Setter]" : desc.get ? "[Getter]" : "[Setter]";
        } else {
          rendered = formatValue(desc?.value, seen, depth + 1, indent + 2, opts);
        }
        out += `${pad}${formatKey(key)}: ${rendered},\n`;
      }
      return `${out}${" ".repeat(indent)}}`;
    } finally {
      seen.delete(value);
    }
  };

  const formatArg = (value, opts) => {
    if (typeof value === "string") return value;
    try {
      return formatValue(value, new Set(), 0, 0, opts ?? { depth: consoleDepth, customInspect: true });
    } catch (e) {
      if (/revoked/i.test(String(e?.message))) return "<Revoked Proxy>";
      try { return String(value); } catch { return "<Revoked Proxy>"; }
    }
  };

  // The uncaught-exception formatter runs before this block and on the
  // selective bootstrap has no Bun.inspect to reach for; share this one.
  bootstrapInspect = value => formatArg(value, { depth: consoleDepth, customInspect: true });

  const formatPlaceholders = (fmt, values) => {
    let vi = 0;
    const text = fmt.replace(/%([sdifjoO%])/g, (match, spec) => {
      if (spec === "%") return "%";
      if (vi >= values.length) return match;
      const v = values[vi++];
      switch (spec) {
        case "s": return String(v);
        case "d": case "i": return parseInt(v, 10).toString();
        case "f": return Number(v).toString();
        case "j": try { return JSON.stringify(v); } catch { return "[Circular]"; }
        case "o": case "O": return formatArg(v);
        default: return match;
      }
    });
    return { text, remaining: values.slice(vi) };
  };

  const formatArgs = (args, substitutions, opts) => {
    if (args.length === 0) return "";
    let text, remaining;
    if (substitutions && typeof args[0] === "string" && args.length > 1) {
      const result = formatPlaceholders(args[0], args.slice(1));
      text = result.text;
      remaining = result.remaining;
    } else {
      text = formatArg(args[0], opts);
      remaining = args.slice(1);
    }
    for (const v of remaining) text += ` ${formatArg(v, opts)}`;
    return text;
  };

  // console.error/console.warn of an Error report the throw site from the
  // entry source rather than the generated bundle's frames, matching the
  // full-runtime console.
  const consoleErrorSource = (error) => {
    const filename = String(globalThis.__filename ?? processObject?.argv?.[1] ?? "");
    if (!filename || !error?.message) return undefined;
    let lines;
    try {
      lines = String(cottontail.readFile(filename)).split(/\r?\n/);
    } catch {
      return undefined;
    }
    const quotedMessage = JSON.stringify(String(error.message));
    const lineIndex = lines.findIndex((line) => line.includes(quotedMessage));
    if (lineIndex < 0) return undefined;
    const line = lines[lineIndex];
    const plainError = String(error.name ?? "Error") === "Error";
    const columnIndex = plainError
      ? Math.max(0, line.lastIndexOf("Error("))
      : Math.max(0, line.indexOf("new "));
    return { filename, lines, lineIndex, column: columnIndex + 1, plainError };
  };

  const formatConsoleError = (error, level) => {
    const source = consoleErrorSource(error);
    if (!source) return undefined;
    const name = String(error.name ?? "Error");
    const message = String(error.message ?? "");
    const lineNumber = source.lineIndex + 1;
    const stack = `      at ${source.filename}:${lineNumber}:${source.column}\n      at loadAndEvaluateModule (2:1)`;
    if (level === "warn") {
      const heading = source.plainError ? `warn: ${message}` : `${name}: ${message}`;
      return `${groupIndent}${heading}\n${stack}\n\n`;
    }
    const firstLine = Math.max(0, source.lineIndex - 5);
    const excerpt = [];
    for (let index = firstLine; index <= source.lineIndex; index += 1) {
      excerpt.push(`${index === firstLine ? groupIndent : ""}${index + 1} | ${source.lines[index]}`);
    }
    excerpt.push(" ".repeat(String(lineNumber).length + 3 + source.column - 1) + "^");
    excerpt.push(`${source.plainError ? "error" : name}: ${message}`);
    excerpt.push(stack, "", "");
    return excerpt.join("\n");
  };

  const writeConsole = (stream, args, substitutions, opts, separateError, level) => {
    // Single Error argument → formatted stack
    if (args.length === 1 && separateError) {
      try {
        if (args[0] instanceof Error) {
          const formatted = formatConsoleError(args[0], level);
          if (formatted !== undefined) {
            stream?.write?.(formatted);
            return;
          }
          let name = "Error", message = "", stack = "";
          try { if (args[0].name != null) name = String(args[0].name); } catch {}
          try { if (args[0].message != null) message = String(args[0].message); } catch {}
          try { const s = args[0].stack; if (typeof s === "string" && s.length > 0) stack = s; } catch {}
          const header = message ? `${name}: ${message}` : name;
          const rendered = !stack ? header : stack.startsWith(name) ? stack : `${header}\n${stack.replace(/^/gm, "      ")}`;
          emitText(stream, rendered);
          return;
        }
      } catch {}
    }
    const rendered = formatArgs(args, substitutions, opts);
    const indentLines = typeof args[0] !== "string";
    emitText(stream, indentText(rendered, indentLines));
  };

  const stdoutStream = processObject.stdout;
  const stderrStream = processObject.stderr;

  console.log = (...args) => writeConsole(stdoutStream, args, true, undefined, false);
  console.info = console.log;
  console.debug = console.log;
  console.error = (...args) => writeConsole(stderrStream, args, true, undefined, true, "error");
  console.warn = (...args) => writeConsole(stderrStream, args, true, undefined, true, "warn");

  console.write = (chunk = "") => {
    stdoutStream?.write?.(String(chunk));
  };

  // Group / count / time / dir / assert
  {
    const counts = new Map();
    const times = new Map();
    const consoleNow = typeof cottontail?.nanotime === "function"
      ? () => Number(cottontail.nanotime()) / 1e6
      : () => Date.now();

    console.group = (...args) => {
      if (args.length > 0) console.log(...args);
      groupIndent += "  ";
    };
    console.groupEnd = () => {
      groupIndent = groupIndent.slice(0, Math.max(0, groupIndent.length - 2));
    };
    console.groupCollapsed = console.group;

    console.count = (label = "default") => {
      const key = String(label);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      console.log(`${key}: ${next}`);
    };
    console.countReset = (label = "default") => { counts.delete(String(label)); };

    console.time = (label = "default") => {
      const key = String(label);
      if (!times.has(key)) times.set(key, consoleNow());
    };
    const logTime = (label, data, remove) => {
      const key = String(label);
      const started = times.get(key);
      if (started == null) return;
      const elapsed = Math.max(0, consoleNow() - started).toFixed(2);
      const suffix = data.length > 0 ? ` ${formatArgs(data, false)}` : "";
      emitText(stderrStream, indentText(`[${elapsed}ms] ${key}${suffix}`, false));
      if (remove) times.delete(key);
    };
    console.timeLog = (label = "default", ...data) => logTime(label, data, false);
    console.timeEnd = (label = "default") => logTime(label, [], true);

    console.dir = (value, dirOptions = undefined) => {
      let depth = consoleDepth;
      if (dirOptions && Object.prototype.hasOwnProperty.call(dirOptions, "depth")) {
        const requested = Number(dirOptions.depth);
        depth = requested === Infinity
          ? Number.MAX_SAFE_INTEGER
          : (Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0);
      }
      writeConsole(stdoutStream, [value], false, { depth, customInspect: false }, false);
    };

    console.assert = (condition, ...args) => {
      if (!condition) console.error("Assertion failed" + (args.length ? ":" : ""), ...args);
    };

    console.clear = () => {
      // Best-effort: write ANSI clear-screen escape
      stdoutStream?.write?.("\x1b[2J\x1b[H");
    };

    console.createTask = typeof cottontail?.createTask === "function"
      ? cottontail.createTask.bind(cottontail)
      : (target) => target;
  }

  // Mark the console so ffi.js can detect the bootstrap already installed the
  // compatible formatter and skip its own console setup (avoids double-formatting).
  Object.defineProperty(console, Symbol.for("cottontail.consoleBootstrapEnhanced"), {
    value: true,
    configurable: true,
  });
}

if (globalThis.console && typeof globalThis.console.table !== "function") {
  globalThis.console.table = (value, properties = undefined) => {
    if (properties !== undefined && !Array.isArray(properties)) {
      throw new TypeError("console.table properties must be an array");
    }
    if (value !== null && typeof value === "object") {
      const rendered = renderTable(value, properties, { colors: false });
      if (rendered) {
        processObject.stdout?.write?.(rendered);
        return;
      }
    }
    globalThis.console.log(value);
  };
}
const bunObject = globalThis.Bun ?? {};
Object.defineProperty(bunObject, Symbol.toStringTag, { value: "Bun", configurable: true });
bunObject.argv ??= processObject.argv;
bunObject.env ??= processObject.env;
bunObject.cwd ??= cottontail.cwd();
bunObject.main ??= processObject.argv[1] ?? "";
bunObject.isMainThread ??= cottontail.isWorker?.() !== true;
bunObject.version ??= bunCompatVersion;
bunObject.revision ??= "cottontail";
bunObject.version_with_sha ??= `v${bunCompatVersion} (cottontail)`;
bunObject.gc ??= function gc(force = false) {
  cottontail.gc?.(Boolean(force));
  cottontail.drainJobs?.();
};
bunObject.sleep ??= function sleep(value) {
  const delay = value instanceof Date ? value.getTime() - Date.now() : Number(value);
  // Bun saturates oversized timeouts to the maximum 32-bit timer value instead
  // of clamping them to ~1ms the way DOM/Node timers do.
  const saturated = Number.isNaN(delay)
    ? 0
    : !Number.isFinite(delay)
      ? 2 ** 31 - 1
      : Math.min(Math.max(0, delay), 2 ** 31 - 1);
  return new Promise(resolve => bunSleepSetTimeout(resolve, saturated));
};
bunObject.sleepSync ??= function sleepSync(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0) throw new TypeError("Bun.sleepSync expects a non-negative finite number");
  cottontail.sleep(delay);
};
bunObject.nanoseconds ??= () => Number(cottontail.nanotime?.() ?? Date.now() * 1_000_000);
globalThis.Bun = bunObject;

export function installRuntimeBootstrap({ pathToFileURL, fileURLToPath } = {}) {
  if (typeof pathToFileURL === "function") bunObject.pathToFileURL ??= pathToFileURL;
  if (typeof fileURLToPath === "function") bunObject.fileURLToPath ??= fileURLToPath;
  return bunObject;
}

export { bunObject as Bun, processObject as process };
export default bunObject;
