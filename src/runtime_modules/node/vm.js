// Native contexts are sibling JSC globals in the main runtime's context
// group. Values can cross the C API boundary without cloning while each
// context retains its own ECMAScript intrinsics.
const contexts = new WeakSet();
const contextHandles = new WeakMap();
const contextVmSnapshots = new WeakMap();
const vmHost = globalThis.cottontail;
const intrinsicPromiseThen = Promise.prototype.then;
const contextFinalizer = typeof FinalizationRegistry === "function" &&
  typeof vmHost?.vmReleaseContext === "function"
  ? new FinalizationRegistry(handle => {
      try {
        vmHost.vmReleaseContext(handle);
      } catch {}
    })
  : undefined;

const intrinsicNames = [
  "AggregateError", "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array",
  "BigUint64Array", "Boolean", "DataView", "Date", "Error", "EvalError",
  "FinalizationRegistry", "Float16Array", "Float32Array", "Float64Array",
  "Function", "Infinity", "Int16Array", "Int32Array", "Int8Array", "Intl",
  "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise",
  "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set",
  "SharedArrayBuffer", "String", "Symbol", "SyntaxError", "TypeError",
  "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray",
  "WeakMap", "WeakRef", "WeakSet", "decodeURI", "decodeURIComponent",
  "encodeURI", "encodeURIComponent", "escape", "eval", "isFinite", "isNaN",
  "parseFloat", "parseInt", "undefined", "unescape",
];
const intrinsics = new Map();
for (const name of intrinsicNames) {
  if (name in globalThis) intrinsics.set(name, globalThis[name]);
}
intrinsics.set("undefined", undefined);

const contextCodeGeneration = new WeakMap();
const contextObjectIntrinsics = new WeakMap();

function throwCodeGenerationError() {
  throw new EvalError("Code generation from strings disallowed for this context");
}

// JSC in this embedding does not honor `//# sourceURL` for Error.prototype
// stack strings, so scripts run with a `filename` option would otherwise
// produce stack frames with empty URLs ("eval code@"). To emulate Node's
// behavior (stack traces show the vm filename), identifier lookups of `Error`
// inside vm code resolve to a Proxy that constructs a real Error and then
// rewrites empty-URL frames to point at the filename.
function makeStackFilenameFixer(filename) {
  const safeName = String(filename).replace(/[\r\n]/g, " ");
  return error => {
    try {
      const stack = error?.stack;
      if (typeof stack === "string" && stack.length > 0) {
        error.stack = stack.replace(/@(?=\n|$)/g, `@${safeName}`);
      }
    } catch {
      // stack may be non-writable; filename annotation is best-effort
    }
    return error;
  };
}

function makeFilenameErrorConstructor(RealError, filename) {
  const fix = makeStackFilenameFixer(filename);
  return new Proxy(RealError, {
    construct(target, args, newTarget) {
      return fix(Reflect.construct(target, args, newTarget ?? target));
    },
    apply(target, thisArg, args) {
      return fix(Reflect.apply(target, thisArg, args));
    },
  });
}

function sourceURLFromCode(code) {
  const pattern = /^[\t ]*\/\/[#@][\t ]*sourceURL[\t ]*=[\t ]*([^\r\n]*)|\/\*[#@][\t ]*sourceURL[\t ]*=[\t ]*([^*]*?)[\t ]*\*\//gm;
  let sourceURL;
  for (let match; (match = pattern.exec(code)) !== null;) {
    const candidate = (match[1] ?? match[2] ?? "").trim();
    if (candidate) sourceURL = candidate;
  }
  return sourceURL;
}

function stackLocationValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}

