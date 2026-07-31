import { loadEmbeddedRuntimeModule } from "../node/module.js";

function isServerConfig(value) {
  return value &&
    value !== globalThis &&
    (typeof value.fetch === "function" || value.app !== undefined) &&
    typeof value.stop !== "function";
}

export async function startDefaultApp(entryNamespace) {
  if (!isServerConfig(entryNamespace?.default) || globalThis.__cottontailServeEverCalled) {
    return null;
  }
  const bake = loadEmbeddedRuntimeModule("bun/bake-dev-server.js");
  return bake.startDefaultApp(entryNamespace);
}
