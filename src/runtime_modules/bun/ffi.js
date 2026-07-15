import "./encoding.js";
import { createReadableStdio, createWritableStdio } from "../node/stdio.js";

const g = globalThis;
const processStartMs = Date.now();

// Install disposal symbols before ANY other module evaluates: several modules
// (events.js, the vendored readable-stream primordials, node/http.js) capture
// Symbol.dispose/asyncDispose at eval time and must all observe the same value.
if (Symbol.dispose == null) {
  Object.defineProperty(Symbol, "dispose", { value: Symbol.for("Symbol.dispose"), configurable: true });
}
if (Symbol.asyncDispose == null) {
  Object.defineProperty(Symbol, "asyncDispose", { value: Symbol.for("Symbol.asyncDispose"), configurable: true });
}

// Bare `import.meta` expressions (e.g. `const { file } = import.meta;`) are
// rewritten by the loader to `globalThis.__cottontailImportMeta`, which each
// generated module's prelude reassigns using the GENERATED file's name
// (script.bundle.mjs / script-entry-*.mjs / .cottontail-compat-*). The real
// entrypoint path is published as `globalThis.__filename` before the bundle
// is imported, so intercept the assignment and restore the original file's
// metadata.
if (!g.__cottontailImportMetaFixInstalled) {
  Object.defineProperty(g, "__cottontailImportMetaFixInstalled", { value: true, configurable: true });
  const generatedPattern = /(?:^|[\\/])(?:script\.bundle\.mjs|script-entry-[^\\/]*\.mjs|\.cottontail-compat-[0-9a-f]+(?:\.[A-Za-z0-9]+)?)$/;
  const fileUrlFor = (path) => {
    let url = "file://";
    for (const segment of String(path).split("/")) {
      if (segment === "") continue;
      url += "/" + encodeURIComponent(segment);
    }
    return url === "file://" ? "file:///" : url;
  };
  const fixImportMeta = (meta) => {
    if (!meta || typeof meta !== "object") return meta;
    const original = g.__filename;
    if (
      typeof original === "string" &&
      original.length > 0 &&
      typeof meta.filename === "string" &&
      generatedPattern.test(meta.filename) &&
      meta.filename !== original
    ) {
      const slash = original.lastIndexOf("/");
      const dir = slash > 0 ? original.slice(0, slash) : (slash === 0 ? "/" : ".");
      meta.dirname = dir;
      meta.dir = dir;
      meta.filename = original;
      meta.path = original;
      meta.file = slash >= 0 ? original.slice(slash + 1) : original;
      meta.url = fileUrlFor(original);
    }
    return meta;
  };
  let currentImportMeta = g.__cottontailImportMeta;
  Object.defineProperty(g, "__cottontailImportMeta", {
    configurable: true,
    get() {
      // Fix lazily: the generated prelude may assign before the entry
      // wrapper publishes globalThis.__filename. fixImportMeta is idempotent.
      return fixImportMeta(currentImportMeta);
    },
    set(value) {
      currentImportMeta = value;
    },
  });
}

function platform() {
  return cottontail.platform();
}

function signalNumber(signal = "SIGTERM") {
  if (typeof signal === "number") return signal;
  const name = String(signal).toUpperCase();
  if (name === "0") return 0;
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  if (signals[name] == null) throw new TypeError(`Unknown signal: ${signal}`);
  return signals[name];
}

function installProcessApi(processObject) {
  const listeners = processObject.__cottontailListeners ?? new Map();
  Object.defineProperty(processObject, "__cottontailListeners", {
    value: listeners,
    configurable: true,
  });

  processObject.pid ??= cottontail.pid?.() ?? 0;
  processObject.version ??= "v24.0.0";
  // Bun reports "bun" as the process title (upstream regression 23183).
  processObject.title ??= "bun";
  processObject.browser ??= false;
  processObject.uptime ??= () => (Date.now() - processStartMs) / 1000;

  processObject.nextTick = (callback, ...args) => {
    if (typeof callback !== "function") {
      throw new TypeError("process.nextTick callback must be a function");
    }
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => callback(...args));
    } else {
      setTimeout(() => callback(...args), 0);
    }
  };

  processObject.hrtime = (previous) => {
    const now = BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));
    let diff = now;
    if (Array.isArray(previous)) {
      diff -= BigInt(previous[0] || 0) * 1_000_000_000n + BigInt(previous[1] || 0);
    }
    return [Number(diff / 1_000_000_000n), Number(diff % 1_000_000_000n)];
  };
  processObject.hrtime.bigint = () => BigInt(Math.floor((performance?.now?.() ?? Date.now()) * 1_000_000));

  processObject.on = processObject.addListener = function on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    handlers.push(handler);
    listeners.set(key, handlers);
    return this;
  };

  processObject.once = function once(name, handler) {
    if (typeof handler !== "function") return this;
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  };

  processObject.off = processObject.removeListener = function off(name, handler) {
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    return this;
  };

  processObject.removeAllListeners = function removeAllListeners(name) {
    if (name == null) listeners.clear();
    else listeners.delete(String(name));
    return this;
  };

  processObject.listeners = function processListeners(name) {
    return [...(listeners.get(String(name)) ?? [])];
  };

  processObject.emit = function emit(name, ...args) {
    const handlers = [...(listeners.get(String(name)) ?? [])];
    for (const handler of handlers) {
      handler(...args);
    }
    return handlers.length > 0;
  };

  processObject.kill ??= (pid = processObject.pid, signal = "SIGTERM") => {
    const targetPid = Number(pid);
    const nativeSignal = signalNumber(signal);
    if (targetPid === processObject.pid && nativeSignal !== 0 && processObject.emit(String(signal))) {
      return true;
    }
    return cottontail.kill(targetPid, nativeSignal);
  };
}

const cottontailExecPath = cottontail.execPath?.() ?? "cottontail";
const processObject = g.process ?? {
  argv: cottontail.argv || ["cottontail", ...(cottontail.args || [])],
  argv0: cottontailExecPath,
  execPath: cottontailExecPath,
  env: cottontail.env(),
  platform: platform(),
  arch: cottontail.arch(),
  pid: cottontail.pid?.() ?? 0,
  versions: { node: "24.0.0", cottontail: "0.0.0-dev" },
  release: { name: "cottontail" },
  cwd: () => cottontail.cwd(),
  exit: (code = 0) => cottontail.exit(code),
  emitWarning: (message, type = "Warning") => console.warn(`${type}: ${message}`),
};
g.process = processObject;
installProcessApi(g.process);
if (g.process.env?.COTTONTAIL_TEST_CLI_HEADER_PRINTED === "1") {
  globalThis.__cottontailBunTestHeaderPrinted = true;
  delete g.process.env.COTTONTAIL_TEST_CLI_HEADER_PRINTED;
}
g.process.execPath ??= cottontailExecPath;
g.process.argv0 ??= g.process.execPath;
g.process.execArgv ??= Array.from(cottontail.execArgv || []);
if (typeof cottontail.gc === "function" &&
    Array.prototype.some.call(g.process.execArgv, (arg) => arg === "--expose-gc" || arg === "--expose_gc")) {
  let exposedGc;
  try {
    exposedGc = (0, eval)("typeof gc === 'function' ? gc : undefined");
  } catch {}
  Object.defineProperty(g, "gc", {
    value: exposedGc ?? ((options = undefined) => {
      const result = cottontail.gc();
      globalThis.__cottontailForcedWeakRefGc?.();
      globalThis.__cottontailAsyncHooksOnGc?.();
      if (options && typeof options === "object" && options.execution === "async") return Promise.resolve(result);
      return result;
    }),
    configurable: true,
    writable: true,
  });
}
g.process.versions ??= { node: "24.0.0", cottontail: "0.0.0-dev" };
g.process.versions.node ??= "24.0.0";
g.process.release ??= { name: "cottontail" };
g.process.emitWarning ??= (message, type = "Warning") => console.warn(`${type}: ${message}`);
g.process.stdin ??= createReadableStdio(0);
g.process.stdout ??= createWritableStdio(1);
g.process.stderr ??= createWritableStdio(2);

const ipcPrefix = "__COTTONTAIL_IPC__";
const nativeIpcFd = Number(g.process.env?.COTTONTAIL_IPC_FD);
let installNativeProcessIpcReader = null;
if (Number.isInteger(nativeIpcFd) && nativeIpcFd > 2 &&
    g.process.env?.COTTONTAIL_IPC_BOOTSTRAP !== "node" &&
    typeof cottontail.ipcSend === "function" &&
    typeof g.process.send !== "function") {
  g.process.connected = true;
  g.process.send = (message) => {
    if (!g.process.connected) return false;
    return cottontail.ipcSend(nativeIpcFd, `${ipcPrefix}${JSON.stringify(message)}\n`) === true;
  };
  g.process.disconnect = () => {
    if (!g.process.connected) return;
    g.process.connected = false;
    g.process.emit("disconnect");
  };

  if (typeof cottontail.ipcRecv === "function") {
    installNativeProcessIpcReader = () => {
      let ipcBuffer = "";
      const pollIpc = () => {
        if (!g.process.connected) return;
        try {
          for (;;) {
            const event = cottontail.ipcRecv(nativeIpcFd, 64 * 1024);
            if (!event) break;
            if (event.end) {
              g.process.disconnect();
              return;
            }
            ipcBuffer += new TextDecoder().decode(event.data ?? new ArrayBuffer(0));
            for (;;) {
              const newlineIndex = ipcBuffer.indexOf("\n");
              if (newlineIndex < 0) break;
              const line = ipcBuffer.slice(0, newlineIndex).replace(/\r$/, "");
              ipcBuffer = ipcBuffer.slice(newlineIndex + 1);
              if (!line.startsWith(ipcPrefix)) continue;
              g.process.emit("message", JSON.parse(line.slice(ipcPrefix.length)));
            }
          }
        } catch (error) {
          g.process.emit("error", error);
        }
      };
      const ipcTimer = g.setInterval(pollIpc, 4);
      ipcTimer.unref?.();
    };
  }
} else if (g.process.env?.COTTONTAIL_IPC_STDIO === "1" &&
    g.process.env?.COTTONTAIL_IPC_BOOTSTRAP === "bun" &&
    typeof g.process.send !== "function") {
  g.process.connected = true;
  g.process.send = (message) => {
    if (!g.process.connected) return false;
    return g.process.stdout.write(`${ipcPrefix}${JSON.stringify(message)}\n`);
  };
  g.process.disconnect = () => {
    g.process.connected = false;
    g.process.emit("disconnect");
  };

  let ipcBuffer = "";
  g.process.stdin.setEncoding("utf8");
  g.process.stdin.on("data", (chunk) => {
    ipcBuffer += String(chunk);
    for (;;) {
      const newlineIndex = ipcBuffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = ipcBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      ipcBuffer = ipcBuffer.slice(newlineIndex + 1);
      if (!line.startsWith(ipcPrefix)) continue;
      try {
        g.process.emit("message", JSON.parse(line.slice(ipcPrefix.length)));
      } catch (error) {
        g.process.emit("error", error);
      }
    }
  });
  g.process.stdin.on("end", () => {
    if (g.process.connected) g.process.disconnect();
  });
  g.process.stdin.resume();
}

