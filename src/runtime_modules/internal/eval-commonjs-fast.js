function loadFsNamespace(moduleModule) {
  const namespace = moduleModule.loadEmbeddedRuntimeModule("node/fs.js");
  return namespace?.default ?? namespace;
}

function fastWriteSync(fd, data, offset = undefined, length = undefined, position = null) {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const byteLength = view?.byteLength;
  const byteOffset = offset ?? 0;
  const writeLength = length ?? byteLength;
  if (!Number.isInteger(fd) || fd < 0 ||
      !ArrayBuffer.isView(view) ||
      !Number.isInteger(byteOffset) || byteOffset < 0 ||
      !Number.isInteger(writeLength) || writeLength < 0 ||
      byteOffset + writeLength > byteLength ||
      position != null) {
    return undefined;
  }
  if (writeLength === 0) return 0;
  return Number(cottontail.fdWriteAt(fd, view, byteOffset, writeLength, null));
}

function createFastFsFacade(moduleModule) {
  let full;
  const load = () => full ??= loadFsNamespace(moduleModule);
  const writeSync = (...args) => {
    const result = fastWriteSync(...args);
    return result === undefined ? Reflect.apply(load().writeSync, load(), args) : result;
  };
  const target = Object.create(null);
  Object.defineProperty(target, "writeSync", {
    value: writeSync,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return new Proxy(target, {
    get(current, property, receiver) {
      if (Reflect.has(current, property)) return Reflect.get(current, property, receiver);
      return Reflect.get(load(), property, load());
    },
    set(_current, property, value) {
      return Reflect.set(load(), property, value, load());
    },
    has(current, property) {
      return Reflect.has(current, property) || Reflect.has(load(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(current, property) {
      if (property === "default") return undefined;
      return Reflect.getOwnPropertyDescriptor(current, property) ??
        Reflect.getOwnPropertyDescriptor(load(), property);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(load());
    },
  });
}

// This entry path deliberately skips loading bun/index.js, which is where the
// V8-compatible Error machinery lives (structured CallSite arrays passed to
// Error.prepareStackTrace, Error.captureStackTrace). Bun always has that
// machinery, and CommonJS dependencies loaded through require() rely on it
// (pino's lib/caller.js reads file names out of the CallSite array to resolve
// transport targets). Install a lazy trap instead of paying the full bun
// namespace cost on every eval: the moment user code installs its own
// Error.prepareStackTrace or calls Error.captureStackTrace, materialize the
// real machinery and hand the call off to it.
function installLazyStackMachinery(moduleModule) {
  const NativeError = globalThis.Error;
  if (typeof NativeError !== "function" || NativeError.__cottontailStackHeader) return;
  if (Object.getOwnPropertyDescriptor(NativeError, "prepareStackTrace")?.get) return;

  // Bun ships a default Error.prepareStackTrace (unlike Node, where it is
  // undefined); mirror bun/index.js so the observable value matches before the
  // machinery is materialized.
  const defaultPrepareStackTrace = function prepareStackTrace(error, trace) {
    let header;
    try {
      header = error == null ? String(error) : Error.prototype.toString.call(error);
    } catch {
      header = "<error>";
    }
    if (!Array.isArray(trace)) {
      if (trace == null) return header;
      trace = [""];
    }
    if (trace.length === 0) return header;
    return `${header}\n    at ${trace.map((site) => String(site)).join("\n    at ")}`;
  };
  Object.defineProperty(defaultPrepareStackTrace, "__cottontailDefaultPrepare", { value: true });

  const nativeCaptureStackTrace = NativeError.captureStackTrace;
  let stored = defaultPrepareStackTrace;
  let materialized = false;

  const materialize = () => {
    if (materialized) return;
    materialized = true;
    // bun/index.js reads the pristine native captureStackTrace and installs its
    // own default prepareStackTrace when it finds `undefined`, so restore plain
    // data properties before loading it.
    delete NativeError.prepareStackTrace;
    if (typeof nativeCaptureStackTrace === "function") {
      NativeError.captureStackTrace = nativeCaptureStackTrace;
    }
    moduleModule.loadEmbeddedRuntimeModule("bun/index.js");
    if (stored !== defaultPrepareStackTrace) globalThis.Error.prepareStackTrace = stored;
    // bun/index.js swaps globalThis.Error for its own subclass; references
    // captured before materialization still point at the native constructor, so
    // keep a default there too rather than leaving it observably `undefined`.
    if (globalThis.Error !== NativeError && NativeError.prepareStackTrace === undefined) {
      NativeError.prepareStackTrace = defaultPrepareStackTrace;
    }
  };

  Object.defineProperty(NativeError, "prepareStackTrace", {
    configurable: true,
    enumerable: true,
    get() {
      return stored;
    },
    set(value) {
      stored = value;
      if (typeof value === "function" && value !== defaultPrepareStackTrace) materialize();
    },
  });

  if (typeof nativeCaptureStackTrace === "function") {
    const captureStackTrace = function captureStackTrace(target, constructorOpt = undefined) {
      materialize();
      return globalThis.Error.captureStackTrace(target, constructorOpt);
    };
    NativeError.captureStackTrace = captureStackTrace;
  }
}

export function installFastEvalCommonJsBuiltins(moduleModule) {
  const fs = createFastFsFacade(moduleModule);
  moduleModule.__setBuiltinModules({ fs, "node:fs": fs });
  installLazyStackMachinery(moduleModule);
}