function callSiteWithSourceName(callSite, error, sourceName) {
  const safeName = String(sourceName).replace(/[\r\n]/g, " ");
  const line = stackLocationValue(error?.line, stackLocationValue(callSite?.getLineNumber?.(), 1));
  const column = stackLocationValue(callSite?.getColumnNumber?.(), 1);
  const location = `${safeName}:${line}:${column}`;

  return new Proxy(callSite, {
    get(target, key) {
      if (key === "getFileName" || key === "getScriptNameOrSourceURL") return () => safeName;
      if (key === "getLineNumber") return () => line;
      if (key === "getColumnNumber") return () => column;
      if (key === "getFunctionName" || key === "getMethodName" || key === "getTypeName") return () => null;
      if (key === "isEval") return () => false;
      if (key === "toString") return () => location;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function defaultPrepareStackTrace(error, trace) {
  let header;
  try {
    header = error == null ? String(error) : Error.prototype.toString.call(error);
  } catch {
    header = "<error>";
  }
  if (!Array.isArray(trace) || trace.length === 0) return header;
  return `${header}\n    at ${trace.map(site => String(site)).join("\n    at ")}`;
}

function evaluateInThisContext(code, sourceName) {
  const ErrorCtor = globalThis.Error;
  const previousPrepareStackTrace = ErrorCtor.prepareStackTrace;
  const prepareStackTrace = function prepareStackTrace(error, trace) {
    let mappedTrace = trace;
    if (Array.isArray(trace) && trace.length > 0) {
      mappedTrace = trace.map(callSite => {
        if (callSite == null || typeof callSite !== "object") return callSite;
        let existingSource;
        let text;
        try {
          existingSource = callSite.getFileName?.() ?? callSite.getScriptNameOrSourceURL?.();
          text = String(callSite);
        } catch {
          return callSite;
        }
        if (existingSource == null && (text.endsWith("@") || text.includes("(<anonymous>)"))) {
          return callSiteWithSourceName(callSite, error, sourceName);
        }
        return callSite;
      });
    }
    if (typeof previousPrepareStackTrace === "function") {
      return Reflect.apply(previousPrepareStackTrace, ErrorCtor, [error, mappedTrace]);
    }
    return defaultPrepareStackTrace(error, mappedTrace);
  };

  ErrorCtor.prepareStackTrace = prepareStackTrace;
  try {
    return (0, eval)(code);
  } catch (error) {
    // JSC formats stacks lazily. Materialize a thrown VM error while the
    // filename-aware call-site adapter is installed.
    try {
      if (error instanceof intrinsics.get("Error")) void error.stack;
    } catch {}
    throw error;
  } finally {
    // Preserve an explicit prepareStackTrace assignment made by VM code.
    if (ErrorCtor.prepareStackTrace === prepareStackTrace) {
      ErrorCtor.prepareStackTrace = previousPrepareStackTrace;
    }
  }
}

// Copy-on-write stand-in for Object.prototype handed to VM context scopes:
// reads fall through to the real prototype, but `with (Object.
// prototype) { toString = ... }` style attacks create own properties on the
// shadow instead of mutating the shared intrinsic.
function makeShadowObjectIntrinsic() {
  const shadowPrototype = {};
  return new Proxy(Object, {
    get(target, key, receiver) {
      if (key === "prototype") return shadowPrototype;
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === "prototype" && descriptor && "value" in descriptor) {
        descriptor.value = shadowPrototype;
      }
      return descriptor;
    },
  });
}

function objectIntrinsicForContext(context) {
  let intrinsic = contextObjectIntrinsics.get(context);
  if (!intrinsic) {
    intrinsic = makeShadowObjectIntrinsic();
    contextObjectIntrinsics.set(context, intrinsic);
  }
  return intrinsic;
}

function makeScopeProxy(context, scopeOptions = undefined) {
  const codeGeneration = contextCodeGeneration.get(context);
  const stringsDisallowed = codeGeneration?.strings === false;
  const filename = scopeOptions?.filename;
  let patchedError;
  // The first `eval` lookup comes from our own runner bootstrapping the
  // script; subsequent lookups originate from the script itself.
  let evalBootstrapDone = false;
  return new Proxy(context, {
    has(target, key) {
      // The runner references the raw context binding from inside this
      // `with` scope; that one name must resolve in the function scope.
      if (key === "__cottontail_vm_context__") return false;
      // Trap every other name so lookups never fall through to the host
      // global. Declarations hoisted out of the eval'd code live in a scope
      // that sits closer to the code than this proxy, so they still win.
      return true;
    },
    get(target, key, receiver) {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return Reflect.get(target, key, receiver);
      if (key === "globalThis") return target;
      if (stringsDisallowed && (key === "eval" || key === "Function")) {
        if (key === "eval" && !evalBootstrapDone) {
          evalBootstrapDone = true;
          return intrinsics.get("eval");
        }
        return throwCodeGenerationError;
      }
      if (filename != null && key === "Error") {
        return (patchedError ??= makeFilenameErrorConstructor(intrinsics.get("Error"), filename));
      }
      if (key === "Object") return objectIntrinsicForContext(context);
      if (typeof key === "string" && intrinsics.has(key)) return intrinsics.get(key);
      return undefined;
    },
  });
}

function nodeError(ErrorCtor, code, message) {
  const error = new ErrorCtor(message);
  error.code = code;
  return error;
}

export function createContext(context = {}, options = undefined) {
  if (context === null || (typeof context !== "object" && typeof context !== "function")) {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "contextObject" argument must be of type object.');
  }
  if (!isContext(context)) {
    if (typeof vmHost?.vmCreateContext === "function" && typeof vmHost?.vmRunInContext === "function") {
      const handle = vmHost.vmCreateContext(
        options?.name,
        options?.codeGeneration?.strings !== false,
      );
      contextHandles.set(context, handle);
      contextFinalizer?.register(context, handle);
    }
    contexts.add(context);
  }
  if (options?.codeGeneration !== undefined) {
    contextCodeGeneration.set(context, {
      strings: options.codeGeneration.strings !== false,
      wasm: options.codeGeneration.wasm !== false,
    });
  }
  return context;
}

export function isContext(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    contexts.has(value);
}

function normalizeRunOptions(options) {
  if (typeof options === "string") return { filename: options };
  if (options === null || options === undefined) return {};
  if (typeof options !== "object") return {};
  return options;
}

function withSourceURL(code, filename) {
  const text = String(code);
  if (!filename || sourceURLFromCode(text) !== undefined) return text;
  const safeName = String(filename).replace(/[\r\n]/g, " ");
  return `${text}\n//# sourceURL=${safeName}`;
}

function descriptorSnapshot(value) {
  const snapshot = new Map();
  for (const key of Reflect.ownKeys(value)) {
    snapshot.set(key, Reflect.getOwnPropertyDescriptor(value, key));
  }
  return snapshot;
}

function sameDescriptor(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.configurable === right.configurable &&
    left.enumerable === right.enumerable &&
    left.writable === right.writable &&
    left.value === right.value &&
    left.get === right.get &&
    left.set === right.set;
}

function exportContextDelta(handle, context) {
  const baseline = contextVmSnapshots.get(context) ?? descriptorSnapshot(context);
  const exported = Object.create(null);
  vmHost.vmExportContext(handle, exported);
  const nextSnapshot = descriptorSnapshot(exported);
  const keys = new Set([...baseline.keys(), ...Reflect.ownKeys(exported)]);
  for (const key of keys) {
    const before = baseline.get(key);
    const after = Reflect.getOwnPropertyDescriptor(exported, key);
    if (sameDescriptor(before, after)) continue;
    if (after === undefined) Reflect.deleteProperty(context, key);
    else Reflect.defineProperty(context, key, after);
  }
  contextVmSnapshots.set(context, nextSnapshot);
}

function runCodeInContextFallback(code, context, options = undefined) {
  const { filename } = normalizeRunOptions(options);
  const scope = makeScopeProxy(context, { filename });
  // Scope chain seen by the eval'd code, innermost first:
  //   1. `with (context)`         - context properties, like Node's global
  //   2. arrow function var scope - receives `var`/function declarations that
  //      sloppy-mode direct eval hoists out of the script (Node puts these on
  //      the context global; here they at least resolve within the same run)
  //   3. `with (scope proxy)`     - intrinsics, and a catch-all that stops
  //      lookups from reaching the host global
  // The user code is embedded as a string literal: every plain identifier in
  // the runner body would otherwise resolve through the with-scope proxy.
  // An arrow function is used so the eval'd code sees neither an `arguments`
  // binding nor a rebound `this` (`this` stays the context via .call below).
  const runner = Function(
    "__cottontail_vm_scope__",
    "__cottontail_vm_context__",
    `with (__cottontail_vm_scope__) {
      return (() => {
        with (__cottontail_vm_context__) {
          return eval(${JSON.stringify(withSourceURL(code, filename))});
        }
      })();
    }`,
  );
  return runner.call(context, scope, context);
}

function runCodeInContext(code, context, options = undefined) {
  const handle = contextHandles.get(context);
  if (handle !== undefined && typeof vmHost?.vmRunInContext === "function") {
    const { filename } = normalizeRunOptions(options);
    const source = String(code);
    const sourceName = sourceURLFromCode(source) ?? filename ?? "evalmachine.<anonymous>";
    let result;
    try {
      result = vmHost.vmRunInContext(handle, context, source, sourceName);
    } finally {
      // vmRunInContext imports the host sandbox and immediately exports the
      // resulting VM state. Keep that VM-side snapshot separate from later
      // host changes so concurrent async evaluations only export their delta.
      try {
        contextVmSnapshots.set(context, descriptorSnapshot(context));
      } catch {}
    }
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function") &&
      typeof vmHost.vmExportContext === "function"
    ) {
      try {
        // Brand-check through the host intrinsic instead of inspecting or
        // assimilating `result.then`. This accepts a Promise from the sibling
        // JSC realm, rejects ordinary thenables, and preserves the exact value
        // and realm identity returned by vm.runInContext().
        const exportContext = () => exportContextDelta(handle, context);
        const observer = intrinsicPromiseThen.call(result, exportContext, exportContext);
        intrinsicPromiseThen.call(observer, undefined, () => {});
      } catch {}
    }
    return result;
  }
  return runCodeInContextFallback(code, context, options);
}

export function runInThisContext(code, options = undefined) {
  const { filename } = normalizeRunOptions(options);
  const source = String(code);
  const sourceName = sourceURLFromCode(source) ?? filename;
  const sourceWithURL = withSourceURL(source, filename);
  if (sourceName == null) return (0, eval)(sourceWithURL);
  return evaluateInThisContext(sourceWithURL, sourceName);
}

export function runInContext(code, contextifiedObject, options = undefined) {
  if (!isContext(contextifiedObject)) {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
      'The "contextifiedObject" argument must be an vm.Context.');
  }
  return runCodeInContext(code, contextifiedObject, options);
}

export function runInNewContext(code, contextObject = {}, options = undefined) {
  const context = isContext(contextObject) ? contextObject : createContext(contextObject ?? {});
  return runCodeInContext(code, context, options);
}

const kCachedDataPrefix = "cottontail-vm-bytecode-v1:";

function checkSyntax(code) {
  // Parse-check without executing; throws SyntaxError for invalid or
  // module-only syntax (e.g. `export default {}`).
  Function(String(code));
}

function cachedDataFor(code) {
  const payload = `${kCachedDataPrefix}${String(code)}`;
  const BufferCtor = globalThis.Buffer;
  if (typeof BufferCtor === "function") return BufferCtor.from(payload);
  return new TextEncoder().encode(payload);
}

function cachedDataMatches(cachedData, code) {
  try {
    const view = ArrayBuffer.isView(cachedData)
      ? new Uint8Array(cachedData.buffer, cachedData.byteOffset, cachedData.byteLength)
      : new Uint8Array(cachedData);
    const text = new TextDecoder().decode(view);
    return text === `${kCachedDataPrefix}${String(code)}`;
  } catch {
    return false;
  }
}

export function Script(code = "", options = undefined) {
  if (!new.target) {
    throw new TypeError("Class constructor Script cannot be invoked without 'new'");
  }
  const normalized = typeof options === "string" ? { filename: options } : options ?? {};
  this.code = String(code);
  this.options = normalized;
  this.filename = normalized.filename ?? "evalmachine.<anonymous>";
  this.cachedDataRejected = undefined;
  this.cachedDataProduced = false;
  this.cachedData = undefined;
  if (normalized.cachedData !== undefined) {
    if (!ArrayBuffer.isView(normalized.cachedData) && !(normalized.cachedData instanceof ArrayBuffer)) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
        'The "options.cachedData" property must be an instance of Buffer, TypedArray, or DataView.');
    }
    this.cachedDataRejected = !cachedDataMatches(normalized.cachedData, this.code);
  }
  if (normalized.produceCachedData) {
    try {
      checkSyntax(this.code);
      this.cachedData = cachedDataFor(this.code);
      this.cachedDataProduced = true;
    } catch {
      this.cachedDataProduced = false;
    }
  }
}

