import * as inspector from "../../runtime_modules/node/inspector.js";
import * as promises from "../../runtime_modules/node/inspector/promises.js";
globalThis.__cottontailCapabilityResult = { namespace: inspector, modules: {
  "node/inspector.js": inspector,
  "node/inspector/promises.js": promises,
} };
