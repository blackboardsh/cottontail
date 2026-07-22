import "./encoding.js";
import { createReadableStdio, createWritableStdio } from "../node/stdio.js";
import {
  adoptBunSpawnIpcHandle,
  decodeBunSpawnIpc,
  encodeBunSpawnIpc,
  installInheritedBunIpcCodec,
  installInheritedNodeIpc,
} from "../internal/bun-spawn-ipc.js";

const g = globalThis;
const processStartMs = Date.now();
const hotReloadHooks = g.__cottontailHotReloadHooks ?? new Set();
if (g.__cottontailHotReloadHooks == null) {
  Object.defineProperty(g, "__cottontailHotReloadHooks", { value: hotReloadHooks, configurable: true });
}
Object.defineProperty(g, "__cottontailPrepareHotReload", { configurable: true, value: () => {
  const hooks = [...hotReloadHooks];
  hotReloadHooks.clear();
  for (const hook of hooks) {
    try { hook(); } catch (error) { console.error(error); }
  }
  g.process?.__cottontailListeners?.clear?.();
  if (g.process) g.process.exitCode = 0;
  g.__ctUnhandledRejection = undefined;
  g.__ctError = undefined;
  g.__ctErrorSet = false;
} });

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
const currentRuntimeRequire = () => g.__ctMetaRequire ?? g.require;
const lazyImportMetaRequire = new Proxy(function importMetaRequire(...args) {
  const runtimeRequire = currentRuntimeRequire();
  if (typeof runtimeRequire !== "function") throw new TypeError("import.meta.require is unavailable");
  return Reflect.apply(runtimeRequire, this, args);
}, {
  get(target, property) {
    const runtimeRequire = currentRuntimeRequire();
    return Reflect.get(typeof runtimeRequire === "function" ? runtimeRequire : target, property);
  },
});
const hydrateImportMetaRequire = (meta) => {
  if (!meta || typeof meta !== "object" || typeof meta.require === "function") return meta;
  const runtimeRequire = g.__ctMetaRequire;
  try {
    Object.defineProperty(meta, "require", {
      value: typeof runtimeRequire === "function" ? runtimeRequire : lazyImportMetaRequire,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {}
  return meta;
};

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
    hydrateImportMetaRequire(meta);
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
      return fixImportMeta(currentImportMeta ??= {});
    },
    set(value) {
      currentImportMeta = value;
    },
  });
}

