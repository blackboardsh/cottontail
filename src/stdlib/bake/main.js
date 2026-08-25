import * as devServer from "../../runtime_modules/bun/bake-dev-server.js";
import * as production from "../../runtime_modules/bun/bake-production.js";
import * as framework from "../../runtime_modules/bun/bake-framework.js";
import * as router from "../../runtime_modules/bun/bake-framework-router.js";
import * as errors from "../../runtime_modules/bun/bake-error-report.js";
import * as sourceMap from "../../runtime_modules/bun/bake-source-map.js";
globalThis.__cottontailCapabilityResult = { namespace: devServer, modules: {
  "bun/bake-dev-server.js": devServer,
  "bun/bake-production.js": production,
  "bun/bake-framework.js": framework,
  "bun/bake-framework-router.js": router,
  "bun/bake-error-report.js": errors,
  "bun/bake-source-map.js": sourceMap,
} };