// Bun-flavored value formatter for console output. Mirrors bun's console
// inspector: objects always print multiline with trailing commas, keys are
// bare only when they are ASCII identifiers, functions print as
// [Function: name], small arrays print inline, plain objects deeper than the
// depth limit collapse to [Object ...].
const consoleInspectCustom = Symbol.for("nodejs.util.inspect.custom");
const consoleIdentifierKey = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
{
  const attachInspectCustom = (inspect) => {
    if (typeof inspect === "function" && !Object.prototype.hasOwnProperty.call(inspect, "custom")) {
      Object.defineProperty(inspect, "custom", {
        value: consoleInspectCustom,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  };
  const installInspectSetter = (target) => {
    const current = target.inspect;
    if (current !== undefined) {
      attachInspectCustom(current);
      return;
    }
    Object.defineProperty(target, "inspect", {
      configurable: true,
      enumerable: true,
      get: () => undefined,
      set(value) {
        attachInspectCustom(value);
        Object.defineProperty(target, "inspect", {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
    });
  };
  const initialBun = g.Bun;
  if (initialBun && (typeof initialBun === "object" || typeof initialBun === "function")) {
    installInspectSetter(initialBun);
  } else if (Object.getOwnPropertyDescriptor(g, "Bun")?.configurable !== false) {
    Object.defineProperty(g, "Bun", {
      configurable: true,
      get: () => undefined,
      set(value) {
        if (value && (typeof value === "object" || typeof value === "function")) {
          installInspectSetter(value);
        }
        Object.defineProperty(g, "Bun", {
          configurable: true,
          enumerable: true,
          writable: true,
          value,
        });
      },
    });
  }
}

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
  const cliValue = g.process?.env?.COTTONTAIL_CONSOLE_DEPTH;
  const configured = cliValue !== undefined && /^\d+$/.test(cliValue)
    ? Number(cliValue)
    : bunfigConsoleDepth();
  return configured === 0 ? Number.MAX_SAFE_INTEGER : (configured ?? 2);
})();

const formatFunctionValue = (value) => {
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

const formatConsoleKey = (key) => {
  if (typeof key === "symbol") return `[${String(key)}]`;
  return consoleIdentifierKey.test(key) ? key : JSON.stringify(key);
};

const consoleOwnValue = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
};

const consolePrototypeValue = (value, key) => {
  let current = value;
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
};

const consoleIteratorTag = (value) => {
  let current = Object.getPrototypeOf(value);
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, Symbol.toStringTag);
    if (descriptor && typeof descriptor.value === "string") return descriptor.value;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
};

const consoleArrayTokenWidth = (value, rendered) => {
  if (typeof value === "string") return value.length;
  return rendered.includes("\n") ? 80 : rendered.length;
};

const formatConsoleArrayTokens = (tokens, indent, prefix = "", multiline = false) => {
  if (tokens.length === 0) return `${prefix}[]`;
  if (!multiline) return `${prefix}[ ${tokens.map((token) => token.text).join(", ")} ]`;

  const pad = " ".repeat(indent + 2);
  const lines = [];
  let line = "";
  let estimated = indent + 2;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const hasMore = index + 1 < tokens.length;
    if (token.forceLine || token.text.includes("\n")) {
      if (line) {
        lines.push(line + ",");
        line = "";
      }
      lines.push(pad + token.text + (hasMore ? "," : ""));
      estimated = indent + 2;
      continue;
    }
    if (!line) {
      line = pad + token.text;
      estimated = indent + 2 + token.width;
    } else {
      line += `, ${token.text}`;
      estimated += 2 + token.width;
    }
    if (estimated >= 80 && hasMore) {
      lines.push(line + ",");
      line = "";
      estimated = indent + 2;
    }
  }
  if (line) lines.push(line);
  return `${prefix}[\n${lines.join("\n")}\n${" ".repeat(indent)}]`;
};

const formatConsoleValue = (value, seen, objectDepth, indent, options) => {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return Object.is(value, -0) ? "-0" : String(value);
    case "bigint":
      return `${value}n`;
    case "boolean":
    case "undefined":
      return String(value);
    case "symbol":
      return value.toString();
    case "function":
      return formatFunctionValue(value);
  }
  if (value === null) return "null";
  if (seen.has(value)) return "[Circular]";

  if (options.customInspect) {
    const custom = consolePrototypeValue(value, consoleInspectCustom);
    if (typeof custom === "function") {
      const remainingDepth = options.depth === Number.MAX_SAFE_INTEGER
        ? options.depth
        : Math.max(options.depth - objectDepth, 0);
      const result = custom.call(value, remainingDepth, {
        colors: false,
        depth: options.depth,
        stylize: (text) => String(text),
      });
      if (result !== value) {
        return typeof result === "string"
          ? result
          : formatConsoleValue(result, seen, objectDepth, indent, options);
      }
    }
  }

  if (value instanceof String) return `[String: ${JSON.stringify(String.prototype.valueOf.call(value))}]`;
  if (value instanceof Number) return `[Number: ${formatConsoleValue(Number.prototype.valueOf.call(value), seen, objectDepth, indent, options)}]`;
  if (value instanceof Boolean) return `[Boolean: ${Boolean.prototype.valueOf.call(value)}]`;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === BigInt.prototype) return `[BigInt: ${BigInt.prototype.valueOf.call(value)}n]`;
  if (prototype === Symbol.prototype) return `[Symbol: ${String(Symbol.prototype.valueOf.call(value))}]`;

  if (value instanceof Error) {
    const name = value.name ?? "Error";
    const header = value.message ? `${name}: ${value.message}` : String(name);
    const stack = typeof value.stack === "string" && value.stack.length > 0 ? value.stack : "";
    if (!stack) return header;
    return stack.startsWith(name) ? stack : `${header}\n${stack.replace(/^/gm, "      ")}`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  }
  if (value instanceof RegExp) return String(value);
  if (typeof Promise !== "undefined" && value instanceof Promise) return "Promise { <pending> }";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const tokens = [];
      let nonempty = 0;
      let complex = false;
      for (let index = 0; index < value.length;) {
        if (!(index in value)) {
          const start = index;
          while (index < value.length && !(index in value)) index += 1;
          const count = index - start;
          const text = count === 1 ? "empty item" : `${count} x empty items`;
          tokens.push({ text, width: text.length });
          continue;
        }
        if (nonempty >= 100) {
          const text = `... ${value.length - index} more items`;
          tokens.push({ text, width: text.length, forceLine: true });
          break;
        }
        const item = value[index];
        const rendered = formatConsoleValue(item, seen, objectDepth, indent + 2, options);
        tokens.push({ text: rendered, width: consoleArrayTokenWidth(item, rendered) });
        complex ||= item !== null && (typeof item === "object" || typeof item === "function");
        nonempty += 1;
        index += 1;
      }
      return formatConsoleArrayTokens(
        tokens,
        indent,
        "",
        value.length > 10 || complex || tokens.some((token) => token.text.includes("\n")),
      );
    }
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
      const shown = Array.from(value.subarray(0, 50), (byte) => byte.toString(16).padStart(2, "0"));
      const suffix = value.length > 50 ? ` ... ${value.length - 50} more bytes` : "";
      return `<Buffer ${shown.join(" ")}${suffix}>`;
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const tokens = Array.from(value, (item) => {
        const text = formatConsoleValue(item, seen, objectDepth, indent + 2, options);
        return { text, width: consoleArrayTokenWidth(item, text) };
      });
      const name = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(value), "constructor")?.value?.name ?? "TypedArray";
      return formatConsoleArrayTokens(tokens, indent, `${name}(${value.length}) `, value.length > 10);
    }
    if (
      value instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer)
    ) {
      const shared = typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;
      const tokens = Array.from(new Uint8Array(value), (byte) => ({ text: String(byte), width: String(byte).length }));
      const name = shared ? "SharedArrayBuffer" : "ArrayBuffer";
      return formatConsoleArrayTokens(tokens, indent, `${name}(${value.byteLength}) `, tokens.length > 10);
    }
    if (value instanceof Map) {
      if (value.size === 0) return "Map {}";
      const pad = " ".repeat(indent + 2);
      let out = `Map(${value.size}) {\n`;
      for (const [key, item] of value) {
        out += `${pad}${formatConsoleValue(key, seen, objectDepth, indent + 2, options)}: ${formatConsoleValue(item, seen, objectDepth, indent + 2, options)},\n`;
      }
      return `${out}${" ".repeat(indent)}}`;
    }
    if (value instanceof Set) {
      if (value.size === 0) return "Set {}";
      const pad = " ".repeat(indent + 2);
      let out = `Set(${value.size}) {\n`;
      for (const item of value) {
        out += `${pad}${formatConsoleValue(item, seen, objectDepth, indent + 2, options)},\n`;
      }
      return `${out}${" ".repeat(indent)}}`;
    }

    const iteratorTag = consoleIteratorTag(value);
    if (iteratorTag === "Set Iterator" || iteratorTag === "Map Iterator") {
      const name = iteratorTag === "Set Iterator" ? "SetIterator" : "MapIterator";
      const items = Array.from(value);
      if (items.length === 0) return `${name} { }`;
      const pad = " ".repeat(indent + 2);
      let out = `${name} { \n`;
      for (const item of items) {
        out += `${pad}${formatConsoleValue(item, seen, objectDepth, indent + 2, options)},\n`;
      }
      return `${out}${" ".repeat(indent)}}`;
    }

    if (objectDepth > options.depth) return "[Object ...]";
    let prefix = "";
    if (prototype === null) prefix = "[Object: null prototype] ";
    else {
      const tag = consoleOwnValue(value, Symbol.toStringTag);
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      const name = typeof tag === "string" ? tag : constructor?.name;
      if (name && name !== "Object") prefix = `${name} `;
    }
    const keys = Reflect.ownKeys(value).filter((key) => Object.getOwnPropertyDescriptor(value, key)?.enumerable);
    if (prototype && prototype !== Object.prototype && prototype !== null) {
      for (const key of Reflect.ownKeys(prototype)) {
        if (key === "constructor" || keys.includes(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (typeof descriptor?.value === "function") keys.push(key);
      }
    }
    if (keys.length === 0) return `${prefix}{}`;
    const pad = " ".repeat(indent + 2);
    let out = `${prefix}{\n`;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key) ?? Object.getOwnPropertyDescriptor(prototype, key);
      let rendered;
      if (descriptor && !("value" in descriptor)) {
        rendered = descriptor.get && descriptor.set ? "[Getter/Setter]" : descriptor.get ? "[Getter]" : "[Setter]";
      } else {
        rendered = formatConsoleValue(descriptor?.value, seen, objectDepth + 1, indent + 2, options);
      }
      out += `${pad}${formatConsoleKey(key)}: ${rendered},\n`;
    }
    return `${out}${" ".repeat(indent)}}`;
  } finally {
    seen.delete(value);
  }
};

