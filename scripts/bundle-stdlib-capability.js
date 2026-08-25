import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [name, entrypoint, outputPath] = process.argv.slice(2);
if (!name || !entrypoint || !outputPath) throw new Error("usage: bundle-stdlib-capability.js NAME ENTRYPOINT OUTPUT");
let result;
try {
  const bundleCoreAliases = process.env.COTTONTAIL_BUNDLE_CORE_ALIASES === "1";
  const bundleCoreModule = process.env.COTTONTAIL_BUNDLE_CORE_MODULE === "1";
  const runtimeModules = resolve(dirname(fileURLToPath(import.meta.url)), "../src/runtime_modules");
  const coreRuntimeName = name.startsWith("core-runtime-") ? name.slice("core-runtime-".length) : null;
  const coreAliasPlugin = {
    name: "cottontail-core-runtime-aliases",
    setup(build) {
      build.onResolve({ filter: /^(?:node:)?[A-Za-z0-9_./-]+$/ }, args => {
        const raw = args.path.replace(/^node:/, "");
        if (raw.startsWith("bun:")) return;
        const candidate = resolve(runtimeModules, "node", `${raw}.js`);
        if (existsSync(candidate)) return { path: candidate };
      });
    },
  };
  const splitCoreNames = [
    "assert", "async_hooks", "buffer", "constants", "crypto", "events", "fs", "http",
    "module", "net", "path", "stream", "tls", "tty", "url", "util", "v8",
  ];
  const splitCoreExternals = splitCoreNames.flatMap(moduleName => [
    `./${moduleName}.js`,
    `../${moduleName}.js`,
    `../../node/${moduleName}.js`,
  ]).concat(["../bun/core-bootstrap.js", "../../bun/core-bootstrap.js", "node:*", "path"]);
  const selectedCoreExternals = coreRuntimeName == null
    ? splitCoreExternals
    : splitCoreExternals.filter(specifier => ![
      `./${coreRuntimeName}.js`,
      `../${coreRuntimeName}.js`,
      `../../node/${coreRuntimeName}.js`,
    ].includes(specifier));
  result = await Bun.build({
  entrypoints: [entrypoint],
  target: bundleCoreAliases ? "browser" : "bun",
  format: "cjs",
  external: bundleCoreAliases ? ["bun:*"] : bundleCoreModule ? selectedCoreExternals : ["node:*", "path"],
  plugins: bundleCoreAliases ? [coreAliasPlugin] : [],
  minify: process.env.COTTONTAIL_DEBUG_CAPABILITY_BUNDLE === "1"
    ? false
    : { whitespace: true, syntax: true, identifiers: false },
  });
} catch (error) {
  const diagnostics = error?.errors ?? error?.logs;
  if (diagnostics) throw new Error(JSON.stringify(diagnostics, null, 2));
  throw error;
}
if (!result.success) {
  const details = result.logs.map(log => log.message ?? JSON.stringify(log) ?? String(log)).join("\n");
  throw new Error(details || "Bundle failed without diagnostics");
}
const output = result.outputs.find(item => item.kind === "entry-point");
if (!output) throw new Error("capability build did not emit source");
const filename = resolve(`${name}-capability.js`);
const bundled = await output.text();
writeFileSync(outputPath, `${bundled}({},globalThis[Symbol.for("cottontail.capabilityRequire")],{exports:{}},${JSON.stringify(filename)},${JSON.stringify(resolve("."))});`);