Script.prototype.runInThisContext = function runInThisContextMethod(options = undefined) {
  const runOptions = normalizeRunOptions(options);
  return runInThisContext(this.code, { filename: runOptions.filename ?? this.filename });
};

Script.prototype.runInContext = function runInContextMethod(contextifiedObject, options = undefined) {
  if (!isContext(contextifiedObject)) {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
      'The "contextifiedObject" argument must be an vm.Context.');
  }
  const runOptions = normalizeRunOptions(options);
  return runCodeInContext(this.code, contextifiedObject, { filename: runOptions.filename ?? this.filename });
};

Script.prototype.runInNewContext = function runInNewContextMethod(contextObject = {}, options = undefined) {
  const context = isContext(contextObject) ? contextObject : createContext(contextObject ?? {});
  const runOptions = normalizeRunOptions(options);
  return runCodeInContext(this.code, context, { filename: runOptions.filename ?? this.filename });
};

Script.prototype.createCachedData = function createCachedData() {
  try {
    checkSyntax(this.code);
  } catch {
    throw new Error("createCachedData failed");
  }
  return cachedDataFor(this.code);
};

export function createScript(code, options = undefined) {
  return new Script(code, options);
}

export function compileFunction(code, params = [], options = {}) {
  if (typeof code !== "string") {
    throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "code" argument must be of type string.');
  }
  const names = Array.from(params ?? [], String);
  const normalized = options ?? {};
  const filename = normalized.filename ?? "";
  const parsingContext = normalized.parsingContext;
  const contextExtensions = Array.isArray(normalized.contextExtensions) ? normalized.contextExtensions : [];

  if (parsingContext === undefined && contextExtensions.length === 0) {
    return Function(...names, withSourceURL(code, filename));
  }

  let scopeTarget;
  if (parsingContext !== undefined) {
    if (!isContext(parsingContext)) {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE",
        'The "options.parsingContext" property must be an instance of Context.');
    }
    scopeTarget = parsingContext;
  } else {
    scopeTarget = {};
  }

  const scope = makeScopeProxy(scopeTarget);
  // Extensions layer additional lookup objects over the context scope.
  let builder = `return function (${names.join(", ")}) {\n${code}\n}`;
  const extensionParams = contextExtensions.map((_, index) => `__cottontail_ext_${index}__`);
  for (let index = extensionParams.length - 1; index >= 0; index -= 1) {
    builder = `with (${extensionParams[index]}) { ${builder} }`;
  }
  return Function(
    "__cottontail_vm_scope__",
    ...extensionParams,
    `with (__cottontail_vm_scope__) { ${builder} }`,
  )(scope, ...contextExtensions);
}