const formatConsoleArg = (value, options = { depth: consoleDepth, customInspect: true }) => {
  if (typeof value === "string") return value;
  try {
    return formatConsoleValue(value, new Set(), 0, 0, options);
  } catch (error) {
    if (/revoked/i.test(String(error?.message))) return "<Revoked Proxy>";
    try {
      return String(value);
    } catch {
      return "<Revoked Proxy>";
    }
  }
};

const consoleIntegerFormat = (value) => {
  if (typeof value === "symbol") return "NaN";
  let number;
  try {
    number = Number(value);
  } catch {
    return "NaN";
  }
  if (!Number.isFinite(number)) return "NaN";
  if (number === 0) return "0";
  const sign = number < 0 ? -1 : 1;
  number = Math.abs(number);
  if (number >= 1e21) {
    while (number >= 10) number /= 10;
  } else if (number < 1e-6) {
    while (number < 1) number *= 10;
  }
  return String(Math.floor(number) * sign);
};

const consoleFloatFormat = (value) => {
  if (typeof value === "symbol") return "NaN";
  let number;
  try {
    number = Number(value);
  } catch {
    return "NaN";
  }
  if (Number.isNaN(number)) return "NaN";
  if (number === Infinity) return "Infinity";
  if (number === -Infinity) return "-Infinity";
  if (Object.is(number, -0)) return "0";
  return String(number);
};

const formatConsolePlaceholders = (format, values) => {
  let output = "";
  let cursor = 0;
  let valueIndex = 0;
  for (let index = 0; index < format.length && valueIndex < values.length; index += 1) {
    if (format[index] !== "%" || index + 1 >= format.length) continue;
    const token = format[index + 1];
    if (token === "%") {
      output += format.slice(cursor, index) + "%";
      cursor = index + 2;
      index += 1;
      continue;
    }
    if (!"sifdoOcj".includes(token)) continue;
    const value = values[valueIndex++];
    let rendered = "";
    if (token === "s") {
      try { rendered = String(value); } catch { rendered = ""; }
    } else if (token === "i" || token === "d") rendered = consoleIntegerFormat(value);
    else if (token === "f") rendered = consoleFloatFormat(value);
    else if (token === "o" || token === "O") rendered = formatConsoleArg(value);
    else if (token === "j") rendered = JSON.stringify(value);
    output += format.slice(cursor, index) + (rendered ?? "undefined");
    cursor = index + 2;
    index += 1;
  }
  output += format.slice(cursor);
  return { text: output, remaining: values.slice(valueIndex) };
};

const formatConsoleArguments = (args, substitutions = true, options = undefined) => {
  if (args.length === 0) return "";
  let text;
  let remaining;
  if (substitutions && typeof args[0] === "string" && args.length > 1) {
    const formatted = formatConsolePlaceholders(args[0], args.slice(1));
    text = formatted.text;
    remaining = formatted.remaining;
  } else {
    text = formatConsoleArg(args[0], options);
    remaining = args.slice(1);
  }
  for (const value of remaining) text += ` ${formatConsoleArg(value, options)}`;
  return text;
};

const consoleErrorSource = (error) => {
  const filename = String(g.__filename ?? g.process?.argv?.[1] ?? "");
  if (!filename || !error?.message) return undefined;
  let lines;
  try {
    lines = String(cottontail.readFile(filename)).split(/\r?\n/);
  } catch {
    return undefined;
  }
  const quotedMessage = JSON.stringify(String(error.message));
  const index = lines.findIndex((line) => line.includes(quotedMessage));
  if (index < 0) return undefined;
  const line = lines[index];
  const plainError = String(error.name ?? "Error") === "Error";
  const columnIndex = plainError
    ? Math.max(0, line.indexOf("Error("))
    : Math.max(0, line.indexOf("new "));
  return { filename, lines, lineIndex: index, column: columnIndex + 1, plainError };
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
    return `${consoleGroupIndent}${heading}\n${stack}\n`;
  }

  const firstLine = Math.max(0, source.lineIndex - 5);
  const excerpt = [];
  for (let index = firstLine; index <= source.lineIndex; index += 1) {
    const prefix = index === firstLine ? consoleGroupIndent : "";
    excerpt.push(`${prefix}${index + 1} | ${source.lines[index]}`);
  }
  excerpt.push(" ".repeat(String(lineNumber).length + 3 + source.column - 1) + "^");
  excerpt.push(`${source.plainError ? "error" : name}: ${message}`);
  excerpt.push(stack, "");
  return excerpt.join("\n");
};

const nativeConsoleLog = console.log?.bind(console);
const nativeConsoleError = console.error?.bind(console);
const nativeConsoleWarn = console.warn?.bind(console) ?? nativeConsoleError;
let consoleGroupIndent = "";
const indentConsoleText = (text, indentLines = true) => {
  const rendered = String(text);
  return consoleGroupIndent + (indentLines ? rendered.replace(/\n/g, `\n${consoleGroupIndent}`) : rendered);
};
const writeConsole = (writer, args, substitutions = true, options = undefined, level = undefined) => {
  let isError = false;
  if (args.length === 1 && level) {
    try { isError = args[0] instanceof Error; } catch {}
  }
  if (isError) {
    const renderedError = formatConsoleError(args[0], level);
    if (renderedError !== undefined) {
      writer?.(renderedError);
      return;
    }
  }
  const rendered = formatConsoleArguments(args, substitutions, options);
  if (args.length === 1 && typeof args[0] === "string" && rendered.includes("\n")) {
    const lines = rendered.split("\n");
    const fd = writer === nativeConsoleLog ? 1 : 2;
    for (let index = 0; index < lines.length; index += 1) {
      cottontail.fdWrite(fd, `${index === 0 ? consoleGroupIndent : ""}${lines[index]}\n`);
    }
    return;
  }
  const indentLines = typeof args[0] !== "string";
  writer?.(indentConsoleText(rendered, indentLines));
};
console.log = (...args) => writeConsole(nativeConsoleLog, args);
console.error = (...args) => writeConsole(nativeConsoleError, args, true, undefined, "error");
console.warn = (...args) => writeConsole(nativeConsoleWarn, args, true, undefined, "warn");
console.info = console.log;
console.debug = console.log;
{
  const counts = new Map();
  const times = new Map();
  const consoleNow = typeof cottontail?.nanotime === "function"
    ? () => Number(cottontail.nanotime()) / 1e6
    : () => Date.now();
  console.count = (label = "default") => {
    const key = String(label);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    console.log(`${key}: ${next}`);
  };
  console.countReset = (label = "default") => {
    counts.delete(String(label));
  };
  console.group = (...args) => {
    if (args.length > 0) {
      console.log(...args);
    }
    consoleGroupIndent += "  ";
  };
  console.groupEnd = () => {
    consoleGroupIndent = consoleGroupIndent.slice(0, Math.max(0, consoleGroupIndent.length - 2));
  };
  console.groupCollapsed = console.group;
  console.dir = (value, dirOptions = undefined) => {
    let depth = consoleDepth;
    if (dirOptions && Object.prototype.hasOwnProperty.call(dirOptions, "depth")) {
      const requested = Number(dirOptions.depth);
      depth = requested === Infinity
        ? Number.MAX_SAFE_INTEGER
        : (Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 0);
    }
    writeConsole(nativeConsoleLog, [value], false, { depth, customInspect: false });
  };
  console.assert = (condition, ...args) => {
    if (!condition) console.error("Assertion failed" + (args.length ? ":" : ""), ...args);
  };
  console.time = (label = "default") => {
    const key = String(label);
    if (!times.has(key)) times.set(key, consoleNow());
  };
  const logTime = (label, data, remove) => {
    const key = String(label);
    const started = times.get(key);
    if (started == null) return;
    const elapsed = Math.max(0, consoleNow() - started).toFixed(2);
    const suffix = data.length > 0 ? ` ${formatConsoleArguments(data, false)}` : "";
    nativeConsoleError?.(indentConsoleText(`[${elapsed}ms] ${key}${suffix}`));
    if (remove) times.delete(key);
  };
  console.timeLog = (label = "default", ...data) => logTime(label, data, false);
  console.timeEnd = (label = "default") => logTime(label, [], true);
}
g.global ??= g;
g.self ??= g;
g.performance ??= {};
{
  const monotonicNow = typeof cottontail?.nanotime === "function"
    ? (() => { const base = cottontail.nanotime(); return () => Number(cottontail.nanotime() - base) / 1e6; })()
    : (() => { const base = Date.now(); return () => Date.now() - base; })();
  const timeOrigin = Date.now() - monotonicNow();
  if (g.performance.timeOrigin == null || !(g.performance.timeOrigin > 0)) {
    // Rebase: performance.now() measures from timeOrigin; timeOrigin is the epoch start.
    g.performance.now = monotonicNow;
    Object.defineProperty(g.performance, "timeOrigin", { value: timeOrigin, enumerable: true, configurable: true });
  }
  g.performance.now ??= monotonicNow;
  // The full Performance/PerformanceEntry/PerformanceObserver surface is
  // installed by bun/index.js once EventTarget exists.
}
g.setImmediate ??= (callback, ...args) => setTimeout(callback, 0, ...args);
g.clearImmediate ??= (handle) => clearTimeout(handle);

