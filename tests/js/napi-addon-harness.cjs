"use strict";

const { resolve } = require("node:path");

if (!process.argv[2]) throw new Error("usage: napi-addon-harness.cjs <test-file>");
if (typeof cottontail?.nativeAddonLoad !== "function") throw new Error("native addon bridge is unavailable");
for (const name of [
  "addEventListener", "alert", "confirm", "dispatchEvent", "postMessage", "prompt",
  "removeEventListener", "reportError", "BuildError", "BuildMessage", "HTMLRewriter",
  "ResolveError", "ResolveMessage", "ErrorEvent", "Worker", "onmessage", "onerror",
]) {
  if (!(name in globalThis)) globalThis[name] = undefined;
}

require(resolve(process.argv[2]));
