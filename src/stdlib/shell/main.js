import * as module from "../../runtime_modules/bun/shell.js";
import * as runtime from "../../runtime_modules/internal/bun-shell-runtime.js";
globalThis.__cottontailCapabilityResult = {
  namespace: module,
  modules: {
    "bun/shell.js": module,
    "internal/bun-shell-runtime.js": runtime,
  },
};