if (typeof g.URLSearchParams !== "function") {
  g.URLSearchParams = class URLSearchParams {
    constructor(init = "") {
      this._entries = [];
      if (typeof init === "string") {
        const source = init.startsWith("?") ? init.slice(1) : init;
        for (const part of source.split("&")) {
          if (!part) continue;
          const [rawKey, rawValue = ""] = part.split("=");
          this.append(decodeURIComponent(rawKey.replace(/\+/g, " ")), decodeURIComponent(rawValue.replace(/\+/g, " ")));
        }
      } else if (Array.isArray(init)) {
        for (const [key, value] of init) this.append(key, value);
      } else if (init && typeof init === "object") {
        for (const key of Object.keys(init)) this.append(key, init[key]);
      }
    }
    append(key, value) {
      this._entries.push([String(key), String(value)]);
    }
    set(key, value) {
      key = String(key);
      this.delete(key);
      this.append(key, value);
    }
    get(key) {
      key = String(key);
      const entry = this._entries.find((item) => item[0] === key);
      return entry ? entry[1] : null;
    }
    has(key) {
      key = String(key);
      return this._entries.some((item) => item[0] === key);
    }
    delete(key) {
      key = String(key);
      this._entries = this._entries.filter((item) => item[0] !== key);
    }
    toString() {
      return this._entries
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
    }
    [Symbol.iterator]() {
      return this._entries[Symbol.iterator]();
    }
  };
}

if (typeof g.URL !== "function" || !("searchParams" in new g.URL("http://example.test"))) {
  g.URL = class URL {
    constructor(input, base) {
      const source = String(input);
      const resolved = base && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(source)
        ? String(base).replace(/[^/]*$/, "") + source
        : source;
      const match = /^([A-Za-z][A-Za-z0-9+.-]*:)?(\/\/([^/?#]*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(resolved) || [];
      this.protocol = match[1] || "";
      this.host = match[3] || "";
      if (this.host.startsWith("[")) {
        const bracket = this.host.indexOf("]");
        this.hostname = bracket >= 0 ? this.host.slice(0, bracket + 1) : this.host;
        this.port = bracket >= 0 && this.host[bracket + 1] === ":" ? this.host.slice(bracket + 2) : "";
      } else {
        const colon = this.host.lastIndexOf(":");
        if (colon >= 0 && /^\d+$/.test(this.host.slice(colon + 1))) {
          this.hostname = this.host.slice(0, colon);
          this.port = this.host.slice(colon + 1);
        } else {
          this.hostname = this.host;
          this.port = "";
        }
      }
      this.pathname = match[4] || (this.host ? "/" : "");
      this.hash = match[6] || "";
      this.searchParams = new g.URLSearchParams(match[5] || "");
    }
    get search() {
      const value = this.searchParams.toString();
      return value ? `?${value}` : "";
    }
    set search(value) {
      this.searchParams = new g.URLSearchParams(value);
    }
    get href() {
      return `${this.protocol}${this.host ? `//${this.host}` : ""}${this.pathname}${this.search}${this.hash}`;
    }
    set href(value) {
      const next = new g.URL(value);
      Object.assign(this, next);
    }
    get origin() {
      return this.host ? `${this.protocol}//${this.host}` : "null";
    }
    toString() {
      return this.href;
    }
    toJSON() {
      return this.href;
    }
  };
}

// TextEncoder/TextDecoder are installed on globalThis by ./encoding.js
// (imported first, above). Node Buffer semantics never strip a BOM, so the
// module-level utf-8 decoder used by Buffer.toString runs with ignoreBOM.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true });

function bytesFromString(input) {
  return textEncoder.encode(String(input));
}

function stringFromBytes(bytes) {
  return textDecoder.decode(bytes);
}

const canonicalUtf8BlobTypes = new Set([
  "application/javascript",
  "application/json",
  "text/css",
  "text/html",
  "text/javascript",
  "text/plain",
]);

function normalizeBlobType(type = "") {
  const source = String(type);
  if (/[^\x20-\x7e]/.test(source)) return "";
  return canonicalUtf8BlobTypes.has(source) ? `${source};charset=utf-8` : source.toLowerCase();
}

function bytesFromBlobPart(part) {
  if (part == null) return new Uint8Array(0);
  if (typeof part === "string") return bytesFromString(part);
  if (part instanceof ArrayBuffer) return new Uint8Array(part);
  if (ArrayBuffer.isView(part)) return new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
  if (part?._bytes instanceof Uint8Array) return new Uint8Array(part._bytes);
  return bytesFromString(String(part));
}

function relativeBlobIndex(value, size, fallback) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number)) return number < 0 ? 0 : size;
  if (number < 0) return Math.max(size + number, 0);
  return Math.min(number, size);
}

function installBlobGlobals() {
  if (typeof g.Blob !== "function") {
    class CottontailBlob {
      constructor(parts = [], options = {}) {
        if (typeof parts === "string" || parts == null) throw new TypeError("Blob parts must be an iterable object");
        const sourceParts = parts instanceof ArrayBuffer || ArrayBuffer.isView(parts) ? [parts] : parts;
        if (typeof sourceParts[Symbol.iterator] !== "function") throw new TypeError("Blob parts must be iterable");
        const chunks = Array.from(sourceParts, bytesFromBlobPart);
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        this._bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          this._bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        this.type = normalizeBlobType(options?.type);
      }

      get size() {
        return this._bytes.byteLength;
      }

      async arrayBuffer() {
        return this._bytes.slice().buffer;
      }

      async bytes() {
        return this._bytes.slice();
      }

      async text() {
        return stringFromBytes(this._bytes);
      }

      slice(start = 0, end = this.size, type = "") {
        const relativeStart = relativeBlobIndex(start, this.size, 0);
        const relativeEnd = relativeBlobIndex(end, this.size, this.size);
        return new g.Blob([this._bytes.slice(relativeStart, Math.max(relativeStart, relativeEnd))], { type });
      }

      stream() {
        const bytes = this._bytes.slice();
        if (typeof g.ReadableStream === "function") {
          return new g.ReadableStream({
            start(controller) {
              // An empty blob closes without enqueuing an empty chunk.
              if (bytes.byteLength > 0) controller.enqueue(bytes);
              controller.close();
            },
          });
        }
        return {
          async *[Symbol.asyncIterator]() {
            if (bytes.byteLength > 0) yield bytes;
          },
        };
      }
    }
    Object.defineProperty(g, "Blob", {
      configurable: true,
      writable: true,
      value: CottontailBlob,
    });
  }

  if (typeof g.File !== "function") {
    class CottontailFile extends g.Blob {
      constructor(parts, name, options = {}) {
        if (arguments.length < 2) throw new TypeError("File constructor requires file bits and name");
        if (typeof parts === "string" || parts == null) throw new TypeError("File bits must be an iterable object");
        super(parts, options);
        this.name = String(name);
        this.lastModified = Number(options?.lastModified ?? Date.now());
      }
    }
    Object.defineProperty(CottontailFile, "name", { value: "File", configurable: true });
    Object.defineProperty(g, "File", {
      configurable: true,
      writable: true,
      value: CottontailFile,
    });
  }
}

function installObjectURLRegistry() {
  if (!g.URL || g.URL.__cottontailObjectURLRegistryInstalled) return;

  const registry = g.__cottontailObjectURLRegistry ??= new Map();
  g.__cottontailObjectURLNextId ??= 1;
  const nativeCreateObjectURL = typeof g.URL.createObjectURL === "function" ? g.URL.createObjectURL.bind(g.URL) : null;
  const nativeRevokeObjectURL = typeof g.URL.revokeObjectURL === "function" ? g.URL.revokeObjectURL.bind(g.URL) : null;

  Object.defineProperty(g.URL, "__cottontailObjectURLRegistryInstalled", {
    value: true,
    configurable: true,
  });

  Object.defineProperty(g.URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value(object) {
      if (!(object instanceof g.Blob)) {
        if (nativeCreateObjectURL) return nativeCreateObjectURL(object);
        throw new TypeError("URL.createObjectURL requires a Blob");
      }
      const id = `blob:nodedata:${Date.now().toString(36)}-${g.__cottontailObjectURLNextId++}`;
      registry.set(id, object);
      return id;
    },
  });

  Object.defineProperty(g.URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value(id) {
      const key = String(id);
      if (!registry.delete(key) && nativeRevokeObjectURL) nativeRevokeObjectURL(id);
    },
  });

  if (typeof g.resolveObjectURL !== "function") {
    Object.defineProperty(g, "resolveObjectURL", {
      configurable: true,
      writable: true,
      value(id) {
        return registry.get(String(id));
      },
    });
  }
}

installBlobGlobals();
installObjectURLRegistry();

function normalizeBufferEncoding(encoding = "utf8") {
  const raw = String(encoding || "utf8").toLowerCase();
  if (raw === "base64url" || raw === "base64-url") return "base64url";
  const normalized = raw.replace(/[-_]/g, "");
  if (normalized === "utf8" || normalized === "utf") return "utf8";
  if (normalized === "utf16le" || normalized === "ucs2") return "utf16le";
  if (normalized === "latin1" || normalized === "binary") return "latin1";
  if (normalized === "ascii" || normalized === "usascii") return "ascii";
  if (normalized === "base64") return "base64";
  if (normalized === "hex") return "hex";
  return "utf8";
}

function hexDecode(input) {
  const text = String(input);
  const out = [];
  for (let index = 0; index + 1 < text.length; index += 2) {
    const high = hexNibble(text.charCodeAt(index));
    const low = hexNibble(text.charCodeAt(index + 1));
    if (high < 0 || low < 0) break;
    out.push((high << 4) | low);
  }
  return new Uint8Array(out);
}

