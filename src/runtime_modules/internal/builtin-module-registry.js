const kBuiltinImportNamespaces = Symbol.for("cottontail.node.builtinImportNamespaces");
const builtinModules = globalThis.__cottontailBuiltinModules ??= new Map();
const builtinImportNamespaces = builtinModules[kBuiltinImportNamespaces] ?? new Map();
const syntheticNamespaces = globalThis[Symbol.for("cottontail.node.syntheticBuiltinNamespaces")] ??= new WeakMap();

if (builtinModules[kBuiltinImportNamespaces] !== builtinImportNamespaces) {
  Object.defineProperty(builtinModules, kBuiltinImportNamespaces, {
    value: builtinImportNamespaces,
    configurable: true,
  });
}

export function setCoreBuiltinModules(modules) {
  for (const [name, value] of Object.entries(modules || {})) {
    builtinModules.set(name, value);
    if (value != null &&
        (typeof value === "object" || typeof value === "function") &&
        Object.hasOwn(value, "default")) {
      builtinImportNamespaces.set(name, value);
    } else if (value != null && (typeof value === "object" || typeof value === "function")) {
      let namespace = syntheticNamespaces.get(value);
      if (namespace === undefined) {
        namespace = { default: value };
        for (const key of Object.keys(value)) {
          if (key === "default") continue;
          Object.defineProperty(namespace, key, {
            enumerable: true,
            configurable: true,
            get: () => value[key],
          });
        }
        Object.defineProperty(namespace, Symbol.toStringTag, { value: "Module" });
        syntheticNamespaces.set(value, namespace);
      }
      builtinImportNamespaces.set(name, namespace);
    } else {
      builtinImportNamespaces.delete(name);
    }
  }
}

// A statically bundled builtin must also be reused by embedded relative
// imports. Publish its complete namespace only after module initialization.
export function registerCoreBuiltinModuleSource(relativePath, namespace) {
  const preloaded = globalThis[Symbol.for("cottontail.runtimeModulePreloadedModules")] ??= new Map();
  if (namespace[Symbol.toStringTag] === "Module") {
    preloaded.set(relativePath, namespace);
    return;
  }
  // The native bundler emits mutable namespace getters without a Module tag.
  // Match the embedded loader's getter-only namespace while keeping its live
  // bindings. In particular, fs must not acquire writable exports; crypto's
  // existing builtin wrapper adds its own reassignable exports when required.
  const embeddedNamespace = Object.create(null);
  Object.defineProperty(embeddedNamespace, Symbol.toStringTag, { value: "Module" });
  for (const name of Object.keys(namespace).sort()) {
    Object.defineProperty(embeddedNamespace, name, {
      configurable: true,
      enumerable: true,
      get: () => namespace[name],
    });
  }
  preloaded.set(relativePath, embeddedNamespace);
}

export { builtinImportNamespaces, builtinModules, kBuiltinImportNamespaces };
