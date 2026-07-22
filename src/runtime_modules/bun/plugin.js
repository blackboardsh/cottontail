import {
  _clearBunPlugins,
  _registerBunPlugin,
} from "../node/module.js";

export function plugin(pluginOptions) {
  return _registerBunPlugin(...arguments);
}

Object.defineProperty(plugin, "clearAll", {
  value: function clearAll(_unused) {
    return _clearBunPlugins(_unused);
  },
  configurable: false,
  enumerable: true,
  writable: true,
});
