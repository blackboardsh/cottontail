const lazyBuiltinSymbol = Symbol.for("cottontail.lazyBuiltin");
const lazyRuntimeDiagnosticsSymbol = Symbol.for("cottontail.runtime.lazyModules");
const lazyRuntimeDiagnosticsEnabled =
  globalThis.process?.env?.COTTONTAIL_LAZY_RUNTIME_DIAGNOSTICS === "1";

function diagnostics() {
  if (!lazyRuntimeDiagnosticsEnabled) return null;
  return globalThis[lazyRuntimeDiagnosticsSymbol] ??=
    new Map();
}

export function createLazyModule(name, initialize) {
  let state = 0;
  let value;
  diagnostics()?.set(name, false);

  return function loadLazyModule() {
    if (state === 2) return value;
    if (state === 1) {
      throw new Error(`Circular initialization of lazy runtime module "${name}"`);
    }

    state = 1;
    try {
      value = initialize();
      state = 2;
      diagnostics()?.set(name, true);
      return value;
    } catch (error) {
      state = 0;
      diagnostics()?.set(name, false);
      throw error;
    }
  };
}

function copyFunctionSurface(target, source) {
  try {
    Object.setPrototypeOf(target, Object.getPrototypeOf(source));
  } catch {}

  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;

    const current = Object.getOwnPropertyDescriptor(target, key);
    if (current && !current.configurable) {
      if (key === "prototype" && current.writable && "value" in descriptor) {
        try {
          Object.defineProperty(target, key, {
            ...current,
            value: descriptor.value,
          });
        } catch {}
      }
      continue;
    }

    try {
      Object.defineProperty(target, key, descriptor);
    } catch {}
  }
}