function hexNibble(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function hexEncode(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let output = "";
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0");
  return output;
}

function base64Decode(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(input).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "");
  const out = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    if (ch === "=") break;
    const value = chars.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function base64Encode(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const c = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (a << 16) | (b << 8) | c;
    output += chars[(triple >> 18) & 0x3f];
    output += chars[(triple >> 12) & 0x3f];
    output += index + 1 < bytes.length ? chars[(triple >> 6) & 0x3f] : "=";
    output += index + 2 < bytes.length ? chars[triple & 0x3f] : "=";
  }
  return output;
}

function bytesFromStringWithEncoding(input, encoding = "utf8") {
  const normalized = normalizeBufferEncoding(encoding);
  const text = String(input);
  if (normalized === "base64" || normalized === "base64url") return base64Decode(text);
  if (normalized === "hex") return hexDecode(text);
  if (normalized === "latin1" || normalized === "ascii") {
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index) & 0xff;
    return bytes;
  }
  if (normalized === "utf16le") {
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index += 1) {
      const value = text.charCodeAt(index);
      bytes[index * 2] = value & 0xff;
      bytes[index * 2 + 1] = (value >> 8) & 0xff;
    }
    return bytes;
  }
  return bytesFromString(text);
}

function stringFromBytesWithEncoding(bytes, encoding = "utf8", start = 0, end = bytes.length) {
  const normalized = normalizeBufferEncoding(encoding);
  const view = bytes.subarray(Math.max(0, Number(start) || 0), Math.min(bytes.length, end == null ? bytes.length : Number(end)));
  if (normalized === "base64") return base64Encode(view);
  if (normalized === "base64url") return base64Encode(view).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (normalized === "hex") return hexEncode(view);
  if (normalized === "latin1") {
    let output = "";
    for (const byte of view) output += String.fromCharCode(byte);
    return output;
  }
  if (normalized === "ascii") {
    let output = "";
    for (const byte of view) output += String.fromCharCode(byte & 0x7f);
    return output;
  }
  if (normalized === "utf16le") {
    let output = "";
    for (let index = 0; index + 1 < view.length; index += 2) {
      output += String.fromCharCode(view[index] | (view[index + 1] << 8));
    }
    return output;
  }
  return stringFromBytes(view);
}

function invalidCharacterError(message) {
  if (typeof g.DOMException === "function") return new g.DOMException(message, "InvalidCharacterError");
  const error = new Error(message);
  error.name = "InvalidCharacterError";
  return error;
}

g.btoa ??= function btoa(input) {
  if (arguments.length === 0) throw new TypeError("btoa requires 1 argument (a string)");
  const text = String(input);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0xff) throw invalidCharacterError("The string contains invalid characters.");
    bytes[index] = code;
  }
  return base64Encode(bytes);
};

g.atob ??= function atob(input) {
  if (arguments.length === 0) throw new TypeError("atob requires 1 argument (a string)");
  // WHATWG forgiving-base64 decode: strip ASCII whitespace, validate
  // alphabet and padding, throw InvalidCharacterError on anything else.
  let text = String(input).replace(/[\t\n\f\r ]+/g, "");
  if (text.length % 4 === 0) text = text.replace(/={1,2}$/, "");
  if (text.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(text)) {
    throw invalidCharacterError("The string contains invalid characters.");
  }
  const bytes = base64Decode(text);
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
};

function CottontailBuffer(value, encoding = "utf8") {
  if (typeof value === "number") return CottontailBuffer.allocUnsafe(value);
  return CottontailBuffer.from(value, encoding);
}
CottontailBuffer.prototype = Object.create(Uint8Array.prototype);
CottontailBuffer.prototype.constructor = CottontailBuffer;
// TypedArray methods that build derived arrays (subarray/slice/map via
// @@species) must produce plain Uint8Arrays: CottontailBuffer called with a
// length would allocUnsafe and corrupt results.
Object.defineProperty(CottontailBuffer, Symbol.species, {
  get() { return Uint8Array; },
  configurable: true,
});

function normalizeSearchOffset(byteOffset, length) {
  let offset = Number(byteOffset ?? 0);
  if (!Number.isFinite(offset)) offset = 0;
  offset = Math.trunc(offset);
  if (offset < 0) offset = Math.max(length + offset, 0);
  if (offset > length) offset = length;
  return offset;
}

function bufferSearchBytes(value, encoding = "utf8") {
  if (typeof value === "number") return new Uint8Array([value & 0xff]);
  return CottontailBuffer.from(value, encoding);
}

function bufferIndexOf(buffer, value, byteOffset = 0, encoding = "utf8") {
  const needle = bufferSearchBytes(value, encoding);
  if (needle.length === 0) return normalizeSearchOffset(byteOffset, buffer.length);
  const start = normalizeSearchOffset(byteOffset, buffer.length);
  if (needle.length > buffer.length - start) return -1;
  outer: for (let index = start; index <= buffer.length - needle.length; index += 1) {
    for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
      if (buffer[index + needleIndex] !== needle[needleIndex]) continue outer;
    }
    return index;
  }
  return -1;
}

function makeBufferView(bytes, start = 0, end = bytes.length) {
  const view = Uint8Array.prototype.subarray.call(bytes, start, end);
  Object.setPrototypeOf(view, CottontailBuffer.prototype);
  installBufferMethods(view);
  return view;
}

function installBufferMethods(bytes) {
  bytes.toString = function toString(encoding = "utf8", start = 0, end = this.length) {
    return stringFromBytesWithEncoding(this, encoding, start, end);
  };
  bytes.equals = function equals(other) {
    const rhs = CottontailBuffer.from(other);
    if (this.length !== rhs.length) return false;
    for (let index = 0; index < this.length; index += 1) {
      if (this[index] !== rhs[index]) return false;
    }
    return true;
  };
  bytes.indexOf = function indexOf(value, byteOffset = 0, encoding = "utf8") {
    return bufferIndexOf(this, value, byteOffset, encoding);
  };
  bytes.includes = function includes(value, byteOffset = 0, encoding = "utf8") {
    return this.indexOf(value, byteOffset, encoding) !== -1;
  };
  bytes.copy = function copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    if (!ArrayBuffer.isView(target)) throw new TypeError("copy target must be a Buffer or Uint8Array");
    const destinationOffset = Math.max(0, Math.trunc(Number(targetStart) || 0));
    const start = Math.max(0, Math.min(this.length, Math.trunc(Number(sourceStart) || 0)));
    const end = Math.max(start, Math.min(this.length, Math.trunc(Number(sourceEnd) || 0)));
    const length = Math.min(end - start, Math.max(0, target.length - destinationOffset));
    if (length > 0) target.set(Uint8Array.prototype.slice.call(this, start, start + length), destinationOffset);
    return length;
  };
  bytes.write = function write(string, offset = 0, length = undefined, encoding = "utf8") {
    if (typeof offset === "string") {
      encoding = offset;
      offset = 0;
      length = this.length;
    } else if (typeof length === "string") {
      encoding = length;
      length = undefined;
    }
    const start = Math.max(0, Math.min(this.length, Math.trunc(Number(offset) || 0)));
    const maxLength = length == null ? this.length - start : Math.max(0, Math.trunc(Number(length) || 0));
    const source = CottontailBuffer.from(String(string), encoding);
    const written = Math.min(source.length, maxLength, this.length - start);
    this.set(source.subarray(0, written), start);
    return written;
  };
  bytes.slice = function slice(start = 0, end = this.length) {
    return makeBufferView(this, start, end);
  };
  bytes.subarray = function subarray(start = 0, end = this.length) {
    return makeBufferView(this, start, end);
  };
  bytes.fill = function fill(value, offset = 0, end = this.length, encoding = "utf8") {
    if (typeof offset === "string") {
      encoding = offset;
      offset = 0;
      end = this.length;
    } else if (typeof end === "string") {
      encoding = end;
      end = this.length;
    }
    const start = Math.max(0, Math.min(this.length, Math.trunc(Number(offset) || 0)));
    const stop = Math.max(start, Math.min(this.length, Math.trunc(Number(end) || 0)));
    if (typeof value === "number") {
      Uint8Array.prototype.fill.call(this, value & 0xff, start, stop);
      return this;
    }
    const pattern = bufferSearchBytes(value ?? 0, encoding);
    if (pattern.length === 0) {
      Uint8Array.prototype.fill.call(this, 0, start, stop);
      return this;
    }
    for (let index = start; index < stop; index += 1) this[index] = pattern[(index - start) % pattern.length];
    return this;
  };
  return bytes;
}

function makeBuffer(bytes) {
  Object.setPrototypeOf(bytes, CottontailBuffer.prototype);
  return installBufferMethods(bytes);
}

CottontailBuffer.from = function from(value = "", encoding = "utf8", length = undefined) {
  if (value instanceof ArrayBuffer) {
    // Buffer.from(arrayBuffer[, byteOffset[, length]]) shares the memory.
    const byteOffset = typeof encoding === "number" ? encoding : 0;
    const viewLength = length == null ? value.byteLength - byteOffset : Number(length);
    return makeBuffer(new Uint8Array(value, byteOffset, viewLength));
  }
  if (ArrayBuffer.isView(value)) return makeBuffer(new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice());
  if (Array.isArray(value)) return makeBuffer(new Uint8Array(value));
  return makeBuffer(bytesFromStringWithEncoding(value, encoding));
};
CottontailBuffer.alloc = function alloc(size, fill = 0, encoding = "utf8") {
  const bytes = makeBuffer(new Uint8Array(Number(size) || 0));
  if (fill != null && fill !== 0) {
    const fillBytes = typeof fill === "number" ? new Uint8Array([fill & 0xff]) : CottontailBuffer.from(fill, encoding);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = fillBytes[index % fillBytes.length] ?? 0;
  }
  return bytes;
};
CottontailBuffer.allocUnsafe = function allocUnsafe(size) {
  return makeBuffer(new Uint8Array(Number(size) || 0));
};
CottontailBuffer.allocUnsafeSlow = CottontailBuffer.allocUnsafe;
CottontailBuffer.concat = function concat(list, totalLength = undefined) {
  if (!Array.isArray(list)) throw new TypeError("Buffer.concat list must be an Array");
  const buffers = list.map((item) => CottontailBuffer.from(item));
  const length = totalLength == null ? buffers.reduce((sum, item) => sum + item.length, 0) : Number(totalLength) || 0;
  const output = makeBuffer(new Uint8Array(length));
  let offset = 0;
  for (const item of buffers) {
    output.set(item.subarray(0, Math.max(0, length - offset)), offset);
    offset += item.length;
    if (offset >= length) break;
  }
  return output;
};
CottontailBuffer.isBuffer = function isBuffer(value) {
  return value instanceof CottontailBuffer || (ArrayBuffer.isView(value) && typeof value.toString === "function" && typeof value.equals === "function");
};
CottontailBuffer.byteLength = function byteLength(value, encoding = "utf8") {
  return CottontailBuffer.from(value, encoding).length;
};

