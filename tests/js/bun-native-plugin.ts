import { createRequire } from "node:module";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const addonPath = process.argv[2];
assert(addonPath, "native addon path is required");
const require = createRequire(import.meta.url);
const addon = require(addonPath);
const external = addon.createState();
const filter = /\.ts$/g;

const result = await Bun.build({
  entrypoints: ["tests/js/fixtures/bun-build-entry.ts"],
  target: "bun",
  format: "esm",
  plugins: [{
    name: "native-plugin-integration",
    setup(build) {
      build.onBeforeParse(
        { filter },
        { napiModule: addon, symbol: "native_observe", external },
      );
      build.onBeforeParse(
        { filter },
        { napiModule: addon, symbol: "native_transform", external },
      );
      build.onBeforeParse(
        { filter },
        { napiModule: addon, symbol: "native_after_transform", external },
      );
    },
  }],
});

assert(result.success, "native plugin build should succeed");
assert(/nativeValue\s*=\s*42/.test(await result.outputs[0].text()), "native source should reach the bundler");
assert(filter.lastIndex === 0, "native plugin filters should not leak RegExp state");

const counts = addon.stateCounts(external);
assert(counts.observed === 1, "the first native callback should run");
assert(counts.transformed === 1, "the transforming native callback should run");
assert(counts.afterTransform === 0, "callbacks after the first replacement should not run");
assert(counts.sawResetSource === 1, "later callbacks should receive the reset fetched source");
assert(counts.cleanups === 1, "plugin-owned source context should be freed exactly once");

const bypassExternal = addon.createState();
const onLoadResult = await Bun.build({
  entrypoints: ["tests/js/fixtures/bun-build-entry.ts"],
  plugins: [{
    name: "on-load-precedes-native",
    setup(build) {
      build.onLoad({ filter: /bun-build-entry\.ts$/ }, () => ({
        contents: "export const onLoadValue = 7;",
        loader: "js",
      }));
      build.onBeforeParse(
        { filter: /bun-build-entry\.ts$/ },
        { napiModule: addon, symbol: "native_observe", external: bypassExternal },
      );
    },
  }],
});
assert(/onLoadValue\s*=\s*7/.test(await onLoadResult.outputs[0].text()), "onLoad contents should be bundled");
assert(addon.stateCounts(bypassExternal).observed === 0, "onLoad contents should bypass native onBeforeParse");

const invalidFree = await Bun.build({
  entrypoints: ["tests/js/fixtures/bun-build-entry.ts"],
  throw: false,
  plugins: [{
    name: "native-invalid-free",
    setup(build) {
      build.onBeforeParse(
        { filter: /\.ts$/ },
        { napiModule: addon, symbol: "native_invalid_free" },
      );
    },
  }],
});
assert(!invalidFree.success, "an invalid native free contract should fail the build");
assert(
  invalidFree.logs.some(log => log.message.includes("free_plugin_source_code_context")),
  "an invalid native free contract should produce Bun's diagnostic",
);

let missingSymbolRejected = false;
try {
  await Bun.build({
    entrypoints: ["native-missing-symbol"],
    plugins: [{
      name: "native-missing-symbol",
      setup(build) {
        build.onBeforeParse({ filter: /.*/ }, { napiModule: addon, symbol: "missing_symbol" });
      },
    }],
  });
} catch (error) {
  missingSymbolRejected = String(error).includes('Could not find the symbol "missing_symbol"');
}
assert(missingSymbolRejected, "missing native symbols should fail during registration");

let invalidExternalRejected = false;
try {
  await Bun.build({
    entrypoints: ["native-invalid-external"],
    plugins: [{
      name: "native-invalid-external",
      setup(build) {
        build.onBeforeParse(
          { filter: /.*/ },
          { napiModule: addon, symbol: "native_observe", external: {} },
        );
      },
    }],
  });
} catch (error) {
  invalidExternalRejected = String(error).includes("Expected external (3rd argument) to be a NAPI external");
}
assert(invalidExternalRejected, "invalid native externals should fail during registration");

console.log("bun native plugin passed");