function alignPrototypeConstructor(source, exposed) {
  const prototype = source.prototype;
  if (
    prototype === null ||
    (typeof prototype !== "object" && typeof prototype !== "function")
  ) {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
  if (!descriptor || !("value" in descriptor) || descriptor.value !== source) return;

  try {
    Object.defineProperty(prototype, "constructor", {
      ...descriptor,
      value: exposed,
    });
  } catch {}
}

export function createLazyFunction(loadModule, exportName, displayName = exportName) {
  let implementation;
  let proxy;
  const boundMethods = new Map();

  const invoke = function (...args) {
    return Reflect.apply(resolve(), this, args);
  };
  const target = invoke.bind(undefined);
  Object.defineProperty(target, "name", {
    configurable: true,
    value: displayName,
  });

  function resolve() {
    if (implementation !== undefined) return implementation;
    const candidate = loadModule()[exportName];
    if (typeof candidate !== "function") {
      throw new TypeError(`Lazy runtime export "${exportName}" is not callable`);
    }
    implementation = candidate;
    copyFunctionSurface(target, implementation);
    alignPrototypeConstructor(implementation, proxy);
    return implementation;
  }

  proxy = new Proxy(target, {
    apply(_target, thisArgument, argumentsList) {
      return Reflect.apply(resolve(), thisArgument, argumentsList);
    },
    construct(_target, argumentsList, newTarget) {
      const constructor = resolve();
      return Reflect.construct(
        constructor,
        argumentsList,
        newTarget === proxy ? constructor : newTarget,
      );
    },
    defineProperty(_target, property, descriptor) {
      const source = resolve();
      const sourceResult = Reflect.defineProperty(source, property, descriptor);
      const targetResult = Reflect.defineProperty(target, property, descriptor);
      return sourceResult && targetResult;
    },
    deleteProperty(_target, property) {
      const source = resolve();
      const sourceResult = Reflect.deleteProperty(source, property);
      const targetResult = Reflect.deleteProperty(target, property);
      return sourceResult && targetResult;
    },
    get(_target, property) {
      const source = resolve();
      // Capability-owned accessors (for example bun:test's `.todo` getter)
      // keep private state keyed by the real exported function. Invoking a
      // copied accessor with the lazy Proxy as its receiver loses that state.
      const value = Reflect.get(source, property, source);
      let owner = source;
      let descriptor;
      while (owner != null && !(descriptor = Reflect.getOwnPropertyDescriptor(owner, property))) {
        owner = Reflect.getPrototypeOf(owner);
      }
      // Likewise, a prototype data method such as `.skipIf()` must receive the
      // real function as `this`. Do not bind values produced by accessors: a
      // getter such as `.todo` returns another stateful callable of its own.
      if (typeof value === "function" && descriptor && "value" in descriptor) {
        const cached = boundMethods.get(property);
        if (cached?.value === value) return cached.bound;
        const bound = value.bind(source);
        boundMethods.set(property, { value, bound });
        return bound;
      }
      return value;
    },
    getOwnPropertyDescriptor(_target, property) {
      resolve();
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    getPrototypeOf() {
      resolve();
      return Reflect.getPrototypeOf(target);
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
    ownKeys() {
      resolve();
      return Reflect.ownKeys(target);
    },
    set(_target, property, value) {
      const source = resolve();
      const sourceResult = Reflect.set(source, property, value, source);
      const targetResult = Reflect.set(target, property, value, target);
      return sourceResult && targetResult;
    },
    setPrototypeOf(_target, prototype) {
      const source = resolve();
      const sourceResult = Reflect.setPrototypeOf(source, prototype);
      const targetResult = Reflect.setPrototypeOf(target, prototype);
      return sourceResult && targetResult;
    },
  });

  return proxy;
}

function copyObjectSurface(target, source) {
  try {
    Object.setPrototypeOf(target, Object.getPrototypeOf(source));
  } catch {}

  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) continue;
    try {
      Object.defineProperty(target, key, descriptor);
    } catch {}
  }

  if (!Object.isExtensible(source)) {
    try {
      Object.preventExtensions(target);
    } catch {}
  }
}

export function createLazyObject(loadModule, exportName) {
  const target = {};
  let implementation;

  function resolve() {
    if (implementation !== undefined) return implementation;
    implementation = loadModule()[exportName];
    if (
      implementation === null ||
      (typeof implementation !== "object" && typeof implementation !== "function")
    ) {
      throw new TypeError(`Lazy runtime export "${exportName}" is not an object`);
    }
    copyObjectSurface(target, implementation);
    return implementation;
  }

  return new Proxy(target, {
    defineProperty(_target, property, descriptor) {
      const source = resolve();
      const sourceResult = Reflect.defineProperty(source, property, descriptor);
      copyObjectSurface(target, source);
      return sourceResult;
    },
    deleteProperty(_target, property) {
      const source = resolve();
      const sourceResult = Reflect.deleteProperty(source, property);
      Reflect.deleteProperty(target, property);
      return sourceResult;
    },
    get(_target, property) {
      const source = resolve();
      return Reflect.get(source, property, source);
    },
    getOwnPropertyDescriptor(_target, property) {
      resolve();
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    getPrototypeOf() {
      resolve();
      return Reflect.getPrototypeOf(target);
    },
    has(_target, property) {
      return Reflect.has(resolve(), property);
    },
    isExtensible() {
      resolve();
      return Reflect.isExtensible(target);
    },
    ownKeys() {
      resolve();
      return Reflect.ownKeys(target);
    },
    preventExtensions() {
      const source = resolve();
      const sourceResult = Reflect.preventExtensions(source);
      const targetResult = Reflect.preventExtensions(target);
      return sourceResult && targetResult;
    },
    set(_target, property, value) {
      const source = resolve();
      const sourceResult = Reflect.set(source, property, value, source);
      copyObjectSurface(target, source);
      return sourceResult;
    },
    setPrototypeOf(_target, prototype) {
      const source = resolve();
      const sourceResult = Reflect.setPrototypeOf(source, prototype);
      const targetResult = Reflect.setPrototypeOf(target, prototype);
      return sourceResult && targetResult;
    },
  });
}

export function createLazyBuiltin(loadModule, select = value => value) {
  const load = () => select(loadModule());
  Object.defineProperty(load, lazyBuiltinSymbol, { value: true });
  return load;
}

export function installLazyGlobal(name, loadValue, afterMaterialize = undefined) {
  if (Object.hasOwn(globalThis, name)) return;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: true,
    get() {
      const value = loadValue();
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
      afterMaterialize?.(name, value);
      return globalThis[name];
    },
    set(value) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });
}