g.Buffer = typeof g.Buffer === "function" ? g.Buffer : CottontailBuffer;
g.Buffer.from ??= CottontailBuffer.from;
g.Buffer.alloc ??= CottontailBuffer.alloc;
g.Buffer.allocUnsafe ??= CottontailBuffer.allocUnsafe;
g.Buffer.allocUnsafeSlow ??= CottontailBuffer.allocUnsafeSlow;
g.Buffer.concat ??= CottontailBuffer.concat;
g.Buffer.isBuffer ??= CottontailBuffer.isBuffer;
g.Buffer.byteLength ??= CottontailBuffer.byteLength;

function shellEscape(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:.,=+@%-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function guessMimeType(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

function bunFile(path) {
  const filePath = String(path);
  return {
    name: filePath.split("/").pop() || filePath,
    type: guessMimeType(filePath),
    get size() {
      const result = cottontail.spawnSync("sh", ["-c", `wc -c < ${shellEscape(filePath)}`], { stdio: "pipe" });
      return result.status === 0 ? Number(result.stdout.trim()) || 0 : 0;
    },
    async exists() {
      return cottontail.existsSync(filePath);
    },
    async text() {
      return cottontail.readFile(filePath);
    },
    async json() {
      return JSON.parse(cottontail.readFile(filePath));
    },
    async arrayBuffer() {
      return cottontail.readFileBuffer(filePath);
    },
    writer() {
      const chunks = [];
      return {
        write(chunk) { chunks.push(chunk); },
        end(chunk) {
          if (chunk != null) chunks.push(chunk);
          const text = chunks.map((item) => typeof item === "string" ? item : textDecoder.decode(item)).join("");
          cottontail.writeFile(filePath, text);
        },
      };
    },
  };
}

async function bunWrite(path, data) {
  cottontail.writeFile(String(path), data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : String(data));
}

g.Bun ??= {};
g.Bun.argv ??= cottontail.argv || ["cottontail", ...(cottontail.args || [])];
g.Bun.env ??= processObject.env;
g.Bun.file ??= bunFile;
g.Bun.write ??= bunWrite;

const timers = new Map();
const cancelledTimers = new Set();
let nextTimerId = 1;
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

function timerNow() {
  return Number(g.performance.now());
}

function makeTimerHandle(id) {
  const handle = {
    [Symbol.toPrimitive]: () => id,
    valueOf: () => id,
    // Node's Timeout exposes _idleStart (ms since process start when the timer
    // was scheduled); frameworks like Next.js read and write it.
    _idleStart: timerNow(),
    ref() {
      const timer = timers.get(id);
      if (timer) timer.ref = true;
      return this;
    },
    unref() {
      const timer = timers.get(id);
      if (timer) timer.ref = false;
      return this;
    },
    hasRef() {
      return timers.get(id)?.ref !== false;
    },
    close() {
      cancelledTimers.add(id);
      if (this._entry) this._entry.destroyed = true;
      timers.delete(id);
      return this;
    },
    refresh() {
      const timer = timers.get(id) ?? this._entry;
      if (timer) {
        timer.destroyed = false;
        timer.deadline = timerNow() + (timer.interval ?? timer.duration ?? 0);
        cancelledTimers.delete(id);
        timers.set(id, timer);
      }
      return this;
    },
  };
  Object.defineProperty(handle, "_destroyed", {
    get() { return this._entry?.destroyed === true; },
    configurable: true,
  });
  return handle;
}

function timerId(value) {
  if (typeof value === "string" && !/^(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function installTimers() {
  if (g.__cottontailTimersInstalled) return;
  g.__cottontailTimersInstalled = true;
  g.setTimeout = (callback, ms = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError('The "callback" argument must be of type function');
    const id = nextTimerId++;
    cancelledTimers.delete(id);
    const handle = makeTimerHandle(id);
    const duration = Math.max(0, Number(ms) || 0);
    const entry = { id, deadline: timerNow() + duration, duration, callback, args, interval: null, ref: true, handle, destroyed: false };
    handle._entry = entry;
    timers.set(id, entry);
    return handle;
  };
  g.clearTimeout = (id) => {
    const key = timerId(id);
    if (key == null) return;
    const entry = id?._entry ?? timers.get(key);
    if (entry?.kind === "immediate") return;
    cancelledTimers.add(key);
    if (entry) entry.destroyed = true;
    timers.delete(key);
  };
  g.setInterval = (callback, ms = 0, ...args) => {
    if (typeof callback !== "function") throw new TypeError('The "callback" argument must be of type function');
    const id = nextTimerId++;
    const interval = Math.max(1, Number(ms) || 0);
    cancelledTimers.delete(id);
    const handle = makeTimerHandle(id);
    const entry = { id, deadline: timerNow() + interval, callback, args, interval, ref: true, handle, destroyed: false };
    handle._entry = entry;
    timers.set(id, entry);
    return handle;
  };
  g.clearInterval = g.clearTimeout;
  g.setImmediate = (callback, ...args) => {
    if (typeof callback !== "function") throw new TypeError('The "callback" argument must be of type function');
    const id = nextTimerId++;
    cancelledTimers.delete(id);
    const handle = makeTimerHandle(id);
    const entry = {
      id,
      deadline: timerNow(),
      duration: 0,
      callback,
      args,
      interval: null,
      ref: true,
      handle,
      destroyed: false,
      kind: "immediate",
    };
    handle._entry = entry;
    timers.set(id, entry);
    return handle;
  };
  g.clearImmediate = (id) => {
    const key = timerId(id);
    if (key == null) return;
    const entry = id?._entry ?? timers.get(key);
    if (entry?.kind !== "immediate") return;
    cancelledTimers.add(key);
    entry.destroyed = true;
    timers.delete(key);
  };
  g.requestAnimationFrame ??= (callback) => g.setTimeout(() => callback(timerNow()), 16);
  g.cancelAnimationFrame ??= g.clearTimeout;
  Object.defineProperty(g.setTimeout, promisifyCustom, {
    value: (ms = 1, value = undefined, options = undefined) => new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error("AbortError"));
        return;
      }
      const id = g.setTimeout(() => resolve(value), ms);
      options?.signal?.addEventListener?.("abort", () => {
        g.clearTimeout(id);
        reject(options.signal.reason ?? new Error("AbortError"));
      }, { once: true });
    }),
    configurable: true,
  });
  Object.defineProperty(g.setInterval, promisifyCustom, {
    value: async function* (ms = 1, value = undefined, options = undefined) {
      while (!options?.signal?.aborted) {
        yield await g.setTimeout[promisifyCustom](ms, value, options);
      }
    },
    configurable: true,
  });
  Object.defineProperty(g.setImmediate, promisifyCustom, {
    value: (value = undefined, options = undefined) => new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error("AbortError"));
        return;
      }
      const id = g.setImmediate(() => resolve(value));
      options?.signal?.addEventListener?.("abort", () => {
        g.clearImmediate(id);
        reject(options.signal.reason ?? new Error("AbortError"));
      }, { once: true });
    }),
    configurable: true,
  });
}

installTimers();
installNativeProcessIpcReader?.();

const spawnEventListeners = new Map();
let spawnEventHandlerInstalled = false;

function installSpawnEventHandler() {
  if (spawnEventHandlerInstalled) return;
  spawnEventHandlerInstalled = true;
  cottontail.spawnSetEventHandler?.((event) => {
    const entry = spawnEventListeners.get(Number(event?.id));
    if (typeof entry?.listener === "function") entry.listener(event);
  });
}

g.__cottontailRegisterSpawnListener = (id, listener) => {
  installSpawnEventHandler();
  const key = Number(id);
  const entry = { listener, ref: true };
  spawnEventListeners.set(key, entry);
  const unregister = () => {
    if (spawnEventListeners.get(key) === entry) {
      spawnEventListeners.delete(key);
    }
  };
  unregister.ref = () => {
    entry.ref = true;
  };
  unregister.unref = () => {
    entry.ref = false;
  };
  return unregister;
};

const workerMessageListeners = new Map();
function addWorkerListener(target, name, handler) {
  if (typeof handler !== "function") return target;
  const key = String(name);
  const handlers = workerMessageListeners.get(key) ?? [];
  handlers.push(handler);
  workerMessageListeners.set(key, handlers);
  return target;
}

function removeWorkerListener(target, name, handler) {
  const key = String(name);
  const handlers = workerMessageListeners.get(key) ?? [];
  workerMessageListeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
  return target;
}

function emitWorkerEvent(target, name, event) {
  const handler = target[`on${name}`];
  if (typeof handler === "function") handler.call(target, event);
  for (const listener of workerMessageListeners.get(String(name)) ?? []) {
    listener.call(target, event);
  }
}

function hasWorkerMessageListener() {
  if (typeof g.onmessage === "function") return true;
  return (workerMessageListeners.get("message") ?? []).length > 0;
}

function serializeWorkerMessage(message) {
  const seen = new WeakSet();
  return JSON.stringify(message, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return undefined;
    if (value && typeof value === "object") {
      if (seen.has(value)) return undefined;
      seen.add(value);
    }
    return value;
  });
}

function installWorkerGlobal() {
  if (!cottontail.isWorker?.()) return;
  g.self = g;
  g.postMessage = g.self.postMessage = (message) => {
    cottontail.workerPostMessage(serializeWorkerMessage(message));
  };
  g.addEventListener = g.self.addEventListener = function addEventListener(name, handler) {
    return addWorkerListener(g, name, handler);
  };
  g.removeEventListener = g.self.removeEventListener = function removeEventListener(name, handler) {
    return removeWorkerListener(g, name, handler);
  };
}

