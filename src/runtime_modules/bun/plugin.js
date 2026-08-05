import {
  _clearBunPlugins,
  _registerBunPlugin,
  loadEmbeddedRuntimeModule,
} from "../node/module.js";

export function plugin(pluginOptions) {
  return _registerBunPlugin(...arguments);
}

// The Bake production builder lives in the lazily-loaded dev-server module.
// `bun build --app` looks it up through this global after merely referencing
// Bun.build, so register a loader shim eagerly (this module is a static
// dependency of bun/index.js) and defer the real import to first use.
const buildBakeProductionSymbol = Symbol.for("cottontail.internal.buildBakeProduction");
if (typeof globalThis[buildBakeProductionSymbol] !== "function") {
  Object.defineProperty(globalThis, buildBakeProductionSymbol, {
    configurable: true,
    enumerable: false,
    writable: true,
    value: function buildBakeProductionLazy(options) {
      return loadEmbeddedRuntimeModule("bun/bake-dev-server.js").buildProductionApp(options);
    },
  });
}

Object.defineProperty(plugin, "clearAll", {
  value: function clearAll(_unused) {
    return _clearBunPlugins(_unused);
  },
  configurable: false,
  enumerable: true,
  writable: true,
});
