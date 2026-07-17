function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const result = await Bun.build({
  entrypoints: ["tests/js/fixtures/bun-build-entry.ts"],
  target: "bun",
  format: "esm",
});

assert(result.success, "native Bun.build should succeed");
assert(result.outputs.length === 1, "native Bun.build should return one output");
assert(result.outputs[0] instanceof Blob, "native Bun.build should return BuildArtifact blobs");
const source = await result.outputs[0].text();
assert(source.includes("var rexported = 42"), "native Bun.build should include imported modules");
assert(source.includes("var doubled = rexported * 2"), "native Bun.build should transpile TypeScript");

const lifecycle: string[] = [];
const pluginResult = await Bun.build({
  entrypoints: ["virtual-entry"],
  target: "bun",
  plugins: [{
    name: "virtual-module",
    setup(build) {
      build.onStart(() => lifecycle.push("start"));
      build.onResolve({ filter: /^virtual-entry$/ }, ({ path }) => ({ path, namespace: "virtual" }));
      build.onLoad({ filter: /.*/, namespace: "virtual" }, () => ({
        contents: "const answer: number = 42; console.log(answer);",
        loader: "ts",
      }));
      build.onEnd((output) => lifecycle.push(output.success ? "end" : "failed"));
    },
  }],
});

assert(pluginResult.success, "native Bun.build plugins should succeed");
assert(pluginResult.outputs[0] instanceof Blob, "plugin builds should return BuildArtifact blobs");
assert((await pluginResult.outputs[0].text()).includes("var answer = 42"), "onLoad output should be transpiled");
assert(lifecycle.join(",") === "start,end", "plugin lifecycle hooks should run in order");

const keepNamesResult = await Bun.build({
  entrypoints: ["virtual-keep-names.js"],
  files: {
    "virtual-keep-names.js": "function LongFunctionName() {}; console.log(LongFunctionName.name);",
  },
  target: "bun",
  conditions: "development",
  minify: { identifiers: true, keepNames: true },
});

assert(keepNamesResult.success, "Bun.build should accept a single string condition");
const keepNamesSource = await keepNamesResult.outputs[0].text();
assert(keepNamesSource.includes('"LongFunctionName"'), "minify.keepNames should preserve the original function name");

console.log("bun build native passed");