function pollWorkerGlobalMessages() {
  if (!cottontail.isWorker?.()) return;
  if (!hasWorkerMessageListener() && !g.__cottontailWebPollAlways?.()) return;
  for (const item of cottontail.workerPollIncomingMessages()) {
    let data = item;
    try {
      data = JSON.parse(item);
    } catch {}
    if (g.__cottontailWebInterceptWorkerMessage?.(data, null)) continue;
    data = g.__cottontailWebDecodeIncoming?.(data, null) ?? data;
    const event = g.__cottontailMakeMessageEvent?.("message", data) ?? { data };
    emitWorkerEvent(g, "message", event);
  }
}

installWorkerGlobal();

const workerInstances = new Map();
g.__cottontailActiveWorkerIds = () => [...workerInstances.keys()];
let workerNativeEventHandlerInstalled = false;

function installWorkerNativeEventHandler() {
  if (typeof cottontail.workerSetEventHandler !== "function") return false;
  if (workerNativeEventHandlerInstalled) return true;
  workerNativeEventHandlerInstalled = true;
  cottontail.workerSetEventHandler((event) => {
    const worker = workerInstances.get(Number(event?.id));
    if (!worker) return;
    if (event?.type === "exit") {
      workerInstances.delete(worker.id);
      if (worker._pollTimer != null) clearInterval(worker._pollTimer);
      worker._emit("exit", { code: 0 });
      return;
    }
    worker._poll();
  });
  return true;
}

function nextRunLoopDelay(now = timerNow()) {
  let nextDelay = 16;
  for (const timer of timers.values()) {
    const delay = timer.deadline - now;
    if (delay <= 0) return 1;
    if (delay < nextDelay) nextDelay = delay;
  }
  return Math.max(1, Math.min(50, Math.ceil(nextDelay)));
}

g.__cottontailHasActiveHandles = () => {
  if (cottontail.isWorker?.()) {
    if (hasWorkerMessageListener()) return true;
    if (g.__cottontailWebHasActiveHandles?.()) return true;
  }
  if (workerInstances.size > 0) return true;
  for (const timer of timers.values()) {
    if (timer.ref !== false) return true;
  }
  for (const entry of spawnEventListeners.values()) {
    if (entry.ref !== false) return true;
  }
  return false;
};

g.__cottontailRunLoopTick = () => {
  pollWorkerGlobalMessages();
  const now = timerNow();
  const due = Array.from(timers.values())
    .filter((timer) => timer.deadline <= now)
    .sort((a, b) => a.deadline - b.deadline || a.id - b.id);
  for (const timer of due) {
    if (!timers.has(timer.id)) continue;
    timers.delete(timer.id);
    timer.callback(...timer.args);
    if (timer.interval != null && !cancelledTimers.has(timer.id)) {
      timer.deadline = timerNow() + timer.interval;
      timers.set(timer.id, timer);
    } else {
      cancelledTimers.delete(timer.id);
      if (!timers.has(timer.id)) timer.destroyed = true;
    }
  }
  cottontail.drainJobs?.();
  return nextRunLoopDelay(timerNow());
};

function normalizeWorkerScriptPath(scriptPath) {
  const text = String(scriptPath);
  if (text.startsWith("file://")) return decodeURIComponent(new URL(text).pathname);
  return text;
}

function rewriteWorkerNamedImports(spec) {
  return String(spec)
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return "";
      const pieces = trimmed.split(/\s+as\s+/);
      return pieces.length === 2 ? `${pieces[0].trim()}: ${pieces[1].trim()}` : trimmed;
    })
    .filter(Boolean)
    .join(", ");
}

const workerBundleCache = new Map();

function workerTempDir() {
  const configured = cottontail.env?.()?.COTTONTAIL_TMP_DIR;
  return configured ? `${configured}/workers` : `${cottontail.cwd()}/.cottontail-tmp`;
}

function prepareWorkerScriptPath(scriptPath) {
  const target = normalizeWorkerScriptPath(scriptPath);
  if (target.startsWith("data:")) return target;
  const cached = workerBundleCache.get(target);
  if (cached && cottontail.existsSync?.(cached)) return cached;
  const tempDir = workerTempDir();
  cottontail.mkdirSync?.(tempDir, true);
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const wrapperPath = `${tempDir}/bun-worker-entry-${nonce}.mjs`;
  const bundledPath = `${tempDir}/bun-worker-${nonce}.js`;
  const slashCwd = String(cottontail.cwd()).replace(/\\/g, "/");
  const slashTarget = String(target).replace(/\\/g, "/");
  const runtimeEntry = `${slashCwd}/.cottontail-embedded-runtime/bun/index.js`;
  try {
    cottontail.writeFile(wrapperPath, [
      `import ${JSON.stringify(runtimeEntry)};`,
      `import ${JSON.stringify(slashTarget)};`,
    ].join("\n"));
    const bundled = cottontail.bundleNative(wrapperPath, cottontail.cwd(), JSON.stringify({
      format: "esm",
      target: "bun",
      includeRuntimeModules: true,
      inlineImportMetaProperties: true,
    }));
    cottontail.writeFile(bundledPath, bundled);
    workerBundleCache.set(target, bundledPath);
    return bundledPath;
  } catch {}

  let source;
  try {
    source = cottontail.readFile(target);
  } catch {
    return target;
  }
  const dir = target.replace(/\/[^/]*$/, "") || ".";
  const fileUrl = `file://${target}`;
  const transformed = String(source)
    .replace(/import\.meta\.dirname/g, JSON.stringify(dir))
    .replace(/import\.meta\.dir/g, JSON.stringify(dir))
    .replace(/import\.meta\.filename/g, JSON.stringify(target))
    .replace(/import\.meta\.path/g, JSON.stringify(target))
    .replace(/import\.meta\.url/g, JSON.stringify(fileUrl))
    .replace(/import\.meta\.main/g, "false")
    .replace(
      /^\s*import\s+\{([^}]*)\}\s+from\s+(['"])bun\2\s*;?\s*$/mg,
      (_all, names) => `const { ${rewriteWorkerNamedImports(names)} } = globalThis.Bun;`,
    );
  if (transformed === source) return target;
  cottontail.writeFile(bundledPath, [
    "globalThis.Bun ??= { isMainThread: false };",
    "globalThis.Bun.isMainThread = false;",
    transformed,
    `\n//# sourceURL=${target}`,
  ].join("\n"));
  return bundledPath;
}

g.Worker ??= class Worker {
  constructor(scriptPath) {
    this.scriptPath = prepareWorkerScriptPath(scriptPath);
    this.handle = cottontail.spawnWorker(this.scriptPath);
    this.id = this.handle.id;
    this.onmessage = null;
    this.onerror = null;
    this._listeners = new Map();
    workerInstances.set(this.id, this);
    this._pollTimer = installWorkerNativeEventHandler() ? null : setInterval(() => this._poll(), 16);
    queueMicrotask(() => this._emit("open", { type: "open", target: this }));
  }
  _add(name, handler) {
    if (typeof handler !== "function") return this;
    const handlers = this._listeners.get(name) ?? [];
    handlers.push(handler);
    this._listeners.set(name, handlers);
    return this;
  }
  _emit(name, event) {
    const propertyHandler = this[`on${name}`];
    if (typeof propertyHandler === "function") propertyHandler.call(this, event);
    for (const handler of this._listeners.get(name) ?? []) handler.call(this, event);
  }
  _poll() {
    for (const item of cottontail.workerPollMessages(this.id)) {
      let data = item;
      try {
        data = JSON.parse(item);
      } catch {}
      if (g.__cottontailWebInterceptWorkerMessage?.(data, this)) continue;
      data = g.__cottontailWebDecodeIncoming?.(data, this) ?? data;
      const event = g.__cottontailMakeMessageEvent?.("message", data) ?? { data };
      this._emit("message", event);
    }
  }
  postMessage(message) {
    cottontail.workerPostMessageTo(this.id, serializeWorkerMessage(message));
  }
  terminate() {
    if (this._pollTimer != null) clearInterval(this._pollTimer);
    workerInstances.delete(this.id);
    cottontail.workerTerminate(this.id);
  }
  addEventListener(name, handler) {
    return this._add(String(name), handler);
  }
  removeEventListener(name, handler) {
    const key = String(name);
    const handlers = this._listeners.get(key) ?? [];
    this._listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    return this;
  }
};

const pointerKeepalive = [];

export const FFIType = {
  void: "void",
  bool: "bool",
  u8: "u8",
  i8: "i8",
  u16: "u16",
  i16: "i16",
  int: "int",
  u32: "u32",
  i32: "i32",
  u64: "u64",
  i64: "i64",
  f32: "f32",
  f64: "f64",
  ptr: "ptr",
  pointer: "ptr",
  cstring: "cstring",
  function: "function",
};

export const suffix = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";

function normalizeType(type) {
  if (type === FFIType.pointer) return FFIType.ptr;
  if (type === "callback") return FFIType.function;
  const name = String(type ?? FFIType.void);
  if (name === "uint64_t" || name === "usize" || name === "size_t") return FFIType.u64;
  if (name === "int64_t" || name === "isize" || name === "ssize_t") return FFIType.i64;
  return name;
}

function normalizeLibraryPath(value) {
  if (value && typeof value === "object") {
    if (typeof value._bunFilePath === "string") value = value._bunFilePath;
    else if (typeof value.href === "string") value = value.href;
    else if (typeof value.name === "string") value = value.name;
  }
  const path = String(value);
  if (!path.startsWith("file:")) return path;
  const url = new URL(path);
  if (url.protocol !== "file:") return path;
  return decodeURIComponent(url.pathname);
}

function toNumber(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  if (value && typeof value.ptr === "number") return value.ptr;
  return Number(value || 0);
}

export function ptr(value) {
  if (value == null) return 0;
  if (value instanceof JSCallback) return value.ptr;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    pointerKeepalive.push(value);
    if (pointerKeepalive.length > 4096) pointerKeepalive.splice(0, 1024);
  }
  return toNumber(cottontail.memoryAddress(value));
}

export function toArrayBuffer(pointer, offset = 0, length = 0) {
  return cottontail.memoryView(pointer, offset, length);
}

