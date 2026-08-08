import { loadEmbeddedRuntimeModule } from "../node/module.js";

function isServerConfig(value) {
  return value &&
    value !== globalThis &&
    (typeof value.fetch === "function" || value.app !== undefined) &&
    typeof value.stop !== "function";
}

export async function startDefaultApp(entryNamespace) {
  // Bun only auto-serves a module's default export for `bun run <file>` /
  // `bun <file>`, never under `bun test`. A test file may legitimately have a
  // serve-config default export (e.g. bun-types/fixture/serve-types.test.ts),
  // and eagerly serving it would bind the default port before the tests run,
  // failing every subsequent Bun.serve() with "Address already in use".
  if (globalThis.__cottontailBunTestHeaderPrinted === true) {
    return null;
  }
  if (!isServerConfig(entryNamespace?.default) || globalThis.__cottontailServeEverCalled) {
    return null;
  }
  const bake = loadEmbeddedRuntimeModule("bun/bake-dev-server.js");
  return bake.startDefaultApp(entryNamespace);
}
