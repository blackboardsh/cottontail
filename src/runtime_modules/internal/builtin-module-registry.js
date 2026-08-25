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

export { builtinImportNamespaces, builtinModules, kBuiltinImportNamespaces };
