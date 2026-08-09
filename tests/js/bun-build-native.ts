import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const bytecodeRoot = mkdtempSync(join(tmpdir(), "cottontail-build-bytecode-"));
try {
  const bytecodeResult = await Bun.build({
    entrypoints: ["tests/js/fixtures/bun-build-entry.ts"],
    outdir: bytecodeRoot,
    target: "bun",
    format: "cjs",
    bytecode: true,
    banner: "// cottontail bytecode banner",
  });
  assert(bytecodeResult.success, "native Bun.build bytecode should succeed");
  assert(
    bytecodeResult.outputs.map(output => output.kind).join(",") === "entry-point,bytecode",
    "native Bun.build bytecode should return source and bytecode artifacts",
  );
  const bytecodeSource = await bytecodeResult.outputs[0].text();
  assert(
    bytecodeSource.startsWith(
      "// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {// cottontail bytecode banner",
    ),
    "native Bun.build bytecode should preserve Bun's pragma, wrapper, and banner order",
  );
  assert(
    bytecodeResult.outputs[1].path === `${bytecodeResult.outputs[0].path}.jsc`,
    "native Bun.build bytecode should use an adjacent .jsc path",
  );
  const bytecodeBytes = new Uint8Array(await bytecodeResult.outputs[1].arrayBuffer());
  assert(
    new TextDecoder().decode(bytecodeBytes.subarray(0, 8)) === "CTJSCB02",
    "native Bun.build should serialize bytecode through the stock-JSC embedder bridge",
  );
  const bytecodeRun = Bun.spawnSync({
    cmd: [process.execPath, bytecodeResult.outputs[0].path],
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(bytecodeRun.exitCode === 0, `native Bun.build bytecode output should run: ${bytecodeRun.stderr}`);
  assert(String(bytecodeRun.stdout) === "84\n", "native Bun.build bytecode output should execute its module body");

  const hashbangBannerResult = await Bun.build({
    entrypoints: ["entry.js"],
    files: {
      "entry.js": "module.exports = 1;",
    },
    outdir: join(bytecodeRoot, "hashbang-banner"),
    target: "bun",
    format: "cjs",
    bytecode: true,
    minify: { whitespace: true },
    banner: "#!/usr/bin/env bun\n// Production build",
  });
  const hashbangBannerSource = await hashbangBannerResult.outputs[0].text();
  assert(
    hashbangBannerSource.startsWith(
      "#!/usr/bin/env bun\n// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {// Production build",
    ),
    "bytecode builds should put a banner hashbang before the Bun pragma and CommonJS wrapper",
  );

  const sourceHashbangResult = await Bun.build({
    entrypoints: ["entry.js"],
    files: {
      "entry.js": '#!/usr/bin/env bun\nmodule.exports = 1;\nconsole.log("bun!");',
    },
    outdir: join(bytecodeRoot, "source-hashbang"),
    target: "bun",
    format: "cjs",
    bytecode: true,
    minify: { whitespace: true },
    banner: "// Copyright 2024 Example Corp",
  });
  const sourceHashbangSource = await sourceHashbangResult.outputs[0].text();
  assert(
    sourceHashbangSource.startsWith(
      "#!/usr/bin/env bun\n// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {// Copyright 2024 Example Corp",
    ),
    "bytecode builds should preserve a source hashbang before the Bun pragma",
  );
  const sourceHashbangRun = Bun.spawnSync({
    cmd: [process.execPath, sourceHashbangResult.outputs[0].path],
    env: { ...process.env, BUN_JSC_verboseDiskCache: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(sourceHashbangRun.exitCode === 0, `source-hashbang bytecode output should run: ${sourceHashbangRun.stderr}`);
  assert(String(sourceHashbangRun.stdout) === "bun!\n", "source-hashbang bytecode output should execute");
  assert(
    String(sourceHashbangRun.stderr).includes("[Disk Cache] Cache hit for sourceCode"),
    "source-hashbang bytecode output should evaluate the generated JSC sidecar",
  );

  const bunImportResult = await Bun.build({
    entrypoints: ["entry.ts"],
    files: {
      "entry.ts": `
        import { RedisClient } from "bun";
        import * as BunStar from "bun";
        const bunRequire = require("bun");
        console.log(RedisClient.name);
        console.log(BunStar.RedisClient.name);
        console.log(bunRequire.RedisClient.name);
      `,
    },
    outdir: join(bytecodeRoot, "bun-import"),
    target: "bun",
    format: "cjs",
    bytecode: true,
  });
  const bunImportRun = Bun.spawnSync({
    cmd: [process.execPath, bunImportResult.outputs[0].path],
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(bunImportRun.exitCode === 0, `bytecode output importing bun should run: ${bunImportRun.stderr}`);
  assert(
    String(bunImportRun.stdout) === "RedisClient\nRedisClient\nRedisClient\n",
    "bytecode output should preserve Bun namespace imports and require calls",
  );
} finally {
  rmSync(bytecodeRoot, { recursive: true, force: true });
}

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
      build.onResolve({ filter: /^virtual-entry$/ }, () => {
        lifecycle.push("resolve-first");
        return null;
      });
      build.onResolve({ filter: /^virtual-entry$/ }, ({ path }) => {
        lifecycle.push("resolve-second");
        return { path, namespace: "virtual" };
      });
      build.onLoad({ filter: /.*/ }, () => {
        throw new Error("default file namespace must not match a virtual module");
      });
      build.onLoad({ filter: /.*/, namespace: "virtual" }, ({ loader, side }) => {
        assert(loader === "js", "custom-namespace onLoad should receive the JavaScript default loader");
        assert(side === "server", "target bun onLoad should run on the server side");
        lifecycle.push("load-first");
        return null;
      });
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
assert(
  lifecycle.join(",") === "start,resolve-first,resolve-second,load-first,end",
  "plugin lifecycle hooks should run in registration order and namespace",
);
let invalidNativePluginRejected = false;
try {
  await Bun.build({
    entrypoints: ["tests/js/fixtures/bun-build-entry.ts"],
    plugins: [{
      name: "invalid-native-plugin",
      setup(build) {
        build.onBeforeParse(
          { filter: /\.ts$/ },
          { napiModule: {}, symbol: "plugin_impl" } as never,
        );
      },
    }],
  });
} catch (error) {
  invalidNativePluginRejected = String(error).includes("BUN_PLUGIN_NAME");
}
assert(invalidNativePluginRejected, "onBeforeParse should reject non-N-API modules during registration");

assert(typeof Bun.plugin.clearAll === "function", "Bun.plugin.clearAll should be exposed");
Bun.plugin({
  name: "clear-runtime-plugins",
  setup(build) {
    build.module("cottontail-clear-loaded", () => ({ loader: "object", exports: { value: 1 } }));
    build.module("cottontail-clear-pending", () => ({ loader: "object", exports: { value: 2 } }));
  },
});
const loadedPluginId = "cottontail-clear-loaded";
const pendingPluginId = "cottontail-clear-pending";
assert((await import(loadedPluginId)).value === 1, "runtime plugin module should load before clearAll");
Bun.plugin.clearAll();
let clearedPluginRejected = false;
try {
  await import(loadedPluginId);
} catch {
  clearedPluginRejected = true;
}
assert(clearedPluginRejected, "clearAll should make loaded virtual plugin modules unresolvable");
clearedPluginRejected = false;
try {
  await import(pendingPluginId);
} catch {
  clearedPluginRejected = true;
}
assert(clearedPluginRejected, "clearAll should remove pending runtime plugin registrations");

const keepNamesResult = await Bun.build({
  entrypoints: ["virtual-keep-names.js"],
  files: {
    "virtual-keep-names.js": `
      function LongFunctionName() {}
      var GH = function() {};
      var OP = class {};
      if (LongFunctionName.name !== "LongFunctionName" || GH.name !== "GH" || OP.name !== "OP") {
        throw new Error("keepNames did not preserve inferred runtime names");
      }
    `,
  },
  target: "bun",
  conditions: "development",
  minify: { identifiers: true, keepNames: true },
});

assert(keepNamesResult.success, "Bun.build should accept a single string condition");
const keepNamesSource = await keepNamesResult.outputs[0].text();
assert(keepNamesSource.includes('"LongFunctionName"'), "minify.keepNames should preserve the original function name");
assert(
  /\w+\(\s*function\s*\(\)\s*\{\s*\}\s*,\s*["']GH["']\s*\)/.test(keepNamesSource),
  "minify.keepNames should wrap an anonymous inferred-name function without naming its inner function",
);
assert(
  /\w+\(\s*class\s*\{\s*\}\s*,\s*["']OP["']\s*\)/.test(keepNamesSource),
  "minify.keepNames should wrap an anonymous inferred-name class without naming its inner class",
);
new Function(keepNamesSource)();

const inlineImportMetaResult = await Bun.build({
  entrypoints: ["virtual-inline-import-meta.js"],
  files: {
    "virtual-inline-import-meta.js": "export default import.meta.dir;",
  },
  target: "bun",
  inlineImportMetaProperties: true,
});

assert(inlineImportMetaResult.success, "Bun.build should inline import.meta properties when requested");
const inlineImportMetaSource = await inlineImportMetaResult.outputs[0].text();
assert(!inlineImportMetaSource.includes("import.meta.dir"), "inlineImportMetaProperties should replace import.meta.dir");

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
