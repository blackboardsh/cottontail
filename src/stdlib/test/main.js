// Test CLI can activate this capability from an otherwise empty entrypoint,
// before the application's normal Bun bootstrap has installed web encodings.
// Keep that prerequisite inside the capability instead of relying on user
// source to have initialized it as a side effect.
import "../../runtime_modules/bun/encoding.js";
import * as bunTest from "../../runtime_modules/bun/test.js";
import * as nodeTest from "../../runtime_modules/node/test.js";
import * as reporters from "../../runtime_modules/node/test/reporters.js";
import * as permissions from "../../runtime_modules/node/internal/permissions.js";
import * as path from "../../runtime_modules/node/path.js";
import * as picomatch from "../../runtime_modules/vendor/picomatch.js";
globalThis.__cottontailCapabilityResult = {
  namespace: bunTest,
  modules: {
    "bun/test.js": bunTest,
    "node/test.js": nodeTest,
    "node/test/reporters.js": reporters,
    "node/internal/permissions.js": permissions,
    "node/path.js": path,
    "vendor/picomatch.js": picomatch,
  },
};
