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

const aliasTarget = `${import.meta.dir}/fixtures/bun-build-alias-target.ts`;
const aliasResult = await Bun.build({
  entrypoints: ["tests/js/fixtures/bun-build-alias-entry.ts"],
  target: "bun",
  format: "esm",
  alias: {
    "cottontail-build-alias": aliasTarget,
  },
});

assert(aliasResult.success, "native Bun.build aliases should succeed");
const aliasSource = await aliasResult.outputs[0].text();
assert(aliasSource.includes("cottontail-alias-target"), "Bun.build should bundle the aliased module");
assert(!aliasSource.includes("cottontail-build-alias"), "Bun.build should not preserve the original bare alias");

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

const nullCommonJSResult = await Bun.build({
  entrypoints: ["virtual-null-entry.js"],
  files: {
    "virtual-null-entry.js": `
      import value from "./null-export.cjs";
      if (value !== null) throw new Error("CommonJS null export was not preserved");
    `,
    "null-export.cjs": "module.exports = null;",
  },
  target: "bun",
  format: "cjs",
});

assert(nullCommonJSResult.success, "Bun.build should bundle a CommonJS module that exports null");
const nullCommonJSSource = await nullCommonJSResult.outputs[0].text();
const nullCommonJSFactory = (0, eval)(nullCommonJSSource);
assert(typeof nullCommonJSFactory === "function", "CommonJS build output should evaluate to a module factory");
const nullCommonJSModule = { exports: {} };
nullCommonJSFactory(nullCommonJSModule.exports, () => {}, nullCommonJSModule, "virtual-null-entry.js", import.meta.dir);

console.log("bun build native passed");