// Minimal vm.SourceTextModule: supports sources without import/export by
// evaluating them as scripts. True ES module records (linking, namespaces,
// import.meta) require native support.
export class SourceTextModule {
  #source;

  constructor(source, options = undefined) {
    if (typeof source !== "string") {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "sourceText" argument must be of type string.');
    }
    const normalized = options ?? {};
    this.#source = source;
    this.identifier = normalized.identifier ?? "vm:module(0)";
    this.context = normalized.context;
    this.status = "unlinked";
    this.namespace = undefined;
    this.error = undefined;
    this.dependencySpecifiers = [];
  }

  async link(linker) {
    if (typeof linker !== "function") {
      throw nodeError(TypeError, "ERR_INVALID_ARG_TYPE", 'The "linker" argument must be of type function.');
    }
    if (this.status !== "unlinked") return undefined;
    this.status = "linked";
    return undefined;
  }

  async evaluate(options = undefined) {
    void options;
    if (this.status !== "linked" && this.status !== "evaluated" && this.status !== "errored") {
      throw nodeError(Error, "ERR_VM_MODULE_STATUS", "Module must be linked before evaluating");
    }
    if (this.status === "errored") throw this.error;
    if (this.status === "evaluated") return undefined;
    this.status = "evaluating";
    try {
      if (this.context !== undefined && isContext(this.context)) {
        runCodeInContext(this.#source, this.context, { filename: this.identifier });
      } else {
        (0, eval)(withSourceURL(this.#source, this.identifier));
      }
      this.status = "evaluated";
      this.namespace = Object.create(null);
      return undefined;
    } catch (error) {
      this.status = "errored";
      this.error = error;
      throw error;
    }
  }
}

export async function measureMemory(options = {}) {
  void options;
  const usage = globalThis.process?.memoryUsage?.() ?? {};
  const estimate = Number(usage.heapUsed ?? usage.rss ?? 0);
  return {
    total: {
      jsMemoryEstimate: estimate,
      jsMemoryRange: [estimate, estimate],
    },
  };
}

export const constants = {
  USE_MAIN_CONTEXT_DEFAULT_LOADER: Symbol.for("vm_dynamic_import_main_context_default"),
  DONT_CONTEXTIFY: Symbol.for("vm_context_no_contextify"),
};

// COTTONTAIL-COMPAT: node:vm bytecode caching and SourceTextModule are still
// structural implementations. Script contexts themselves are native JSC
// realms with isolated intrinsics and context-global declaration semantics.

export default {
  Script,
  SourceTextModule,
  compileFunction,
  constants,
  createContext,
  createScript,
  isContext,
  measureMemory,
  runInContext,
  runInNewContext,
  runInThisContext,
};