export function toBuffer(pointer, offset = 0, length = 0) {
  return globalThis.Buffer.from(new Uint8Array(toArrayBuffer(pointer, offset, length)));
}

function dataView(pointer, byteLength, offset = 0) {
  return new DataView(toArrayBuffer(pointer, offset, byteLength));
}

export const read = {
  u8(pointer, offset = 0) { return dataView(pointer, 1, offset).getUint8(0); },
  i8(pointer, offset = 0) { return dataView(pointer, 1, offset).getInt8(0); },
  u16(pointer, offset = 0) { return dataView(pointer, 2, offset).getUint16(0, true); },
  i16(pointer, offset = 0) { return dataView(pointer, 2, offset).getInt16(0, true); },
  u32(pointer, offset = 0) { return dataView(pointer, 4, offset).getUint32(0, true); },
  i32(pointer, offset = 0) { return dataView(pointer, 4, offset).getInt32(0, true); },
  u64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigUint64(0, true); },
  i64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigInt64(0, true); },
  ptr(pointer, offset = 0) {
    const view = dataView(pointer, 8, offset);
    return Number(view.getBigUint64(0, true));
  },
  intptr(pointer, offset = 0) {
    const view = dataView(pointer, 8, offset);
    return Number(view.getBigInt64(0, true));
  },
  f32(pointer, offset = 0) { return dataView(pointer, 4, offset).getFloat32(0, true); },
  f64(pointer, offset = 0) { return dataView(pointer, 8, offset).getFloat64(0, true); },
  cstring(pointer, offset = 0) { return new CString(toNumber(pointer) + Number(offset)); },
};

function readCString(pointer) {
  if (typeof pointer === "string") return pointer;
  const address = toNumber(pointer);
  if (!address) return "";
  const chunks = [];
  const maxLength = 8 * 1024 * 1024;
  const chunkSize = 64 * 1024;
  let totalLength = 0;
  for (let offset = 0; offset < maxLength; offset += chunkSize) {
    const view = new Uint8Array(cottontail.memoryView(address, offset, Math.min(chunkSize, maxLength - offset)));
    const nulIndex = view.indexOf(0);
    if (nulIndex >= 0) {
      chunks.push(view.slice(0, nulIndex));
      totalLength += nulIndex;
      break;
    }
    chunks.push(view.slice());
    totalLength += view.length;
  }
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return stringFromBytes(bytes);
}

// Callable with or without `new` (bun semantics, issue #25231): without
// `new` it returns the decoded primitive string. Optional byteOffset and
// byteLength narrow the read window; without byteLength the string is read
// up to the first NUL byte.
export function CString(value, byteOffset = undefined, byteLength = undefined) {
  if (!new.target) {
    return String(new CString(value, byteOffset, byteLength));
  }
  if (typeof value === "string") {
    this.text = value;
    this.buffer = bytesFromString(`${value}\0`);
    this.ptr = ptr(this.buffer);
    return;
  }
  const offset = Number(byteOffset ?? 0) || 0;
  const address = toNumber(value) + offset;
  this.ptr = toNumber(value);
  this.byteOffset = offset;
  if (byteLength === undefined || byteLength === null) {
    this.text = readCString(address);
  } else {
    const length = Number(byteLength) || 0;
    this.byteLength = length;
    const view = new Uint8Array(cottontail.memoryView(address, 0, length));
    this.text = stringFromBytes(view.slice());
  }
}
CString.prototype.toString = function toString() {
  return this.text;
};
Object.defineProperty(CString.prototype, "length", {
  configurable: true,
  get() {
    return this.text.length;
  },
});

export class JSCallback {
  constructor(fn, options = {}) {
    this.fn = fn;
    this.options = options;
    this.args = (options.args || []).map(normalizeType);
    this.returns = normalizeType(options.returns || FFIType.void);
    this.threadsafe = Boolean(options.threadsafe);
    this.ptr = cottontail.createCallback(fn, this.args, this.returns, this.threadsafe);
  }
  close() {
    if (this.ptr) {
      cottontail.closeCallback?.(this.ptr);
      this.ptr = 0;
    }
  }
}

function nativeArg(value, type) {
  if (type === FFIType.function && value instanceof JSCallback) return value.ptr;
  if (value instanceof JSCallback) return value.ptr;
  if (value instanceof CString) return value.ptr;
  if (typeof value === "string" && type === FFIType.cstring) return new CString(value).ptr;
  return value;
}

function returnForType(type, value) {
  switch (normalizeType(type)) {
    case FFIType.void:
      return undefined;
    case FFIType.bool:
      return Boolean(value);
    case FFIType.cstring:
      return value ? new CString(value) : null;
    case "napi_value":
      return value;
    case FFIType.u64:
    case FFIType.i64:
      return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value || 0)));
    default:
      return value == null ? 0 : Number(value);
  }
}

export function dlopen(path, symbols) {
  const libraryPath = normalizeLibraryPath(path);
  const wrapped = {};
  for (const [name, spec] of Object.entries(symbols || {})) {
    const argTypes = (spec.args || []).map(normalizeType);
    const returns = normalizeType(spec.returns || FFIType.void);
    wrapped[name] = (...args) => {
      const nativeArgs = args.map((arg, index) => nativeArg(arg, argTypes[index] || FFIType.ptr));
      const result = cottontail.nativeCall(libraryPath, name, returns, argTypes, nativeArgs);
      return returnForType(returns, result);
    };
    try {
      wrapped[name].ptr = cottontail.nativeSymbol(libraryPath, name);
    } catch (error) {
      const detail = String(error?.message ?? error);
      if (/dlopen|failed to open|cannot open|no such file/i.test(detail)) {
        throw new Error(`Failed to open library "${libraryPath}": ${detail}`);
      }
      throw new Error(`Symbol "${name}" not found in library "${libraryPath}": ${detail}`);
    }
    wrapped[name].native = true;
  }
  return { symbols: wrapped, close() {} };
}

export class CFunction {
  constructor(pointerOrSpec, options = {}) {
    const spec = pointerOrSpec && typeof pointerOrSpec === "object" && !(pointerOrSpec instanceof ArrayBuffer) && !ArrayBuffer.isView(pointerOrSpec)
      ? pointerOrSpec
      : { ptr: pointerOrSpec, ...options };
    const pointerValue = ptr(spec.ptr ?? spec.pointer);
    const argTypes = (spec.args || []).map(normalizeType);
    const returns = normalizeType(spec.returns || FFIType.void);
    const callable = (...args) => {
      const nativeArgs = args.map((arg, index) => nativeArg(arg, argTypes[index] || FFIType.ptr));
      return returnForType(returns, cottontail.nativeCallPointer(pointerValue, returns, argTypes, nativeArgs));
    };
    Object.setPrototypeOf(callable, new.target.prototype);
    callable.ptr = pointerValue;
    callable.options = spec;
    callable.args = argTypes;
    callable.returns = returns;
    callable.native = true;
    return callable;
  }
}

export function linkSymbols(symbols = {}) {
  const wrapped = {};
  for (const [name, spec] of Object.entries(symbols)) {
    if (!spec || (typeof spec.ptr !== "number" && typeof spec.ptr !== "bigint") || Number(spec.ptr) === 0) {
      throw new TypeError(`${name}: you must provide a "ptr" field with the memory address of the native function. This is required by linkSymbols() and CFunction.`);
    }
    wrapped[name] = new CFunction(spec);
  }
  return { symbols: wrapped, close() {} };
}

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function tmpRoot() {
  const env = globalThis.process?.env ?? cottontail.env();
  const base = String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp");
  const dir = pathJoin(base, "cottontail", "bun-ffi-cc");
  cottontail.mkdirSync(dir, true);
  return dir;
}

function compilerCommand() {
  const env = globalThis.process?.env ?? cottontail.env();
  if (env.CC) return { file: env.CC, prefix: [] };
  const zig = pathJoin(cottontail.cwd(), "vendors", "zig", "zig");
  if (cottontail.existsSync(zig)) return { file: zig, prefix: ["cc"] };
  return { file: "cc", prefix: [] };
}

function sourcePathForCc(source) {
  const text = String(source ?? "");
  if (cottontail.existsSync(text)) return text;
  const path = pathJoin(tmpRoot(), `source-${Date.now()}-${Math.floor(Math.random() * 1000000)}.c`);
  cottontail.writeFile(path, text);
  return path;
}

export function cc(options = {}) {
  const source = options.source ?? options.file ?? options.path;
  const symbols = options.symbols ?? options.exports;
  if (source == null) throw new TypeError('Bun.cc requires a "source" file path or source string');
  if (symbols == null || typeof symbols !== "object") throw new TypeError('Bun.cc requires a "symbols" object');

  const dir = tmpRoot();
  const output = pathJoin(dir, `libcc-${Date.now()}-${Math.floor(Math.random() * 1000000)}.${suffix}`);
  const sourcePath = sourcePathForCc(source);
  const compiler = compilerCommand();
  const platformName = platform();
  const sharedArgs = platformName === "darwin"
    ? ["-dynamiclib", "-undefined", "dynamic_lookup"]
    : platformName === "win32"
      ? ["-shared"]
      : ["-shared", "-fPIC"];
  const defines = Object.entries(options.define || {}).map(([name, value]) => `-D${name}=${value == null ? "1" : String(value)}`);
  const args = [...compiler.prefix, sourcePath, ...sharedArgs, ...defines, "-o", output, ...(options.flags || []), ...(options.args || [])].map(String);
  const result = cottontail.spawnSync(compiler.file, args, { stdio: "pipe" });
  if (Number(result.status ?? 0) !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Bun.cc failed with status ${result.status}`));
  }
  try {
    return dlopen(output, symbols);
  } catch (error) {
    const message = String(error?.message ?? error);
    const missing = /Symbol "([^"]+)" not found/.exec(message);
    if (missing) throw new Error(`Symbol "${missing[1]}" is missing from the compiled library`);
    throw error;
  }
}

export const native = {
  dlopen,
  callback: JSCallback,
};

export function viewSource(value) {
  return String(value);
}

export default {
  CFunction,
  CString,
  FFIType,
  JSCallback,
  cc,
  dlopen,
  linkSymbols,
  native,
  ptr,
  read,
  suffix,
  toArrayBuffer,
  toBuffer,
  viewSource,
};