let runtimeImportMeta = g.__cottontailImportMeta;
if (!runtimeImportMeta || typeof runtimeImportMeta !== "object") {
  runtimeImportMeta = {};
  try {
    g.__cottontailImportMeta = runtimeImportMeta;
    runtimeImportMeta = g.__cottontailImportMeta ?? runtimeImportMeta;
  } catch {}
}
hydrateImportMetaRequire(runtimeImportMeta);

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
    value: (options = undefined) => {
      exposedGc?.();
      const result = cottontail.gc(true);
      globalThis.__cottontailAsyncHooksOnGc?.();
      if (options && typeof options === "object" && options.execution === "async") return Promise.resolve(result);
      return result;
    },
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
if (Number.isInteger(nativeIpcFd) && nativeIpcFd >= 0 &&
    g.process.env?.COTTONTAIL_IPC_BOOTSTRAP !== "node" &&
    typeof cottontail.ipcSend === "function" &&
    typeof g.process.send !== "function") {
  g.process.connected = true;
  g.process.send = (message) => {
    if (!g.process.connected) return false;
    return cottontail.ipcSend(nativeIpcFd, encodeBunSpawnIpc(message)) === true;
  };
  g.process.disconnect = () => {
    if (!g.process.connected) {
      const error = new Error("IPC channel is already disconnected");
      error.code = "ERR_IPC_DISCONNECTED";
      throw error;
    }
    g.process.connected = false;
    try { cottontail.closeFd?.(nativeIpcFd); } catch {}
    queueMicrotask(() => g.process.emit("disconnect"));
  };

  if (typeof cottontail.ipcRecv === "function") {
    installNativeProcessIpcReader = () => {
      let ipcBuffer = "";
      let ipcPendingFd;
      const ipcDecoder = new TextDecoder();
      const pollIpc = () => {
        if (!g.process.connected) return 0;
        let messageCount = 0;
        try {
          for (;;) {
            const event = cottontail.ipcRecv(nativeIpcFd, 64 * 1024);
            if (!event) break;
            if (event.end) {
              if (Number.isInteger(event.fd) && event.fd >= 0) {
                try { cottontail.closeFd?.(event.fd); } catch {}
              }
              if (Number.isInteger(ipcPendingFd) && ipcPendingFd >= 0) {
                try { cottontail.closeFd?.(ipcPendingFd); } catch {}
                ipcPendingFd = undefined;
              }
              g.process.disconnect();
              return;
            }
            if (Number.isInteger(event.fd) && event.fd >= 0) {
              if (Number.isInteger(ipcPendingFd) && ipcPendingFd >= 0) {
                try { cottontail.closeFd?.(ipcPendingFd); } catch {}
              }
              ipcPendingFd = Number(event.fd);
            }
            ipcBuffer += ipcDecoder.decode(event.data ?? new ArrayBuffer(0), { stream: true });
            for (;;) {
              const newlineIndex = ipcBuffer.indexOf("\n");
              if (newlineIndex < 0) break;
              const line = ipcBuffer.slice(0, newlineIndex).replace(/\r$/, "");
              ipcBuffer = ipcBuffer.slice(newlineIndex + 1);
              const frameFd = ipcPendingFd;
              ipcPendingFd = undefined;
              if (!line.startsWith(ipcPrefix)) {
                if (Number.isInteger(frameFd) && frameFd >= 0) {
                  try { cottontail.closeFd?.(frameFd); } catch {}
                }
                continue;
              }
              messageCount += 1;
              g.process.emit("message", decodeBunSpawnIpc(line), adoptBunSpawnIpcHandle(cottontail, frameFd));
            }
          }
        } catch (error) {
          g.process.emit("error", error);
        }
        return messageCount;
      };
      g.__cottontailPollProcessIpc = pollIpc;
      const ipcTimer = g.setInterval(pollIpc, 1);
      ipcTimer.unref?.();
    };
  }
} else if (g.process.env?.COTTONTAIL_IPC_STDIO === "1" &&
    g.process.env?.COTTONTAIL_IPC_BOOTSTRAP === "bun" &&
    typeof g.process.send !== "function") {
  g.process.connected = true;
  g.process.send = (message) => {
    if (!g.process.connected) return false;
    return g.process.stdout.write(encodeBunSpawnIpc(message));
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
        g.process.emit("message", decodeBunSpawnIpc(line));
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

const commonJsExportsMarker = Symbol.for("cottontail.commonjsExports");

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

const formatConsoleErrorProperties = (error, seen, objectDepth, indent, options) => {
  const keys = Reflect.ownKeys(error).filter((key) => {
    if (key === "name" || key === "message" || key === "stack") return false;
    return Object.getOwnPropertyDescriptor(error, key)?.enumerable === true;
  });
  if (keys.length === 0) return "";
  const alreadySeen = seen.has(error);
  if (!alreadySeen) seen.add(error);
  try {
    const pad = " ".repeat(indent + 2);
    let out = " {\n";
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
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
    if (!alreadySeen) seen.delete(error);
  }
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

  const jsxMarker = Object.getOwnPropertyDescriptor(value, "$$typeof")?.value;
  if (
    (jsxMarker === Symbol.for("react.element") ||
      jsxMarker === Symbol.for("react.transitional.element") ||
      jsxMarker === Symbol.for("react.fragment")) &&
    typeof g.Bun?.inspect === "function"
  ) {
    return g.Bun.inspect(value, { colors: false });
  }

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
    let name = "Error";
    let message = "";
    let stack = "";
    try {
      if (value.name != null) name = String(value.name);
    } catch {}
    try {
      if (value.message != null) message = String(value.message);
    } catch {}
    try {
      const candidate = value.stack;
      if (typeof candidate === "string" && candidate.length > 0) stack = candidate;
    } catch {}
    const header = message ? `${name}: ${message}` : name;
    const rendered = !stack ? header : stack.startsWith(name) ? stack : `${header}\n${stack.replace(/^/gm, "      ")}`;
    return `${rendered}${formatConsoleErrorProperties(value, seen, objectDepth, indent, options)}`;
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
    const tag = consoleOwnValue(value, Symbol.toStringTag);
    if (typeof tag === "string") {
      if (tag !== "Object") prefix = `${tag} `;
    } else if (prototype === null) prefix = "[Object: null prototype] ";
    else {
      const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
      const name = constructor?.name;
      if (name && name !== "Object") prefix = `${name} `;
    }
    const showCommonJsDescriptors = consoleOwnValue(value, commonJsExportsMarker) === true;
    const keys = Reflect.ownKeys(value).filter((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable === true || (showCommonJsDescriptors && typeof key === "string");
    });
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
        if (tag === "Module" && typeof descriptor.get === "function") {
          try {
            rendered = formatConsoleValue(Reflect.get(value, key), seen, objectDepth + 1, indent + 2, options);
          } catch {
            rendered = descriptor.set ? "[Getter/Setter]" : "[Getter]";
          }
        } else {
          rendered = descriptor.get && descriptor.set ? "[Getter/Setter]" : descriptor.get ? "[Getter]" : "[Setter]";
        }
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
    ? Math.max(0, line.lastIndexOf("Error("))
    : Math.max(0, line.indexOf("new "));
  return { filename, lines, lineIndex: index, column: columnIndex + 1, plainError };
};

const formatConsoleError = (error, level, separate = true) => {
  const source = consoleErrorSource(error);
  if (!source) return undefined;
  const name = String(error.name ?? "Error");
  const message = String(error.message ?? "");
  const lineNumber = source.lineIndex + 1;
  const stack = `      at ${source.filename}:${lineNumber}:${source.column}\n      at loadAndEvaluateModule (2:1)`;
  const properties = formatConsoleErrorProperties(
    error,
    new Set(),
    0,
    0,
    { depth: consoleDepth, customInspect: true },
  );
  if (level === "warn") {
    const heading = source.plainError ? `warn: ${message}` : `${name}: ${message}`;
    return `${consoleGroupIndent}${heading}\n${stack}${properties}\n`;
  }

  const firstLine = Math.max(0, source.lineIndex - 5);
  const excerpt = [];
  for (let index = firstLine; index <= source.lineIndex; index += 1) {
    const prefix = index === firstLine ? consoleGroupIndent : "";
    excerpt.push(`${prefix}${index + 1} | ${source.lines[index]}`);
  }
  excerpt.push(" ".repeat(String(lineNumber).length + 3 + source.column - 1) + "^");
  excerpt.push(`${source.plainError ? "error" : name}: ${message}`);
  excerpt.push(`${stack}${properties}`);
  if (separate) excerpt.push("");
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
const writeConsole = (writer, args, substitutions = true, options = undefined, level = undefined, separateError = true) => {
  let isError = false;
  if (args.length === 1 && level) {
    try { isError = args[0] instanceof Error; } catch {}
  }
  if (isError) {
    const renderedError = formatConsoleError(args[0], level, separateError);
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
Object.defineProperty(console, Symbol.for("cottontail.reportError.console"), {
  value: error => writeConsole(nativeConsoleError, [error], true, undefined, "error", false),
  configurable: true,
});
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

const blobStreamSources = g.__cottontailBlobStreamSources ?? new WeakMap();
if (g.__cottontailBlobStreamSources == null) {
  Object.defineProperty(g, "__cottontailBlobStreamSources", {
    value: blobStreamSources,
    configurable: true,
  });
}

function normalizeBlobType(type = "") {
  const source = String(type);
  if (/[^\x20-\x7e]/.test(source)) return "";
  return canonicalUtf8BlobTypes.has(source) ? `${source};charset=utf-8` : source.toLowerCase();
}

function snapshotBlobPart(part, snapshots) {
  if (part == null) return [new Uint8Array(0)];
  if (typeof part === "symbol") throw new TypeError("Cannot convert a symbol to a string");
  if (Array.isArray(part?._blobChunks)) return part._blobChunks;
  if (typeof part === "string") return [bytesFromString(part)];
  if (part instanceof ArrayBuffer) {
    let snapshot = snapshots.get(part);
    if (!snapshot) {
      snapshot = new Uint8Array(part).slice();
      snapshots.set(part, snapshot);
    }
    return [snapshot];
  }
  if (ArrayBuffer.isView(part)) {
    const backing = part.buffer;
    let snapshot = snapshots.get(backing);
    if (!snapshot) {
      snapshot = new Uint8Array(backing).slice();
      snapshots.set(backing, snapshot);
    }
    return [snapshot.subarray(part.byteOffset, part.byteOffset + part.byteLength)];
  }
  if (part?._bytes instanceof Uint8Array) return [part._bytes.slice()];
  return [bytesFromString(String(part))];
}

function concatBlobChunks(chunks, size) {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function exceedsSyntheticBlobAllocationLimit(size) {
  const limit = Number(g.__cottontailSyntheticAllocationLimit);
  return Number.isFinite(limit) && limit > 0 && size > limit;
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
        // COTTONTAIL-COMPAT: Blob snapshots each backing store once and keeps
        // repeated parts shared until a contiguous representation is requested.
        const snapshots = new WeakMap();
        this._blobChunks = [];
        this._size = 0;
        for (const part of sourceParts) {
          for (const chunk of snapshotBlobPart(part, snapshots)) {
            this._blobChunks.push(chunk);
            this._size += chunk.byteLength;
          }
        }
        this._bytes = null;
        this.type = normalizeBlobType(options?.type);
      }

      get size() {
        return this._size;
      }

      _getBytes() {
        return concatBlobChunks(this._blobChunks, this._size);
      }

      async arrayBuffer() {
        return this._getBytes().buffer;
      }

      async bytes() {
        if (exceedsSyntheticBlobAllocationLimit(this._size)) throw new Error("Out of memory");
        return this._getBytes();
      }

      async text() {
        if (exceedsSyntheticBlobAllocationLimit(this._size)) {
          throw new RangeError("Cannot create a string longer than 2^32-1 characters");
        }
        return stringFromBytes(this._getBytes());
      }

      async json() {
        if (exceedsSyntheticBlobAllocationLimit(this._size)) {
          throw new RangeError("Cannot parse a JSON string longer than 2^32-1 characters");
        }
        return JSON.parse(await this.text());
      }

      slice(start = 0, end = this.size, type = "") {
        const relativeStart = relativeBlobIndex(start, this.size, 0);
        const relativeEnd = relativeBlobIndex(end, this.size, this.size);
        const rangeEnd = Math.max(relativeStart, relativeEnd);
        const parts = [];
        let offset = 0;
        for (const chunk of this._blobChunks) {
          const chunkEnd = offset + chunk.byteLength;
          const partStart = Math.max(relativeStart, offset);
          const partEnd = Math.min(rangeEnd, chunkEnd);
          if (partEnd > partStart) parts.push(chunk.subarray(partStart - offset, partEnd - offset));
          offset = chunkEnd;
          if (offset >= rangeEnd) break;
        }
        return new g.Blob(parts, { type });
      }

      stream() {
        const bytes = this._getBytes();
        if (typeof g.ReadableStream === "function") {
          const stream = new g.ReadableStream({
            start(controller) {
              // An empty blob closes without enqueuing an empty chunk.
              if (bytes.byteLength > 0) controller.enqueue(bytes);
              controller.close();
            },
          });
          blobStreamSources.set(stream, { bytes, type: this.type });
          return stream;
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

function fillBufferPattern(target, pattern, start, stop) {
  const length = stop - start;
  if (length <= 0) return target;
  if (pattern.length === 0) {
    Uint8Array.prototype.fill.call(target, 0, start, stop);
    return target;
  }
  if (pattern.length === 1) {
    Uint8Array.prototype.fill.call(target, pattern[0], start, stop);
    return target;
  }

  let filled = Math.min(pattern.length, length);
  Uint8Array.prototype.set.call(
    target,
    Uint8Array.prototype.subarray.call(pattern, 0, filled),
    start,
  );
  while (filled < length) {
    const copyLength = Math.min(filled, length - filled);
    Uint8Array.prototype.set.call(
      target,
      Uint8Array.prototype.subarray.call(target, start, start + copyLength),
      start + filled,
    );
    filled += copyLength;
  }
  return target;
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
    return fillBufferPattern(this, pattern, start, stop);
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
    fillBufferPattern(bytes, fillBytes, 0, bytes.length);
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
if (g.Buffer !== CottontailBuffer && typeof g.Buffer.from === "function" && !g.Buffer.from.__cottontailHexPatched) {
  const existingBufferFrom = g.Buffer.from.bind(g.Buffer);
  const patchedBufferFrom = function from(value, encodingOrOffset, length) {
    if (typeof value === "string" && typeof encodingOrOffset === "string" && encodingOrOffset.toLowerCase() === "hex") {
      return existingBufferFrom(hexDecode(value));
    }
    return existingBufferFrom(value, encodingOrOffset, length);
  };
  patchedBufferFrom.__cottontailHexPatched = true;
  g.Buffer.from = patchedBufferFrom;
}
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
    [consoleInspectCustom]: () => `Timeout (#${id}${timers.get(id)?.interval != null ? ", repeats" : ""})`,
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
  g.requestAnimationFrame ??= (callback) => {
    if (typeof callback !== "function") throw new TypeError('The "callback" argument must be of type function');
    return g.setTimeout(() => callback(timerNow()), 16);
  };
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
installInheritedBunIpcCodec(cottontail, g.process);
installInheritedNodeIpc(cottontail, g.process);
installNativeProcessIpcReader?.();

const spawnEventListeners = new Map();
let spawnEventHandlerInstalled = false;

function installSpawnEventHandler() {
  if (spawnEventHandlerInstalled) return;
  spawnEventHandlerInstalled = true;
  cottontail.spawnSetEventHandler?.((event) => {
    const entry = spawnEventListeners.get(Number(event?.id));
    if (typeof entry?.listener === "function") {
      entry.listener(event);
    } else if (Number.isInteger(event?.fd) && event.fd >= 0) {
      // Native IPC descriptor ownership transfers with the event. If its
      // process listener has already gone away, close it here.
      try { cottontail.closeFd?.(event.fd); } catch {}
    }
  });
}

g.__cottontailRegisterSpawnListener = (id, listener) => {
  installSpawnEventHandler();
  const key = Number(id);
  const wrappedListener = g.__cottontailWrapAsyncCallback?.(listener) ?? listener;
  const entry = { listener: wrappedListener, ref: true };
  spawnEventListeners.set(key, entry);
  const unregister = () => {
    if (spawnEventListeners.get(key) === entry) {
      spawnEventListeners.delete(key);
    }
  };
  unregister.ref = () => {
    entry.ref = true;
    cottontail.spawnSetReferenced?.(key, true);
  };
  unregister.unref = () => {
    entry.ref = false;
    cottontail.spawnSetReferenced?.(key, false);
  };
  return unregister;
};

const workerMessageListeners = new Map();
const workerTransportListenerBrand = Symbol.for("cottontail.worker_threads.transportListener");
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
  return (workerMessageListeners.get("message") ?? []).some((listener) => !listener?.[workerTransportListenerBrand]);
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

const workerWireViewConstructors = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
};

function decodeWorkerWireValue(encoded, refs = new Map()) {
  const remember = value => {
    if (encoded?.id != null) refs.set(encoded.id, value);
    return value;
  };
  switch (encoded?.t) {
    case "Ref": return refs.get(encoded.id);
    case "undefined": return undefined;
    case "null": return null;
    case "boolean":
    case "string": return encoded.v;
    case "number":
      if (encoded.v === "NaN") return NaN;
      if (encoded.v === "Infinity") return Infinity;
      if (encoded.v === "-Infinity") return -Infinity;
      if (encoded.v === "-0") return -0;
      return Number(encoded.v);
    case "bigint": return BigInt(encoded.v);
    case "Date": return remember(new Date(Number(encoded.v)));
    case "RegExp": return remember(new RegExp(encoded.source, encoded.flags));
    case "ArrayBuffer": return remember(new Uint8Array(encoded.bytes ?? []).buffer);
    case "View": {
      const bytes = new Uint8Array(encoded.bytes ?? []);
      if (encoded.name === "Buffer" && typeof g.Buffer === "function") return remember(g.Buffer.from(bytes));
      if (encoded.name === "DataView") return remember(new DataView(bytes.buffer));
      const Constructor = workerWireViewConstructors[encoded.name] ?? Uint8Array;
      return remember(new Constructor(bytes.buffer));
    }
    case "Map": {
      const map = remember(new Map());
      for (const [key, value] of encoded.v ?? []) {
        map.set(decodeWorkerWireValue(key, refs), decodeWorkerWireValue(value, refs));
      }
      return map;
    }
    case "Set": {
      const set = remember(new Set());
      for (const value of encoded.v ?? []) set.add(decodeWorkerWireValue(value, refs));
      return set;
    }
    case "Array": {
      const array = remember([]);
      for (let index = 0; index < (encoded.v ?? []).length; index += 1) {
        array[index] = decodeWorkerWireValue(encoded.v[index], refs);
      }
      if (encoded.length != null) array.length = encoded.length;
      return array;
    }
    case "Error": {
      const error = remember(new Error(encoded.message));
      if (encoded.name) error.name = encoded.name;
      if (encoded.stack) error.stack = encoded.stack;
      return error;
    }
    case "Blob": return remember(new g.Blob([new Uint8Array(encoded.bytes ?? [])], { type: encoded.type ?? "" }));
    case "File": return remember(new g.File([new Uint8Array(encoded.bytes ?? [])], encoded.name ?? "", {
      type: encoded.type ?? "",
      lastModified: encoded.lastModified,
    }));
    case "Object": {
      const object = remember({});
      for (const [key, value] of encoded.v ?? []) object[key] = decodeWorkerWireValue(value, refs);
      return object;
    }
    default: return undefined;
  }
}

function decodeIncomingWorkerMessage(data, worker) {
  if (typeof g.__cottontailWebDecodeIncoming === "function") {
    return g.__cottontailWebDecodeIncoming(data, worker);
  }
  if (data?.__cottontailWebWire === 1) return decodeWorkerWireValue(data.data);
  return data;
}

function installWorkerGlobal() {
  if (!cottontail.isWorker?.()) {
    // Bun exposes postMessage on the main global for Web-compatible shape,
    // but without a parent worker target the operation is intentionally inert.
    g.postMessage ??= function postMessage() {};
    return;
  }
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
    data = decodeIncomingWorkerMessage(data, null);
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
      const code = Number(event?.code ?? 0) || 0;
      worker._refed = false;
      worker._terminated = true;
      worker.threadId = -1;
      workerInstances.delete(worker.id);
      if (worker._pollTimer != null) clearInterval(worker._pollTimer);
      worker._emit("exit", { type: "exit", code, target: worker });
      worker._emit("close", { type: "close", code, target: worker });
      return;
    }
    if (event?.type === "error") {
      const message = String(event?.message ?? "Worker execution failed");
      worker._emit("error", {
        type: "error",
        message,
        error: null,
        target: worker,
      });
      return;
    }
    if (event?.type === "resourceLimit") {
      const message = String(event?.message ?? "Worker terminated due to reaching memory limit");
      const error = new Error(message);
      error.code = "ERR_WORKER_OUT_OF_MEMORY";
      worker._emit("error", {
        type: "error",
        message,
        error,
        code: error.code,
        target: worker,
      });
      return;
    }
    if (event?.type === "open") {
      worker._emit("open", { type: "open", target: worker });
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
  }
  if (g.__cottontailWebHasActiveHandles?.()) return true;
  for (const worker of workerInstances.values()) {
    if (worker.hasRef()) return true;
  }
  for (const timer of timers.values()) {
    if (timer.ref !== false) return true;
  }
  for (const entry of spawnEventListeners.values()) {
    if (entry.ref !== false) return true;
  }
  return false;
};

g.__cottontailEventLoopHandleStats = () => ({
  workers: Array.from(workerInstances.values()).filter((worker) => worker.hasRef()).length,
  timers: Array.from(timers.values()).filter((timer) => timer.ref !== false).length,
  spawns: Array.from(spawnEventListeners.values()).filter((entry) => entry.ref !== false).length,
  web: Boolean(g.__cottontailWebHasActiveHandles?.()),
});

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

hotReloadHooks.add(() => {
  for (const timer of timers.values()) {
    timer.destroyed = true;
    if (timer.handle) timer.handle._entry = timer;
  }
  timers.clear();
  cancelledTimers.clear();
  spawnEventListeners.clear();
  workerMessageListeners.clear();
  for (const worker of [...workerInstances.values()]) {
    try { worker.terminate(); } catch {}
  }
  workerInstances.clear();
});

function normalizeWorkerScriptPath(scriptPath) {
  const text = String(scriptPath);
  if (text.startsWith("file:")) {
    try {
      return decodeURIComponent(new URL(text).pathname);
    } catch {
      throw new TypeError("Invalid file URL");
    }
  }
  return text;
}

function normalizeWorkerPreloads(options) {
  if (options?.preload == null) return [];
  const values = Array.isArray(options.preload) ? options.preload : [options.preload];
  return values.map(value => normalizeWorkerScriptPath(value));
}

function workerStringEnvironment(source) {
  const result = {};
  for (const key of Object.keys(source ?? {})) {
    if (source[key] !== undefined) result[key] = String(source[key]);
  }
  return result;
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
const workerRuntimePreludeCache = new Map();
const workerRuntimePreludeCacheMarker = "\n//# cottontail-worker-runtime-cache";
const workerRuntimePreludeDiskPaths = new Set();
let workerRuntimePreludeCleanupInstalled = false;
const preparedWorkerScript = Symbol.for("cottontail.worker.prepared-script");
const workerEvalSource = Symbol.for("cottontail.worker.eval-source");
const workerThreadName = Symbol.for("cottontail.worker.thread-name");
const workerStackSize = Symbol.for("cottontail.worker.stack-size");
const workerNativeOptions = Symbol.for("cottontail.worker.native-options");

function workerTempDir() {
  const configured = cottontail.env?.()?.COTTONTAIL_TMP_DIR;
  return configured ? `${configured}/workers` : `${cottontail.cwd()}/.cottontail-tmp`;
}

function workerRuntimePreludeDiskPath(tempDir, cwd) {
  const cacheId = String(g.__cottontailWorkerRuntimeCacheId ?? "")
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 128);
  if (!cacheId) return null;
  let cwdHash = 2166136261;
  for (let index = 0; index < cwd.length; index += 1) {
    cwdHash = Math.imul(cwdHash ^ cwd.charCodeAt(index), 16777619) >>> 0;
  }
  return `${tempDir}/bun-worker-runtime-cache-${cacheId}-${cwdHash.toString(16)}.js`;
}

function trackWorkerRuntimePreludeDiskPath(path) {
  if (path === null || cottontail.isWorker?.()) return;
  workerRuntimePreludeDiskPaths.add(path);
  if (workerRuntimePreludeCleanupInstalled) return;
  workerRuntimePreludeCleanupInstalled = true;
  processObject.once?.("exit", () => {
    for (const cachedPath of workerRuntimePreludeDiskPaths) {
      try { cottontail.unlinkSync?.(cachedPath); } catch {}
    }
    workerRuntimePreludeDiskPaths.clear();
  });
}

function loadWorkerRuntimePrelude(tempDir, cwd, runtimeEntry, nonce) {
  let runtimePrelude = workerRuntimePreludeCache.get(cwd);
  if (runtimePrelude !== undefined) return runtimePrelude;

  const diskPath = workerRuntimePreludeDiskPath(tempDir, cwd);
  trackWorkerRuntimePreludeDiskPath(diskPath);
  if (diskPath !== null) {
    try {
      const cached = String(cottontail.readFile(diskPath));
      if (cached.endsWith(workerRuntimePreludeCacheMarker)) runtimePrelude = cached;
    } catch {}
  }

  if (runtimePrelude === undefined) {
    const preludeEntry = `${tempDir}/bun-worker-runtime-${nonce}.mjs`;
    cottontail.writeFile(preludeEntry, `import ${JSON.stringify(runtimeEntry)};`);
    try {
      runtimePrelude = cottontail.bundleNative(preludeEntry, cottontail.cwd(), JSON.stringify({
        format: "esm",
        target: "bun",
        includeRuntimeModules: true,
        inlineImportMetaProperties: true,
      }));
    } finally {
      try { cottontail.unlinkSync?.(preludeEntry); } catch {}
    }
    runtimePrelude += workerRuntimePreludeCacheMarker;
    if (diskPath !== null) cottontail.writeFile(diskPath, runtimePrelude);
  }

  workerRuntimePreludeCache.set(cwd, runtimePrelude);
  return runtimePrelude;
}

function canUseBareWorkerScript(target, options, hasWorkerOptions) {
  if (options?.[preparedWorkerScript] === true || hasWorkerOptions) return false;
  if (typeof g.__cottontailWebDecodeIncoming === "function") return false;
  if (!/\.(?:c?js|mjs)$/i.test(String(target))) return false;
  let source;
  try {
    source = String(cottontail.readFile(target));
  } catch {
    return false;
  }
  return !/(?:^|\n)\s*(?:import|export)\b|import\.meta|\b(?:Bun|process|Buffer|require|fetch|setTimeout|setInterval|clearTimeout|clearInterval|queueMicrotask|structuredClone|MessageChannel|MessagePort|BroadcastChannel|Worker|URL|Blob|File|crypto|performance)\b/.test(source);
}

function prepareWorkerScriptPath(scriptPath, options = undefined) {
  const cacheKey = normalizeWorkerScriptPath(scriptPath);
  const preloads = normalizeWorkerPreloads(options);
  const hasWorkerOptions = preloads.length > 0 ||
    Object.prototype.hasOwnProperty.call(options ?? {}, "env") ||
    Object.prototype.hasOwnProperty.call(options ?? {}, "argv") ||
    Object.prototype.hasOwnProperty.call(options ?? {}, "execArgv");
  let target = cacheKey;
  const cached = hasWorkerOptions ? undefined : workerBundleCache.get(cacheKey);
  if (cached && cottontail.existsSync?.(cached)) return cached;
  const tempDir = workerTempDir();
  cottontail.mkdirSync?.(tempDir, true);
  const nonce = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  if (target.startsWith("data:")) {
    const comma = target.indexOf(",");
    if (comma < 0) throw new TypeError("Invalid worker data URL");
    const metadata = target.slice(5, comma);
    const payload = target.slice(comma + 1);
    const source = /;base64(?:;|$)/i.test(metadata)
      ? Buffer.from(payload, "base64").toString("utf8")
      : decodeURIComponent(payload);
    const dataPath = `${tempDir}/bun-worker-data-${nonce}.js`;
    cottontail.writeFile(dataPath, source);
    target = dataPath;
  }
  if (canUseBareWorkerScript(target, options, hasWorkerOptions)) {
    workerBundleCache.set(cacheKey, target);
    return target;
  }
  const wrapperPath = `${tempDir}/bun-worker-entry-${nonce}.mjs`;
  const bundledPath = `${tempDir}/bun-worker-${nonce}.js`;
  const slashCwd = String(cottontail.cwd()).replace(/\\/g, "/");
  const slashTarget = String(target).replace(/\\/g, "/");
  const runtimeEntry = `${slashCwd}/.cottontail-embedded-runtime/bun/index.js`;
  if (options?.[preparedWorkerScript] === true) {
    const runtimePrelude = loadWorkerRuntimePrelude(tempDir, slashCwd, runtimeEntry, nonce);
    const source = cottontail.readFile(target);
    cottontail.writeFile(bundledPath, `${runtimePrelude}\n${source}\n//# sourceURL=${slashTarget}`);
    return bundledPath;
  }
  try {
    const imports = [`import ${JSON.stringify(runtimeEntry)};`];
    if (hasWorkerOptions || !options?.[preparedWorkerScript]) {
      const parentArgv = Array.from(globalThis.process?.argv ?? [], String);
      const argv = [
        String(parentArgv[0] ?? globalThis.process?.execPath ?? "cottontail"),
        slashTarget,
        ...Array.from(options?.argv ?? [], String),
      ];
      const execArgv = options?.execArgv == null
        ? Array.from(globalThis.process?.execArgv ?? [], String)
        : Array.from(options.execArgv, String);
      const optionsPath = `${tempDir}/bun-worker-options-${nonce}.mjs`;
      const optionSource = [
        `const __ctWorkerArgv = ${JSON.stringify(argv)};`,
        `const __ctWorkerExecArgv = ${JSON.stringify(execArgv)};`,
        `if (globalThis.process) {`,
        `  globalThis.process.argv = __ctWorkerArgv;`,
        `  globalThis.process.execArgv = __ctWorkerExecArgv;`,
        `}`,
        `if (globalThis.Bun) globalThis.Bun.argv = __ctWorkerArgv;`,
      ];
      if (Object.prototype.hasOwnProperty.call(options ?? {}, "env")) {
        const environment = workerStringEnvironment(options?.env);
        optionSource.push(
          `if (globalThis.process) {`,
          `  const __ctWorkerEnv = globalThis.process.env ?? {};`,
          `  for (const __ctKey of Object.keys(__ctWorkerEnv)) delete __ctWorkerEnv[__ctKey];`,
          `  Object.assign(__ctWorkerEnv, ${JSON.stringify(environment)});`,
          `  globalThis.process.env = __ctWorkerEnv;`,
          `}`,
        );
      }
      cottontail.writeFile(optionsPath, optionSource.join("\n"));
      imports.push(`import ${JSON.stringify(optionsPath.replace(/\\/g, "/"))};`);
    }
    for (const preload of preloads) {
      imports.push(`import ${JSON.stringify(String(preload).replace(/\\/g, "/"))};`);
    }
    imports.push(`import ${JSON.stringify(slashTarget)};`);
    cottontail.writeFile(wrapperPath, [
      ...imports,
    ].join("\n"));
    const bundled = cottontail.bundleNative(wrapperPath, cottontail.cwd(), JSON.stringify({
      format: "esm",
      target: "bun",
      includeRuntimeModules: true,
      inlineImportMetaProperties: true,
    }));
    cottontail.writeFile(bundledPath, bundled);
    if (!hasWorkerOptions) workerBundleCache.set(cacheKey, bundledPath);
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
  if (transformed === source) {
    workerBundleCache.set(cacheKey, target);
    return target;
  }
  cottontail.writeFile(bundledPath, [
    "globalThis.Bun ??= { isMainThread: false };",
    "globalThis.Bun.isMainThread = false;",
    transformed,
    `\n//# sourceURL=${target}`,
  ].join("\n"));
  workerBundleCache.set(cacheKey, bundledPath);
  return bundledPath;
}

function blobWorkerExtension(blob) {
  const nameMatch = /\.(?:[cm]?[jt]sx?)$/i.exec(String(blob?.name ?? ""));
  if (nameMatch) return nameMatch[0].toLowerCase();
  return /typescript/i.test(String(blob?.type ?? "")) ? ".ts" : ".js";
}

function blobWorkerLoadError(url) {
  return String(url).startsWith("blob:nodedata:")
    ? "BuildMessage: Blob URL is missing"
    : `BuildMessage: ModuleNotFound resolving ${JSON.stringify(String(url))} (entry point)`;
}

function workerErrorEvent(worker, message) {
  if (typeof g.ErrorEvent === "function") {
    return new g.ErrorEvent("error", { message, error: null });
  }
  return { type: "error", message, error: null, target: worker };
}

g.Worker ??= class Worker {
  constructor(scriptPath, options = undefined) {
    this.scriptPath = normalizeWorkerScriptPath(scriptPath);
    this.handle = null;
    this.id = 0;
    this.threadId = 0;
    this.onmessage = null;
    this.onerror = null;
    this._listeners = new Map();
    this._refed = true;
    this._terminated = false;
    this._pendingMessages = [];

    if (this.scriptPath.startsWith("blob:")) {
      queueMicrotask(() => void this._startBlobWorker(this.scriptPath, options));
      this._queueProcessWorkerEvent(options);
      return;
    }
    this._startWorker(this.scriptPath, options);
    this._queueProcessWorkerEvent(options);
  }
  _queueProcessWorkerEvent(options) {
    if (options?.[preparedWorkerScript] === true) return;
    queueMicrotask(() => globalThis.process?.emit?.("worker", this));
  }
  _startWorker(scriptPath, options) {
    if (this._terminated) return;
    this.scriptPath = prepareWorkerScriptPath(scriptPath, options);
    const disposePreparedScript = options?.[preparedWorkerScript] === true;
    try {
      this.handle = cottontail.spawnWorker(
        this.scriptPath,
        options?.[workerEvalSource],
        options?.[workerThreadName],
        options?.[workerStackSize],
        options?.[workerNativeOptions],
      );
    } finally {
      if (disposePreparedScript) {
        try { cottontail.unlinkSync?.(this.scriptPath); } catch {}
      }
    }
    this.id = this.handle.id;
    this.threadId = this.id;
    if (typeof cottontail.workerHasRef === "function") {
      const nativeRef = Boolean(cottontail.workerHasRef(this.id));
      if (!this._refed) cottontail.workerSetRef?.(this.id, false);
      else this._refed = nativeRef;
    }
    workerInstances.set(this.id, this);
    this._pollTimer = installWorkerNativeEventHandler() ? null : setInterval(() => this._poll(), 16);
    for (const message of this._pendingMessages.splice(0)) {
      cottontail.workerPostMessageTo(this.id, message);
    }
  }
  async _startBlobWorker(url, options) {
    try {
      const blob = g.__cottontailObjectURLRegistry?.get(url);
      if (!blob) throw new Error(blobWorkerLoadError(url));
      const source = blob?._bytes instanceof Uint8Array
        ? stringFromBytes(blob._bytes)
        : String(await blob.text());
      if (this._terminated) return;
      const tempDir = workerTempDir();
      cottontail.mkdirSync?.(tempDir, true);
      const nonce = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
      const sourcePath = `${tempDir}/bun-worker-blob-${nonce}${blobWorkerExtension(blob)}`;
      cottontail.writeFile(sourcePath, source);
      this._startWorker(sourcePath, options);
    } catch (error) {
      if (this._terminated) return;
      this._terminated = true;
      this._refed = false;
      this._pendingMessages.length = 0;
      const message = error?.message ?? String(error);
      this._emit("error", workerErrorEvent(this, message));
    }
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
    if (!this.handle) return;
    for (const item of cottontail.workerPollMessages(this.id)) {
      let data = item;
      try {
        data = JSON.parse(item);
      } catch {}
      if (g.__cottontailWebInterceptWorkerMessage?.(data, this)) continue;
      data = decodeIncomingWorkerMessage(data, this);
      const event = g.__cottontailMakeMessageEvent?.("message", data) ?? { data };
      this._emit("message", event);
    }
  }
  _postSerialized(serialized) {
    if (this._terminated) return;
    if (!this.handle) {
      this._pendingMessages.push(serialized);
      return;
    }
    cottontail.workerPostMessageTo(this.id, serialized);
  }
  postMessage(message) {
    return this._postSerialized(serializeWorkerMessage(message));
  }
  terminate() {
    if (this._terminated) return;
    if (this._pollTimer != null) clearInterval(this._pollTimer);
    this._terminated = true;
    this._refed = false;
    this._pendingMessages.length = 0;
    if (this.handle) {
      cottontail.workerTerminate(this.id);
    }
  }
  ref() {
    this._refed = this.handle && typeof cottontail.workerSetRef === "function"
      ? Boolean(cottontail.workerSetRef(this.id, true))
      : true;
    if (this._refed) this._pollTimer?.ref?.();
    return this;
  }
  unref() {
    if (this.handle && typeof cottontail.workerSetRef === "function") {
      cottontail.workerSetRef(this.id, false);
    }
    this._refed = false;
    this._pollTimer?.unref?.();
    return this;
  }
  hasRef() {
    if (this.handle && typeof cottontail.workerHasRef === "function") {
      this._refed = Boolean(cottontail.workerHasRef(this.id));
    }
    return this._refed;
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
  0: 0,
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  10: 10,
  11: 11,
  12: 12,
  13: 13,
  14: 14,
  15: 15,
  16: 16,
  17: 17,
  bool: 11,
  c_int: 5,
  c_uint: 6,
  char: 0,
  "char*": 12,
  double: 9,
  f32: 10,
  f64: 9,
  float: 10,
  i16: 3,
  i32: 5,
  i64: 7,
  i8: 1,
  int: 5,
  int16_t: 3,
  int32_t: 5,
  int64_t: 7,
  int8_t: 1,
  isize: 7,
  u16: 4,
  u32: 6,
  u64: 8,
  u8: 2,
  uint16_t: 4,
  uint32_t: 6,
  uint64_t: 8,
  uint8_t: 2,
  usize: 8,
  "void*": 12,
  ptr: 12,
  pointer: 12,
  void: 13,
  cstring: 14,
  i64_fast: 15,
  u64_fast: 16,
  function: 17,
  callback: 17,
  fn: 17,
  napi_env: 18,
  napi_value: 19,
  buffer: 20,
};

export const suffix = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";

const ffiNativeTypes = [
  "i8",
  "i8",
  "u8",
  "i16",
  "u16",
  "i32",
  "u32",
  "i64",
  "u64",
  "f64",
  "f32",
  "bool",
  "ptr",
  "void",
  "cstring",
  "i64",
  "u64",
  "function",
  "napi_env",
  "napi_value",
  "ptr",
];

const ffiCTypeNames = [
  "char",
  "int8_t",
  "uint8_t",
  "int16_t",
  "uint16_t",
  "int32_t",
  "uint32_t",
  "int64_t",
  "uint64_t",
  "double",
  "float",
  "bool",
  "void *",
  "void",
  "char *",
  "int64_t",
  "uint64_t",
  "void *",
  "napi_env",
  "napi_value",
  "void *",
];

const ffiTypeAliases = {
  size_t: FFIType.usize,
  ssize_t: FFIType.isize,
};

const supportedFFITypes = Object.keys(FFIType).filter((name) => !/^\d+$/.test(name)).sort().join(", ");

function ffiTypeId(type, fallback = undefined) {
  if (type == null && fallback !== undefined) return fallback;
  if (typeof type === "number" && Number.isInteger(type) && type >= 0 && type < ffiNativeTypes.length) return type;
  if (typeof type === "string") {
    const value = Object.prototype.hasOwnProperty.call(FFIType, type) ? FFIType[type] : ffiTypeAliases[type];
    if (typeof value === "number") return value;
  }
  throw new TypeError(`Unsupported type ${String(type)}. Must be one of: ${supportedFFITypes}`);
}

function normalizeLibraryPath(value) {
  if (value && typeof value === "object") {
    if (value instanceof URL) value = value.href;
    else if (typeof value._bunFilePath === "string") value = value._bunFilePath;
    else if (typeof value.href === "string") value = value.href;
    else if (typeof value.name === "string") value = value.name;
  }
  if (typeof value !== "string") throw new TypeError("Expected string");
  const path = value;
  if (!path.startsWith("file:")) return path;
  const url = new URL(path);
  if (url.protocol !== "file:") return path;
  let pathname = decodeURIComponent(url.pathname);
  if (platform() === "win32" && /^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

function invalidPointer(message) {
  const error = new TypeError(message);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function isBufferSource(value) {
  return value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(value);
}

function keepPointerAlive(value) {
  pointerKeepalive.push(value);
  if (pointerKeepalive.length > 4096) pointerKeepalive.splice(0, 1024);
}

export function ptr(value, byteOffset) {
  if (!isBufferSource(value)) {
    throw invalidPointer(`Expected ArrayBufferView but received ${value == null ? "null" : Object.prototype.toString.call(value)}`);
  }
  if (value.byteLength === 0) {
    throw invalidPointer("ArrayBufferView must have a length > 0. A pointer to empty memory doesn't work");
  }
  let offset = 0;
  if (byteOffset !== undefined && byteOffset !== null) {
    if (typeof byteOffset !== "number" || !Number.isFinite(byteOffset)) {
      throw invalidPointer("Expected number for byteOffset");
    }
    offset = Math.trunc(byteOffset);
  }
  if (offset > value.byteLength) throw invalidPointer("byteOffset out of bounds");
  keepPointerAlive(value);
  const address = Number(cottontail.memoryAddress(value)) + offset;
  if (!Number.isFinite(address) || address <= 0) throw invalidPointer("Pointer must not be 0");
  return address;
}

function pointerNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalidPointer(value === 0
      ? "ptr cannot be zero, that would segfault Bun :("
      : "ptr must be a number.");
  }
  return value;
}

function pointerOffset(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidPointer("Expected number for byteOffset");
  return Math.trunc(value);
}

function pointerLength(value, explicit) {
  if (!explicit) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidPointer("length must be a number.");
  const length = Math.trunc(value);
  if (length <= 0) throw invalidPointer("length must be > 0. This usually means a bug in your code.");
  if (!Number.isSafeInteger(length)) {
    throw invalidPointer("length exceeds max addressable memory. This usually means a bug in your code.");
  }
  return length;
}

function memoryUntilNul(pointer, offset = 0) {
  const chunkSize = 4096;
  const maxLength = 8 * 1024 * 1024;
  for (let length = 0; length < maxLength; length += chunkSize) {
    const chunk = new Uint8Array(cottontail.memoryView(pointer, offset + length, Math.min(chunkSize, maxLength - length)));
    const nul = chunk.indexOf(0);
    if (nul >= 0) return length + nul;
  }
  throw new RangeError("CString exceeds the 8 MiB safety limit");
}

const pointerViewFinalizers = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(({ address, callback, context }) => {
      try {
        cottontail.nativeCallPointer(callback, "void", ["ptr", "ptr"], [address, context]);
      } catch {}
    })
  : null;

function finalizerPointer(value, label, allowNull = false) {
  if (value instanceof JSCallback) value = value.ptr;
  if (allowNull && (value === undefined || value === null)) return 0;
  if ((typeof value !== "number" && typeof value !== "bigint") || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    throw new TypeError(`Expected ${label} to be a C pointer (number or BigInt)`);
  }
  return Number(value);
}

export function toArrayBuffer(pointer, byteOffset = undefined, byteLength = undefined, finalizationCtxOrPtr = undefined, finalizationCallback = undefined) {
  const address = pointerNumber(pointer);
  const offset = pointerOffset(byteOffset);
  const explicitLength = arguments.length >= 3 && byteLength !== undefined && byteLength !== null;
  const length = pointerLength(byteLength, explicitLength) ?? memoryUntilNul(address, offset);
  const arrayBuffer = cottontail.memoryView(address, offset, length);
  if (finalizationCtxOrPtr != null || finalizationCallback != null) {
    if (!pointerViewFinalizers) throw new Error("FinalizationRegistry is unavailable in this JavaScriptCore build");
    const callback = finalizerPointer(finalizationCallback ?? finalizationCtxOrPtr, "callback");
    const context = finalizationCallback == null ? 0 : finalizerPointer(finalizationCtxOrPtr, "user data", true);
    pointerViewFinalizers.register(arrayBuffer, { address: address + offset, callback, context });
  }
  return arrayBuffer;
}

export function toBuffer(pointer, byteOffset = undefined, byteLength = undefined, finalizationCtxOrPtr = undefined, finalizationCallback = undefined) {
  const arrayBuffer = toArrayBuffer(pointer, byteOffset, byteLength, finalizationCtxOrPtr, finalizationCallback);
  return globalThis.Buffer.from(arrayBuffer);
}

function dataView(pointer, byteLength, offset = 0) {
  return new DataView(cottontail.memoryView(pointerNumber(pointer), pointerOffset(offset), byteLength));
}

export const read = {
  u8(pointer, offset = 0) { return dataView(pointer, 1, offset).getUint8(0); },
  u16(pointer, offset = 0) { return dataView(pointer, 2, offset).getUint16(0, true); },
  u32(pointer, offset = 0) { return dataView(pointer, 4, offset).getUint32(0, true); },
  ptr(pointer, offset = 0) { return Number(dataView(pointer, 8, offset).getBigUint64(0, true)); },
  i8(pointer, offset = 0) { return dataView(pointer, 1, offset).getInt8(0); },
  i16(pointer, offset = 0) { return dataView(pointer, 2, offset).getInt16(0, true); },
  i32(pointer, offset = 0) { return dataView(pointer, 4, offset).getInt32(0, true); },
  i64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigInt64(0, true); },
  u64(pointer, offset = 0) { return dataView(pointer, 8, offset).getBigUint64(0, true); },
  intptr(pointer, offset = 0) { return Number(dataView(pointer, 8, offset).getBigInt64(0, true)); },
  f32(pointer, offset = 0) { return dataView(pointer, 4, offset).getFloat32(0, true); },
  f64(pointer, offset = 0) { return dataView(pointer, 8, offset).getFloat64(0, true); },
};

function readCString(pointer) {
  const address = pointerNumber(pointer);
  const length = memoryUntilNul(address);
  return stringFromBytes(new Uint8Array(cottontail.memoryView(address, 0, length)));
}

const cstringArrayBuffers = new WeakMap();

export class CString extends String {
  constructor(value, byteOffset, byteLength) {
    const pointer = value == null ? 0 : value;
    let text = "";
    if (pointer !== 0) {
      const address = pointerNumber(pointer);
      const offset = pointerOffset(byteOffset);
      if (byteLength === undefined || byteLength === null) {
        text = readCString(address + offset);
      } else {
        const length = pointerLength(byteLength, true);
        text = stringFromBytes(new Uint8Array(cottontail.memoryView(address, offset, length)));
      }
    }
    super(text);
    this.ptr = typeof pointer === "number" ? pointer : 0;
    this.byteOffset = byteOffset;
    this.byteLength = byteLength;
  }

  get arrayBuffer() {
    const cached = cstringArrayBuffers.get(this);
    if (cached) return cached;
    const arrayBuffer = !this.ptr
      ? new ArrayBuffer(0)
      : toArrayBuffer(this.ptr, this.byteOffset ?? 0, this.byteLength);
    cstringArrayBuffers.set(this, arrayBuffer);
    return arrayBuffer;
  }
}

const callbackState = new WeakMap();

export class JSCallback {
  constructor(fn, options) {
    if (typeof fn !== "function") throw new TypeError("Expected callback to be a function");
    options ??= {};
    if (options == null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Expected callback options to be an object");
    }
    const argIds = functionArgs(options.args);
    const returnId = ffiTypeId(options.returns, FFIType.void);
    const threadsafe = Boolean(options.threadsafe);
    const callback = (...args) => {
      const converted = args.map((value, index) => callbackValue(value, argIds[index] ?? FFIType.ptr));
      return nativeArg(fn(...converted), returnId);
    };
    const pointer = cottontail.createCallback(callback, argIds.map((id) => ffiNativeTypes[id]), ffiNativeTypes[returnId], threadsafe);
    if (typeof pointer !== "number" || pointer <= 0) throw new Error("failed to create FFI callback");
    this.ptr = pointer;
    callbackState.set(this, { callback, pointer, threadsafe });
  }

  get threadsafe() {
    return callbackState.get(this)?.threadsafe ?? false;
  }

  [Symbol.toPrimitive]() {
    return typeof this.ptr === "number" ? this.ptr : 0;
  }

  close() {
    const state = callbackState.get(this);
    const pointer = this.ptr;
    this.ptr = null;
    if (!state || !pointer) return;
    callbackState.delete(this);
    cottontail.closeCallback?.(pointer);
  }

  [Symbol.dispose]() {
    this.close();
  }
}

function functionArgs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('Expected "args" to be an array');
  return value.map((type) => ffiTypeId(type));
}

function exactNativeInteger(value) {
  const text = value.toString();
  return {
    toString() { return text; },
    [Symbol.toPrimitive](hint) {
      if (hint === "number") throw new TypeError("exact 64-bit integer");
      return text;
    },
  };
}

function nativeWord(value, bits, signed) {
  let bigint;
  try {
    bigint = typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value) || 0));
  } catch {
    bigint = 0n;
  }
  const word = BigInt.asUintN(bits, bigint);
  return word <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(word) : exactNativeInteger(word);
}

function pointerArgument(value, functionPointer = false) {
  if (value == null) return null;
  if (value instanceof JSCallback || value instanceof CString) value = value.ptr;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Unable to convert ${String(value)} to a pointer`);
    return value;
  }
  if (functionPointer && typeof value === "bigint") return Number(value);
  if (ArrayBuffer.isView(value)) return value;
  if (isBufferSource(value) && !ArrayBuffer.isView(value)) return ptr(value);
  if (typeof value === "string") throw new TypeError("To convert a string to a pointer, encode it as a buffer");
  if (functionPointer && value && (typeof value.ptr === "number" || typeof value.ptr === "bigint")) {
    return Number(value.ptr);
  }
  throw new TypeError(functionPointer
    ? "Expected function to be a JSCallback or a number"
    : `Unable to convert ${String(value)} to a pointer`);
}

function nativeArg(value, type) {
  const id = typeof type === "number" ? type : ffiTypeId(type);
  switch (id) {
    case 0:
    case 1:
      return nativeWord(Number(value) | 0, 8, true);
    case 2: {
      const number = Number(value) || 0;
      return number < 0 ? 0 : number >= 255 ? 255 : number | 0;
    }
    case 3: {
      const number = Number(value) || 0;
      return nativeWord(number <= -32768 ? -32768 : number >= 32768 ? 32768 : number | 0, 16, true);
    }
    case 4: {
      const number = typeof value === "bigint" ? Number(value) : Number(value);
      const integer = number | 0;
      return integer <= 0 ? 0 : integer > 0xffff ? 0xffff : integer;
    }
    case 5:
      return nativeWord(Number(value) | 0, 32, true);
    case 6: {
      const number = Number(value) || 0;
      return number < 0 ? 0 : number > 0xffffffff ? 0xffffffff : number >>> 0;
    }
    case 7:
      return nativeWord(value, 64, true);
    case 8:
      return nativeWord(typeof value === "bigint" ? value : Math.max(0, Number(value) || 0), 64, false);
    case 9:
      return typeof value === "bigint" ? Number(value) : Number(value) || 0;
    case 10:
      return Math.fround(Number(value) || 0);
    case 11:
      return Boolean(value);
    case 12:
    case 14:
      return pointerArgument(value);
    case 13:
      return undefined;
    case 15: {
      if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(-Number.MAX_SAFE_INTEGER)) {
        return nativeWord(Number(value), 64, true);
      }
      return nativeWord(value, 64, true);
    }
    case 16: {
      if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= 0n) {
        return Number(value);
      }
      return nativeWord(typeof value === "bigint" ? value : Math.max(0, Number(value) || 0), 64, false);
    }
    case 17:
      return pointerArgument(value, true);
    case 18:
    case 19:
      return value;
    case 20:
      if (!ArrayBuffer.isView(value)) throw new TypeError("Expected a TypedArray");
      return value;
    default:
      return value;
  }
}

function callbackValue(value, type) {
  switch (type) {
    case 7:
    case 8:
      return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value) || 0));
    case 15:
    case 16:
      return value;
    case 11:
      return Boolean(value);
    case 12:
    case 17:
      return value ? Number(value) : null;
    default:
      return value;
  }
}

function returnForType(type, value) {
  const id = typeof type === "number" ? type : ffiTypeId(type);
  switch (id) {
    case 13:
      return undefined;
    case 11:
      return Boolean(value);
    case 14:
      return new CString(value || 0);
    case 19:
      return value;
    case 7:
    case 8:
      return typeof value === "bigint" ? value : BigInt(Math.trunc(Number(value || 0)));
    case 15:
    case 16:
      if (typeof value !== "bigint") return Number(value || 0);
      if (value <= BigInt(Number.MAX_SAFE_INTEGER) && (id === 15 || value >= 0n)) return Number(value);
      return value;
    case 12:
    case 17:
      return value ? Number(value) : null;
    default:
      return value == null ? 0 : Number(value);
  }
}

function validateSymbolOptions(symbols) {
  if (symbols == null || typeof symbols !== "object" || Array.isArray(symbols)) {
    throw new TypeError("Expected an options object with symbol names");
  }
  const entries = Object.entries(symbols);
  if (entries.length === 0) throw new TypeError("Expected at least one symbol");
  return entries;
}

function symbolSpec(name, value, requirePointer) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Symbol "${name}" must be an object`);
  }
  const args = functionArgs(value.args);
  const returns = ffiTypeId(value.returns, FFIType.void);
  let pointer;
  if (requirePointer) {
    pointer = value.ptr ?? value.pointer;
    if ((typeof pointer !== "number" && typeof pointer !== "bigint") || !Number.isFinite(Number(pointer)) || Number(pointer) <= 0) {
      throw new TypeError(`Symbol "${name}" is missing a "ptr" field. When using linkSymbols() or CFunction(), you must provide a "ptr" field with the memory address of the native function.`);
    }
    pointer = Number(pointer);
  }
  return { args, returns, pointer };
}

function arityWrapper(call, count) {
  switch (count) {
    case 0: return function () { return call([]); };
    case 1: return function (a) { return call([a]); };
    case 2: return function (a, b) { return call([a, b]); };
    case 3: return function (a, b, c) { return call([a, b, c]); };
    case 4: return function (a, b, c, d) { return call([a, b, c, d]); };
    case 5: return function (a, b, c, d, e) { return call([a, b, c, d, e]); };
    case 6: return function (a, b, c, d, e, f) { return call([a, b, c, d, e, f]); };
    case 7: return function (a, b, c, d, e, f, h) { return call([a, b, c, d, e, f, h]); };
    case 8: return function (a, b, c, d, e, f, h, i) { return call([a, b, c, d, e, f, h, i]); };
    default: return function (...args) { return call(args); };
  }
}

function ffiCallable(name, spec, invoke) {
  const call = (args) => {
    const nativeArgs = spec.args.map((type, index) => nativeArg(args[index], type));
    return returnForType(spec.returns, invoke(nativeArgs));
  };
  const nativeFunction = arityWrapper(call, spec.args.length);
  const wrapped = spec.args.length > 0 || spec.returns === FFIType.cstring
    ? arityWrapper(call, spec.args.length)
    : nativeFunction;
  Object.defineProperty(nativeFunction, "name", { value: name, configurable: true });
  if (wrapped !== nativeFunction) Object.defineProperty(wrapped, "name", { value: name, configurable: true });
  wrapped.native = nativeFunction;
  nativeFunction.native = nativeFunction;
  return wrapped;
}

function closeHandle() {
  let closed = false;
  return function close() {
    if (closed) return undefined;
    closed = true;
    return undefined;
  };
}

function wrapLibraryError(error, libraryPath, symbolName = undefined) {
  const detail = String(error?.message ?? error);
  if (/dlopen|failed to open|cannot open|no such file|image not found/i.test(detail)) {
    throw new Error(`Failed to open library "${libraryPath}": ${detail}`);
  }
  if (symbolName) throw new Error(`Symbol "${symbolName}" not found in library "${libraryPath}": ${detail}`);
  throw error;
}

function defineSymbol(target, name, value) {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function dlopen(path, symbols) {
  const libraryPath = normalizeLibraryPath(path);
  const wrapped = {};
  for (const [name, value] of validateSymbolOptions(symbols)) {
    const spec = symbolSpec(name, value, false);
    let pointer;
    try {
      pointer = Number(cottontail.nativeSymbol(libraryPath, name));
    } catch (error) {
      wrapLibraryError(error, libraryPath, name);
    }
    const callable = ffiCallable(name, spec, (nativeArgs) =>
      cottontail.nativeCall(libraryPath, name, ffiNativeTypes[spec.returns], spec.args.map((id) => ffiNativeTypes[id]), nativeArgs));
    callable.ptr = pointer;
    callable.native.ptr = pointer;
    defineSymbol(wrapped, name, callable);
  }
  return { symbols: wrapped, close: closeHandle() };
}

let cFunctionId = 0;

export function CFunction(pointerOrSpec, options = {}) {
  const value = pointerOrSpec && typeof pointerOrSpec === "object" && !(pointerOrSpec instanceof ArrayBuffer) && !ArrayBuffer.isView(pointerOrSpec)
    ? pointerOrSpec
    : { ptr: pointerOrSpec, ...options };
  const name = `CFunction${cFunctionId++}`;
  const spec = symbolSpec(name, value, true);
  const callable = ffiCallable(name, spec, (nativeArgs) =>
    cottontail.nativeCallPointer(spec.pointer, ffiNativeTypes[spec.returns], spec.args.map((id) => ffiNativeTypes[id]), nativeArgs));
  callable.ptr = spec.pointer;
  callable.native.ptr = spec.pointer;
  callable.close = closeHandle();
  callable[Symbol.dispose] = callable.close;
  return callable;
}

export function linkSymbols(symbols) {
  const wrapped = {};
  for (const [name, value] of validateSymbolOptions(symbols)) {
    const spec = symbolSpec(name, value, true);
    const callable = ffiCallable(name, spec, (nativeArgs) =>
      cottontail.nativeCallPointer(spec.pointer, ffiNativeTypes[spec.returns], spec.args.map((id) => ffiNativeTypes[id]), nativeArgs));
    callable.ptr = spec.pointer;
    callable.native.ptr = spec.pointer;
    defineSymbol(wrapped, name, callable);
  }
  return { symbols: wrapped, close: closeHandle() };
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
  let text = source;
  if (text && typeof text === "object") text = normalizeLibraryPath(text);
  text = String(text ?? "");
  if (text.startsWith("file:")) text = normalizeLibraryPath(text);
  if (cottontail.existsSync(text)) return text;
  const path = pathJoin(tmpRoot(), `source-${Date.now()}-${Math.floor(Math.random() * 1000000)}.c`);
  cottontail.writeFile(path, text);
  return path;
}

function ccArguments(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(String);
}

export function cc(options) {
  if (options == null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Expected options to be an object");
  }
  const source = options.source ?? options.file ?? options.path;
  const symbols = options.symbols ?? options.exports;
  if (source == null) throw new TypeError("Expected source to be a string to a file path");
  if (symbols == null || typeof symbols !== "object") throw new TypeError('Bun.cc requires a "symbols" object');

  const dir = tmpRoot();
  const output = pathJoin(dir, `libcc-${Date.now()}-${Math.floor(Math.random() * 1000000)}.${suffix}`);
  const sourcePaths = (Array.isArray(source) ? source : [source]).map(sourcePathForCc);
  if (sourcePaths.length === 0) throw new TypeError("Expected source to be a string to a file path");
  const compiler = compilerCommand();
  const platformName = platform();
  const sharedArgs = platformName === "darwin"
    ? ["-dynamiclib", "-undefined", "dynamic_lookup"]
    : platformName === "win32"
      ? ["-shared"]
      : ["-shared", "-fPIC"];
  const defines = Object.entries(options.define || {}).map(([name, value]) => `-D${name}=${value == null ? "1" : String(value)}`);
  const args = [
    ...compiler.prefix,
    ...sourcePaths,
    ...sharedArgs,
    ...defines,
    "-o",
    output,
    ...ccArguments(options.flags),
    ...ccArguments(options.args),
  ].map(String);
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

const nativeDlopen = function dlopen(path) {
  return dlopen(path, arguments[1]);
};

export const native = {
  dlopen: nativeDlopen,
  callback() {
    throw new Error("Deprecated. Use new JSCallback(options, fn) instead");
  },
};

function cIdentifier(value) {
  const identifier = String(value).replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(identifier) ? `_${identifier}` : identifier;
}

function ffiSource(name, value, callback) {
  const spec = symbolSpec(name, value, false);
  const returnType = ffiCTypeNames[spec.returns];
  const params = spec.args.length === 0
    ? "void"
    : spec.args.map((type, index) => `${ffiCTypeNames[type]} arg${index}`).join(", ");
  const declaration = `${returnType} ${cIdentifier(name)}(${params});`;
  return [
    "/* Generated by Cottontail bun:ffi.viewSource(). */",
    "#include <stdbool.h>",
    "#include <stdint.h>",
    "#include <stddef.h>",
    "typedef void *napi_env;",
    "typedef void *napi_value;",
    callback ? "/* Callback ABI declaration used by the libffi closure. */" : "/* Dynamic-library symbol declaration used by libffi. */",
    declaration,
    "",
  ].join("\n");
}

export function viewSource(value, isCallback = false) {
  if (isCallback) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Expected an object");
    }
    return ffiSource("my_callback_function", value, true);
  }
  return validateSymbolOptions(value).map(([name, spec]) => ffiSource(name, spec, false));
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
