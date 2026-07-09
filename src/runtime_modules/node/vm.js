const contextMarker = Symbol("cottontail.vm.context");

export function createContext(context = {}) {
  if (context == null || typeof context !== "object") throw new TypeError("context must be an object");
  Object.defineProperty(context, contextMarker, { value: true, configurable: true });
  context.global = context;
  context.globalThis = context;
  return context;
}

export function isContext(value) {
  return Boolean(value?.[contextMarker]);
}

export function runInThisContext(code) {
  return (0, eval)(String(code));
}

export function runInContext(code, context = {}) {
  if (!isContext(context)) createContext(context);
  return Function("context", "code", "with (context) { return eval(code); }")(context, String(code));
}

export function runInNewContext(code, context = {}, options = undefined) {
  void options;
  return runInContext(code, createContext(context));
}

export class Script {
  constructor(code, options = undefined) {
    this.code = String(code);
    this.options = options ?? {};
  }

  runInThisContext(options = undefined) {
    void options;
    return runInThisContext(this.code);
  }

  runInContext(context, options = undefined) {
    void options;
    return runInContext(this.code, context);
  }

  runInNewContext(context = {}, options = undefined) {
    return runInNewContext(this.code, context, options);
  }
}

export function createScript(code, options = undefined) {
  return new Script(code, options);
}

export function compileFunction(code, params = [], options = {}) {
  const names = Array.from(params ?? [], String);
  const fn = Function(...names, String(code));
  if (options?.parsingContext || options?.contextExtensions?.length) {
    const context = options.parsingContext ?? {};
    const extensions = options.contextExtensions ?? [];
    return function compiledFunction(...args) {
      return Function("context", "extensions", "fn", "args", `
        with (context) {
          for (const extension of extensions) {
            with (extension) { return fn(...args); }
          }
          return fn(...args);
        }
      `)(context, extensions, fn, args);
    };
  }
  return fn;
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

// COTTONTAIL-COMPAT: node:vm context isolation - code executes through JSC eval/Function with object scopes; full V8 contextification and heap measurement require native VM support.

export default {
  Script,
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
