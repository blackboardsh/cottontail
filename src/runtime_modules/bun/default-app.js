import { loadEmbeddedRuntimeModule } from "../node/module.js";

const testRegisteredKey = Symbol.for("cottontail.internal.testRegistered");

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
  // Test registration happens while the entry module is loading, before the
  // runner gets a chance to print its header. Treat any registration signal as
  // test execution so that this post-import hook cannot serve a test file's
  // default export in that interval.
  if (globalThis.__cottontailBunTestHeaderPrinted === true ||
      globalThis.__cottontailBunTestUsed === true ||
      globalThis[testRegisteredKey] === true) {
    return null;
  }
  if (!isServerConfig(entryNamespace?.default) || globalThis.__cottontailServeEverCalled) {
    return null;
  }
  const bake = loadEmbeddedRuntimeModule("bun/bake-dev-server.js");
  return bake.startDefaultApp(entryNamespace);
}
