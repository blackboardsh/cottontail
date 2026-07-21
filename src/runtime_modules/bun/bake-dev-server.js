import path from "../node/path.js";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "../node/fs.js";
import { pathToFileURL } from "../node/url.js";
import { Bun, serve } from "./index.js";
import { FrameworkRouter } from "./bake-framework-router.js";

const bakeStateSymbol = Symbol.for("cottontail.bake.dev-server-state");

function bakeState() {
  return globalThis[bakeStateSymbol] ??= {
    activeServer: null,
    deinitCount: 0,
  };
}

function isServerConfig(value) {
  return value &&
    value !== globalThis &&
    (typeof value.fetch === "function" || value.app !== undefined) &&
    typeof value.stop !== "function";
}

function isHtmlAsset(value) {
  return (typeof value === "string" && /\.html?$/i.test(value)) ||
    (value && typeof value === "object" && typeof value.index === "string" && Array.isArray(value.files));
}

function isBakeConfig(config) {
  if (config.app !== undefined) return true;
  for (const routes of [config.static, config.routes]) {
    if (routes && typeof routes === "object" && Object.values(routes).some(isHtmlAsset)) return true;
  }
  return false;
}

function normalizeBakeRoutes(config) {
  const routes = { ...(config.routes ?? {}) };
  const staticRoutes = { ...(config.static ?? {}) };

  // Bake permits request handlers in `static`, while Bun.serve's ordinary
  // static table is asset-only. Normalize this for development and production.
  for (const [pattern, value] of Object.entries(staticRoutes)) {
    if (typeof value !== "function") continue;
    routes[pattern] = value;
    delete staticRoutes[pattern];
  }

  return { ...config, routes, static: staticRoutes };
}

function bakeClientVersion() {
  return String(globalThis.Bun?.version ?? "1.3.10");
}

const bakeLiveReloadClient = `<script type="module" data-cottontail-bake-runtime>
const socketUrl = new URL("/_bun/hmr", location.href);
socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);
socket.binaryType = "arraybuffer";
let versionSeen = false;
socket.addEventListener("open", () => {
  console.info("[Bun] Hot-module-reloading socket connected, waiting for changes...");
  socket.send("n");
});
socket.addEventListener("message", event => {
  const data = event.data;
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  const id = bytes[0];
  if (id === 86) {
    if (versionSeen) window.location.reload();
    versionSeen = true;
    return;
  }
  if (id !== 117) return;
  if (bytes.length <= 17) {
    window.location.reload();
    return;
  }
  try {
    (0, eval)(new TextDecoder().decode(bytes.subarray(17)));
  } catch (error) {
    console.error(error);
    window.location.reload();
  }
});
</script>`;

function withBakeLiveReloadClient(html) {
  const insertion = html.search(/<\/body\s*>/i);
  if (insertion >= 0) return `${html.slice(0, insertion)}${bakeLiveReloadClient}${html.slice(insertion)}`;
  return `${html}${bakeLiveReloadClient}`;
}

async function loadBakeStaticConfig(projectRoot) {
  const bunfigPath = path.join(projectRoot, "bunfig.toml");
  try {
    if (!statSync(bunfigPath).isFile()) return {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }

  // Use the vendored compiler's TOML loader. Besides keeping this path aligned
  // with Bun's parser, it supports multiline inline tables used by bunfig.toml.
  const result = await Bun.build({
    entrypoints: [bunfigPath],
    target: "bun",
    format: "cjs",
    write: false,
    throw: false,
  });
  if (!result.success) {
    throw new AggregateError(result.logs ?? [], `Failed to parse ${bunfigPath}`);
  }
  const artifact = result.outputs.find(output => output.kind === "entry-point");
  if (!artifact) throw new Error(`Bun's TOML loader did not emit ${bunfigPath}`);
  const parsed = executeCommonJSArtifact(await artifact.text(), bunfigPath);
  const config = parsed?.serve?.static;
  return config && typeof config === "object" ? config : {};
}

function bakeBuildErrors(logs, fallbackPath) {
  return logs.map(log => ({
    file: path.basename(log.position?.file || fallbackPath),
    line: Number(log.position?.line || 0),
    column: Number(log.position?.column || 0),
    level: String(log.level || "error"),
    message: String(log.message || log),
  }));
}

const bakeSetErrorsClientSource = `(errors => {
  const symbol = Symbol.for("cottontail.bake.set-errors");
  let setErrors = globalThis[symbol];
  if (!setErrors) {
    let host = document.querySelector("bun-hmr");
    if (!host) {
      host = document.createElement("bun-hmr");
      document.body.append(host);
    }
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    setErrors = nextErrors => {
      host.style.display = nextErrors.length > 0 ? "block" : "none";
      root.replaceChildren();
      for (const error of nextErrors) {
        const group = document.createElement("div");
        group.className = "b-group";
        const file = document.createElement("span");
        file.className = "file-name";
        file.textContent = error.file;
        group.append(file);
        const message = document.createElement("div");
        message.className = "b-msg";
        const label = document.createElement("span");
        label.className = "log-label";
        label.textContent = error.level;
        const text = document.createElement("span");
        text.className = "log-text";
        text.textContent = error.message;
        message.append(label, text);
        if (error.line > 0) {
          const gutter = document.createElement("span");
          gutter.className = "gutter";
          gutter.textContent = String(error.line);
          const highlight = document.createElement("span");
          highlight.className = "highlight-wrap";
          const space = document.createElement("span");
          space.className = "space";
          space.textContent = " ".repeat(Math.max(0, error.column - 1));
          highlight.append(space);
          message.append(gutter, highlight);
        }
        group.append(message);
        root.append(group);
      }
    };
    globalThis[symbol] = setErrors;
  }
  setErrors(errors);
})`;

function bakeBuildErrorPage(errors) {
  const serialized = JSON.stringify(errors).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head></head><body>
<script type="module">
${bakeSetErrorsClientSource}(${serialized});
</script>
${bakeLiveReloadClient}
</body></html>`;
}

function matchesHtmlRoute(pattern, pathname) {
  if (pattern === pathname) return true;
  if (pattern === "/*") return true;
  if (!pattern.endsWith("/*")) return false;
  const prefix = pattern.slice(0, -2);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function outputAssetPath(outdir, artifact, publicPath) {
  const relative = path.relative(outdir, artifact.path).replaceAll(path.sep, "/").replace(/^\.\//, "");
  const prefix = normalizePrefix(publicPath);
  return prefix === "/" ? `/${relative}` : `${prefix}/${relative}`;
}

function isJavaScriptEntry(artifact) {
  return artifact.kind === "entry-point" && ["js", "jsx", "ts", "tsx"].includes(artifact.loader);
}

function isJavaScriptArtifact(artifact) {
  return ["js", "jsx", "ts", "tsx"].includes(artifact.loader);
}

async function sourceEntryForArtifact(artifact, projectRoot) {
  if (!artifact.sourcemap) return null;
  let sourceMap;
  try {
    sourceMap = JSON.parse(await artifact.sourcemap.text());
  } catch {
    return null;
  }
  const sourceRoot = typeof sourceMap.sourceRoot === "string" ? sourceMap.sourceRoot : "";
  // Bundled sourcemaps list dependencies before the entry module. Walk them
  // backwards so the internal Bake rebuild starts at the original entry.
  for (const source of [...(sourceMap.sources ?? [])].reverse()) {
    if (typeof source !== "string" || source.startsWith("bun:") || source.includes("://")) continue;
    const candidates = [
      path.resolve(projectRoot, sourceRoot, source),
      path.resolve(path.dirname(artifact.sourcemap.path), sourceRoot, source),
    ];
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function metafileInputPath(projectRoot, inputPath) {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(projectRoot, inputPath);
}

function htmlJavaScriptEntries(metafile, htmlPath, projectRoot) {
  for (const [inputPath, input] of Object.entries(metafile?.inputs ?? {})) {
    if (metafileInputPath(projectRoot, inputPath) !== htmlPath) continue;
    return (input.imports ?? [])
      .map(item => metafileInputPath(projectRoot, item.path))
      .filter(entryPath => isJavaScriptArtifact({ loader: loaderForPath(entryPath) }));
  }
  return [];
}

function sourceEntryForMetafileArtifact(metafile, artifact, outdir, projectRoot, htmlEntries) {
  for (const [outputPath, output] of Object.entries(metafile?.outputs ?? {})) {
    if (path.resolve(outdir, outputPath) !== path.normalize(artifact.path)) continue;
    for (const inputPath of Object.keys(output.inputs ?? {})) {
      const absoluteInput = metafileInputPath(projectRoot, inputPath);
      if (htmlEntries.includes(absoluteInput)) return absoluteInput;
    }
  }
  return null;
}

async function buildInternalBakeEntry(entryPath, outdir, buildConfig) {
  const result = await Bun.build({
    entrypoints: [entryPath],
    target: "browser",
    outdir,
    publicPath: buildConfig.publicPath ?? "/",
    write: false,
    format: "internal_bake_dev",
    minify: false,
    sourcemap: "external",
    define: buildConfig.define,
    env: buildConfig.env,
    throw: false,
  });
  if (!result.success) {
    throw new AggregateError(result.logs ?? [], `Failed to build Bake browser entry ${entryPath}`);
  }
  const artifact = result.outputs.find(isJavaScriptEntry);
  if (!artifact) throw new Error(`Bake's internal build did not emit ${entryPath}`);
  return artifact;
}

function bakeRegistrySource(source) {
  const start = source.indexOf("\n  // ", 8);
  const end = source.lastIndexOf("\n}, {\n  main: ");
  if (start < 0 || end <= start) {
    throw new SyntaxError("Bake's internal browser bundle is missing its module registry");
  }
  return source.slice(start, end);
}

function bakeRegistryModules(source) {
  return (0, eval)(`({${bakeRegistrySource(source)}\n})`);
}

function bakeModuleDefinitionSource(value) {
  if (typeof value === "function") return value.toString();
  if (Array.isArray(value)) return `[${value.map(bakeModuleDefinitionSource).join(",")}]`;
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function createBakeJavaScriptPacket(code) {
  const codeBytes = new TextEncoder().encode(code);
  const packet = new Uint8Array(17 + codeBytes.length);
  const view = new DataView(packet.buffer);
  packet[0] = "u".charCodeAt(0);
  view.setInt32(1, -1, true);
  view.setInt32(5, -1, true);
  view.setUint32(9, 0, true);
  view.setUint32(13, codeBytes.length, true);
  packet.set(codeBytes, 17);
  return packet;
}

function createBakeHotUpdatePacket(modules, scriptId) {
  const registry = Object.entries(modules)
    .map(([id, definition]) => `${JSON.stringify(id)}:${bakeModuleDefinitionSource(definition)}`)
    .join(",\n");
  return createBakeJavaScriptPacket(
    `globalThis[Symbol.for("bun:hmr")]({${registry}\n}, ${JSON.stringify(scriptId)})\n` +
    `//# sourceMappingURL=/_bun/client/${scriptId}.js.map\n`,
  );
}

function createBakeErrorUpdatePacket(errors, scriptId) {
  return createBakeJavaScriptPacket(
    `${bakeSetErrorsClientSource}(${JSON.stringify(errors)});\n` +
    `globalThis[Symbol.for("bun:hmr")]?.({}, ${JSON.stringify(scriptId)});\n` +
    `//# sourceMappingURL=/_bun/client/${scriptId}.js.map\n`,
  );
}

function changedPathMatchesModule(projectRoot, changedPaths, moduleId) {
  const cleanId = String(moduleId).split(/[?#]/, 1)[0];
  if (!cleanId || cleanId.startsWith("bun:")) return false;
  const modulePath = path.isAbsolute(cleanId) ? path.normalize(cleanId) : path.resolve(projectRoot, cleanId);
  for (const changedPath of changedPaths) {
    if (modulePath === path.resolve(projectRoot, changedPath)) return true;
  }
  return false;
}

function createHtmlDispatcher(config, development) {
  const projectRoot = globalThis.process?.cwd?.() ?? ".";
  const routes = { ...(config.routes ?? {}) };
  const staticRoutes = { ...(config.static ?? {}) };
  const htmlRoutes = [];

  for (const routeTable of [staticRoutes, routes]) {
    for (const [pattern, value] of Object.entries(routeTable)) {
      if (!isHtmlAsset(value)) continue;
      const htmlPath = typeof value === "string" ? value : value.index;
      htmlRoutes.push({ pattern, path: path.resolve(projectRoot, htmlPath) });
      delete routeTable[pattern];
    }
  }
  if (htmlRoutes.length === 0) return null;

  const bundles = new Map();
  const successfulBundles = new Map();
  const assets = new Map();
  const retiredAssets = new Set();
  const staticConfig = loadBakeStaticConfig(projectRoot);
  let buildId = 0;
  let hotUpdateId = 0;

  function nextHotUpdateId() {
    hotUpdateId = (hotUpdateId + 1) >>> 0;
    return hotUpdateId.toString(16).padStart(16, "0");
  }

  async function buildHtml(htmlPath) {
    let pending = bundles.get(htmlPath);
    if (pending) return pending;
    pending = (async () => {
      const buildConfig = await staticConfig;
      const sourceText = await Bun.file(htmlPath).text();
      const outdir = path.join(projectRoot, ".cottontail-tmp", "bake-html", String(buildId++));
      const result = await Bun.build({
        entrypoints: [htmlPath],
        target: "browser",
        outdir,
        publicPath: buildConfig.publicPath ?? "/",
        write: false,
        minify: buildConfig.minify ?? !development,
        sourcemap: development ? "external" : "none",
        define: buildConfig.define,
        env: buildConfig.env,
        metafile: true,
        throw: false,
      });
      if (!result.success) {
        if (development) {
          const errors = bakeBuildErrors(result.logs ?? [], htmlPath);
          return {
            body: bakeBuildErrorPage(errors),
            sourceText,
            hmrEntries: [],
            buildError: true,
            errors,
          };
        }
        throw new AggregateError(result.logs ?? [], `Failed to bundle Bake HTML route ${htmlPath}`);
      }

      let htmlArtifact = null;
      const hmrEntries = [];
      const htmlEntries = htmlJavaScriptEntries(result.metafile, htmlPath, projectRoot);
      const supportsInternalHmr = !result.outputs.some(output => output.kind === "asset" && output.loader === "file");
      for (const artifact of result.outputs) {
        if (artifact.loader === "html" && artifact.kind === "entry-point") {
          htmlArtifact = artifact;
          continue;
        }
        const assetPath = outputAssetPath(outdir, artifact, buildConfig.publicPath);
        let servedArtifact = artifact;
        if (development && buildConfig.hmr !== false && supportsInternalHmr && isJavaScriptArtifact(artifact)) {
          const entryPath = sourceEntryForMetafileArtifact(
            result.metafile,
            artifact,
            outdir,
            projectRoot,
            htmlEntries,
          ) ?? await sourceEntryForArtifact(artifact, projectRoot);
          if (entryPath) {
            let internalArtifact;
            try {
              internalArtifact = await buildInternalBakeEntry(entryPath, outdir, buildConfig);
            } catch (error) {
              if (error instanceof AggregateError) {
                const errors = bakeBuildErrors(error.errors ?? [], entryPath);
                return {
                  body: bakeBuildErrorPage(errors),
                  sourceText,
                  hmrEntries: [],
                  buildError: true,
                  errors,
                };
              }
              throw error;
            }
            const source = await internalArtifact.text();
            servedArtifact = internalArtifact;
            hmrEntries.push({
              entryPath,
              assetPath,
              source,
              modules: bakeRegistryModules(source),
            });
          }
        }
        retiredAssets.delete(assetPath);
        assets.set(assetPath, servedArtifact);
      }
      if (htmlArtifact === null) {
        throw new Error(`Bake's HTML build did not emit an HTML entry point for ${htmlPath}`);
      }
      const body = development && buildConfig.hmr !== false && hmrEntries.length === 0
        ? withBakeLiveReloadClient(await htmlArtifact.text())
        : development ? await htmlArtifact.text() : htmlArtifact;
      return { body, sourceText, hmrEntries, buildError: false, errors: [] };
    })();
    bundles.set(htmlPath, pending);
    try {
      return await pending;
    } catch (error) {
      bundles.delete(htmlPath);
      throw error;
    }
  }

  const dispatchHtmlRequest = async request => {
    const pathname = new URL(request.url).pathname;
    const asset = assets.get(pathname);
    if (asset) {
      return new Response(asset, {
        headers: { "content-type": asset.type || "application/octet-stream" },
      });
    }
    if (retiredAssets.has(pathname)) return new Response("Not Found", { status: 404 });
    for (const route of htmlRoutes) {
      if (!matchesHtmlRoute(route.pattern, pathname)) continue;
      const bundle = await buildHtml(route.path);
      if (!bundle.buildError) successfulBundles.set(route.path, bundle);
      return new Response(bundle.body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("Not Found", { status: 404 });
  };
  dispatchHtmlRequest.projectRoot = projectRoot;
  dispatchHtmlRequest.serveConfig = { ...config, routes, static: staticRoutes };
  dispatchHtmlRequest.invalidate = () => {
    bundles.clear();
    for (const assetPath of assets.keys()) retiredAssets.add(assetPath);
    assets.clear();
  };
  dispatchHtmlRequest.update = async (changedPaths = []) => {
    const activePaths = [...bundles.keys()];
    const previousBundles = new Map();
    for (const htmlPath of activePaths) previousBundles.set(htmlPath, await bundles.get(htmlPath));

    dispatchHtmlRequest.invalidate();
    let hardReload = activePaths.length === 0;
    const packets = [];
    for (const htmlPath of activePaths) {
      const previous = previousBundles.get(htmlPath);
      const previousSuccessful = successfulBundles.get(htmlPath);
      const next = await buildHtml(htmlPath);
      if (next.buildError) {
        packets.push(createBakeErrorUpdatePacket(next.errors, nextHotUpdateId()));
        continue;
      }
      if (!previousSuccessful || previousSuccessful.sourceText !== next.sourceText ||
          previousSuccessful.hmrEntries.length === 0 || next.hmrEntries.length === 0) {
        hardReload = true;
        successfulBundles.set(htmlPath, next);
        continue;
      }
      if (previous?.buildError) {
        packets.push(createBakeErrorUpdatePacket([], nextHotUpdateId()));
      }
      for (const entry of next.hmrEntries) {
        const previousEntry = previousSuccessful.hmrEntries.find(item => item.entryPath === entry.entryPath);
        if (!previousEntry) {
          hardReload = true;
          continue;
        }
        const changedModules = {};
        for (const [id, definition] of Object.entries(entry.modules)) {
          const previousDefinition = previousEntry.modules[id];
          if (changedPathMatchesModule(projectRoot, changedPaths, id) ||
              moduleDefinitionSignature(previousDefinition) !== moduleDefinitionSignature(definition)) {
            changedModules[id] = definition;
          }
        }
        if (Object.keys(changedModules).length > 0) {
          packets.push(createBakeHotUpdatePacket(changedModules, nextHotUpdateId()));
        }
      }
      successfulBundles.set(htmlPath, next);
    }
    return { hardReload, packets };
  };
  return dispatchHtmlRequest;
}

function normalizePrefix(value) {
  let prefix = value == null ? "/" : String(value);
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  while (prefix.length > 1 && prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  return prefix;
}

function pathnameForRouter(pathname, prefix) {
  if (prefix === "/") return pathname;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length) || "/";
}

function resolveImportSource(projectRoot, source) {
  const value = String(source);
  if (path.isAbsolute(value)) return value;
  if (value.startsWith("./") || value.startsWith("../")) return path.resolve(projectRoot, value);
  return value;
}

function serverBuildOptions(framework, app) {
  const frameworkOptions = framework.bundlerOptions ?? {};
  const appOptions = app.bundlerOptions ?? {};
  const options = {
    ...frameworkOptions,
    ...(frameworkOptions.server ?? {}),
    ...appOptions,
    ...(appOptions.server ?? {}),
  };
  delete options.client;
  delete options.server;
  delete options.ssr;
  return options;
}

function loaderForPath(value) {
  const match = /\.([a-zA-Z0-9]+)(?:[?#].*)?$/.exec(String(value));
  switch ((match?.[1] ?? "").toLowerCase()) {
    case "js":
    case "mjs":
    case "cjs": return "js";
    case "ts":
    case "mts":
    case "cts": return "ts";
    case "jsx": return "jsx";
    case "tsx": return "tsx";
    case "css": return "css";
    case "html":
    case "htm": return "html";
    case "json": return "json";
    case "toml": return "toml";
    case "txt": return "text";
    case "wasm": return "wasm";
    default: return "file";
  }
}

function adaptServerPlugins(plugins) {
  return plugins.map(plugin => ({
    ...plugin,
    setup(build) {
      let adapted;
      adapted = new Proxy(build, {
        get(target, property, receiver) {
          if (property === "onLoad") {
            return (constraints, callback) => {
              target.onLoad(constraints, args => callback({
                ...args,
                loader: args.loader ?? loaderForPath(args.path),
                side: "server",
              }));
              return adapted;
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return plugin.setup(adapted);
    },
  }));
}

function routeFiles(route) {
  const layouts = [];
  let current = route;
  const page = current?.page;
  while (current) {
    if (current.layout) layouts.push(current.layout);
    current = current.parent;
  }
  return { page, layouts };
}

function executeCommonJSArtifact(source, filename) {
  const sourceUrl = pathToFileURL(filename).href.replaceAll("\n", "");
  const factory = (0, eval)(`${source}\n//# sourceURL=${sourceUrl}`);
  if (typeof factory !== "function") throw new TypeError("Bake's server bundle did not produce a CommonJS factory");
  const module = { exports: {} };
  factory(module.exports, globalThis.require, module, filename, path.dirname(filename));
  return module.exports;
}

function bakeBuiltinNamespace(specifier) {
  const value = globalThis.require(specifier);
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return { default: value };
  }
  if (Object.prototype.hasOwnProperty.call(value, "default")) return value;

  const namespace = Object.create(null);
  Object.defineProperty(namespace, "default", { enumerable: true, value });
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "default") continue;
    Object.defineProperty(namespace, key, {
      configurable: true,
      enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? true,
      get: () => value[key],
    });
  }
  return namespace;
}

function commonJSRouteWrapperSource(serverEntryPoint, page, layouts) {
  const imports = [
    `import * as __ctServer from ${JSON.stringify(serverEntryPoint)};`,
    `import * as __ctPage from ${JSON.stringify(page)};`,
    ...layouts.map((layout, index) => `import * as __ctLayout${index} from ${JSON.stringify(layout)};`),
  ];
  const layoutNames = layouts.map((_, index) => `__ctLayout${index}`).join(", ");
  return `${imports.join("\n")}
export async function render(request, metadata) {
  const render = __ctServer.render ?? __ctServer.default;
  if (typeof render !== "function") {
    throw new TypeError("Bake server entrypoint must export a render function");
  }
  return render(request, {
    ...metadata,
    pageModule: __ctPage,
    layouts: [${layoutNames}],
  });
}`;
}

function hmrRouteWrapperSource(serverEntryPoint, page, layouts) {
  const imports = [
    `import * as __ctServer from ${JSON.stringify(serverEntryPoint)};`,
    `import * as __ctPage from ${JSON.stringify(page)};`,
    ...layouts.map((layout, index) => `import * as __ctLayout${index} from ${JSON.stringify(layout)};`),
  ];
  const moduleNames = ["__ctServer", "__ctPage", ...layouts.map((_, index) => `__ctLayout${index}`)];
  return `${imports.join("\n")}
export const __cottontailBakeModules = [${moduleNames.join(", ")}];`;
}

function parseHmrArtifact(source) {
  const registryStart = source.indexOf("\n  // ", 8);
  if (registryStart < 0) throw new SyntaxError("Bake's HMR bundle is missing its module registry");
  const factory = (0, eval)(source.slice(0, registryStart));
  if (typeof factory !== "function") throw new TypeError("Bake's HMR runtime did not produce a factory");
  const registrySource = source.slice(registryStart);
  const invocationEnd = registrySource.lastIndexOf(");");
  if (invocationEnd < 0) throw new SyntaxError("Bake's HMR bundle is missing its invocation trailer");
  const [modules, bundleConfig] = (0, eval)(`[{${registrySource.slice(0, invocationEnd)}]`);
  return { factory, modules, bundleConfig };
}

function moduleDefinitionSignature(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "function" ? item.toString() : item);
}

function moduleDependencyIds(definition) {
  const encoded = definition?.[0];
  if (!Array.isArray(encoded)) throw new TypeError("Bake's HMR entry module has no dependency table");
  const ids = [];
  for (let index = 0; index < encoded.length;) {
    ids.push(encoded[index]);
    index += 2 + encoded[index + 1];
  }
  return ids;
}

function createFrameworkDispatcher(config) {
  const app = config.app;
  const framework = app?.framework;
  if (!app || !framework || typeof framework !== "object") return null;

  const projectRoot = globalThis.process?.cwd?.() ?? ".";
  const plugins = adaptServerPlugins([...(framework.plugins ?? []), ...(app.plugins ?? [])]);
  const buildOptions = serverBuildOptions(framework, app);
  const development = globalThis.process?.env?.NODE_ENV !== "production";
  const bundles = new Map();
  const wrapperPaths = new Map();
  const hmrDefinitions = new Map();
  let hmrRuntime = null;
  let wrapperId = 0;
  const routerTypes = framework.fileSystemRouterTypes ?? [];
  const createRouters = () => routerTypes.map(type => {
    const root = path.resolve(projectRoot, String(type.root));
    return {
      type,
      prefix: normalizePrefix(type.prefix),
      router: new FrameworkRouter({ root, style: type.style }),
      serverEntryPoint: resolveImportSource(projectRoot, type.serverEntryPoint),
    };
  });
  let routers = createRouters();

  async function bundleRoute(router, matched) {
    const { page, layouts } = routeFiles(matched.route);
    if (!page) return null;
    let pending = bundles.get(page);
    if (pending) return pending;

    pending = (async () => {
      let wrapperPath = wrapperPaths.get(page);
      if (!wrapperPath) {
        wrapperPath = path.join(projectRoot, `.cottontail-bake-route-${wrapperId++}.ts`);
        wrapperPaths.set(page, wrapperPath);
      }
      const result = await Bun.build({
        ...buildOptions,
        entrypoints: [wrapperPath],
        files: {
          ...(buildOptions.files ?? {}),
          [wrapperPath]: development
            ? hmrRouteWrapperSource(router.serverEntryPoint, page, layouts)
            : commonJSRouteWrapperSource(router.serverEntryPoint, page, layouts),
        },
        format: development ? "internal_bake_dev" : "cjs",
        minify: development ? false : buildOptions.minify,
        target: "bun",
        plugins,
      });
      if (!result.success || result.outputs.length === 0) {
        throw new AggregateError(result.logs ?? [], `Failed to bundle Bake route ${page}`);
      }
      const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
      if (development) {
        const parsed = parseHmrArtifact(await artifact.text());
        if (hmrRuntime === null) {
          hmrRuntime = parsed.factory(framework.serverComponents?.separateSSRGraph === true, {
            require: globalThis.require,
            resolve: specifier => specifier,
            bakeBuiltin: bakeBuiltinNamespace,
            url: pathToFileURL(`${projectRoot}${path.sep}`).href,
          });
          if (typeof hmrRuntime?.handleRequest !== "function" || typeof hmrRuntime?.registerUpdate !== "function") {
            throw new TypeError("Bake's server HMR runtime is missing its host exports");
          }
        }

        const changedModules = {};
        for (const [id, definition] of Object.entries(parsed.modules)) {
          const signature = moduleDefinitionSignature(definition);
          if (hmrDefinitions.get(id) === signature) continue;
          hmrDefinitions.set(id, signature);
          changedModules[id] = definition;
        }
        await hmrRuntime.registerUpdate(changedModules, null, null);

        const entryDefinition = parsed.modules[parsed.bundleConfig.main];
        const [serverId, pageId, ...layoutIds] = moduleDependencyIds(entryDefinition);
        if (!serverId || !pageId) throw new TypeError("Bake's HMR route bundle is missing framework modules");
        return {
          render(request, metadata) {
            return hmrRuntime.handleRequest(
              request,
              serverId,
              [pageId, ...layoutIds],
              metadata.modules[0] ?? "",
              metadata.styles,
              metadata.params,
              () => {},
              () => { throw new Error("Bake Response.render() route transitions are not connected yet"); },
              () => { throw new Error("Bake Response.render() route transitions are not connected yet"); },
            );
          },
        };
      }

      const exports = executeCommonJSArtifact(await artifact.text(), artifact.path || wrapperPath);
      if (typeof exports.render !== "function") {
        throw new TypeError(`Bake route bundle for ${page} did not export render()`);
      }
      return exports;
    })();
    bundles.set(page, pending);
    try {
      return await pending;
    } catch (error) {
      bundles.delete(page);
      throw error;
    }
  }

  const dispatchFrameworkRequest = async function dispatchFrameworkRequest(request) {
    const pathname = new URL(request.url).pathname;
    for (const router of routers) {
      const relativePathname = pathnameForRouter(pathname, router.prefix);
      if (relativePathname === null) continue;
      const matched = router.router.match(relativePathname);
      if (matched === null) continue;
      const route = await bundleRoute(router, matched);
      if (route === null) continue;
      return route.render(request, {
        params: matched.params,
        modules: [],
        modulepreload: [],
        styles: [],
      });
    }
    return new Response("Not Found", { status: 404 });
  };
  dispatchFrameworkRequest.projectRoot = projectRoot;
  dispatchFrameworkRequest.invalidate = () => {
    bundles.clear();
    routers = createRouters();
  };
  return dispatchFrameworkRequest;
}

function projectSnapshot(root) {
  const files = [];
  const visit = directory => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".cottontail-tmp" || entry.name === ".cottontail-bake-ready") {
        continue;
      }
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = statSync(absolute);
        files.push(`${path.relative(root, absolute)}\0${stat.size}\0${stat.mtimeMs}`);
      } catch {}
    }
  };
  visit(root);
  return files.join("\n");
}

function changedSnapshotPaths(previous, next) {
  const previousEntries = new Map();
  for (const line of previous.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\0");
    previousEntries.set(line.slice(0, separator), line.slice(separator + 1));
  }
  const nextEntries = new Map();
  for (const line of next.split("\n")) {
    if (!line) continue;
    const separator = line.indexOf("\0");
    nextEntries.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const changed = [];
  for (const [filename, signature] of nextEntries) {
    if (previousEntries.get(filename) !== signature) changed.push(filename);
    previousEntries.delete(filename);
  }
  changed.push(...previousEntries.keys());
  return changed;
}

function socketMessageText(message) {
  if (typeof message === "string") return message;
  try {
    return new TextDecoder().decode(message);
  } catch {
    return "";
  }
}

function sendWatchEvent(socket, event) {
  socket.sendBinary(new Uint8Array(["r".charCodeAt(0), event]));
}

function installDevelopmentSocket(config, bakeRuntime) {
  const routes = { ...(config.routes ?? {}) };
  const staticRoutes = { ...(config.static ?? {}) };
  const watchSessions = new WeakMap();
  const browserSockets = new Set();
  const projectRoot = bakeRuntime?.projectRoot ?? (globalThis.process?.cwd?.() ?? ".");
  let automaticSnapshot = "";
  let automaticTimer = null;
  let explicitWatchers = 0;
  let updatePromise = null;
  let updateQueued = false;
  const queuedChangedPaths = new Set();

  function broadcastUpdate(update) {
    for (const browserSocket of browserSockets) {
      const browserSession = watchSessions.get(browserSocket);
      if (!update.hardReload && update.packets.length > 0 && browserSession?.kind === "hmr-browser") {
        for (const packet of update.packets) browserSocket.sendBinary(packet);
      } else if (browserSession?.kind === "hmr-browser") {
        // A second version frame tells Bun's full HMR client to reload.
        browserSocket.sendBinary(new TextEncoder().encode(`V${bakeClientVersion()}`));
      } else {
        browserSocket.sendBinary(new Uint8Array(["u".charCodeAt(0)]));
      }
    }
  }

  async function runUpdate(changedPaths = []) {
    for (const filename of changedPaths) queuedChangedPaths.add(filename);
    if (updatePromise) {
      updateQueued = true;
      return updatePromise;
    }
    updatePromise = (async () => {
      let update;
      do {
        updateQueued = false;
        const currentChangedPaths = [...queuedChangedPaths];
        queuedChangedPaths.clear();
        update = await bakeRuntime?.update?.(currentChangedPaths) ?? { hardReload: true, packets: [] };
        broadcastUpdate(update);
      } while (updateQueued);
      return update;
    })();
    try {
      return await updatePromise;
    } finally {
      updatePromise = null;
    }
  }

  function startAutomaticWatcher() {
    if (automaticTimer !== null) return;
    automaticSnapshot = projectSnapshot(projectRoot);
    const poll = () => {
      automaticTimer = null;
      if (browserSockets.size === 0) return;
      const nextSnapshot = projectSnapshot(projectRoot);
      if (nextSnapshot !== automaticSnapshot) {
        const changedPaths = changedSnapshotPaths(automaticSnapshot, nextSnapshot);
        automaticSnapshot = nextSnapshot;
        if (explicitWatchers === 0) void runUpdate(changedPaths).catch(error => console.error(error));
      }
      automaticTimer = setTimeout(poll, 5);
      automaticTimer.unref?.();
    };
    automaticTimer = setTimeout(poll, 5);
    automaticTimer.unref?.();
  }

  routes["/_bun/hmr"] = (request, server) => {
    if (server.upgrade(request)) return;
    return new Response("WebSocket upgrade required", { status: 426 });
  };
  const workspaceUuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  routes["/.well-known/appspecific/com.chrome.devtools.json"] = () => new Response(JSON.stringify({
    workspace: {
      root: path.resolve(projectRoot),
      uuid: workspaceUuid,
    },
  }), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });

  const userWebSocket = config.websocket && typeof config.websocket === "object"
    ? config.websocket
    : {};
  return {
    ...config,
    routes,
    static: staticRoutes,
    websocket: {
      ...userWebSocket,
      open(socket) {
        socket.sendBinary(new TextEncoder().encode(`V${bakeClientVersion()}`));
        watchSessions.set(socket, {
          phase: "idle",
          snapshot: "",
          changedPaths: [],
          timer: null,
          kind: "unknown",
        });
        userWebSocket.open?.(socket);
      },
      async message(socket, message) {
        const text = socketMessageText(message);
        const existing = watchSessions.get(socket);
        if (text.startsWith("n")) {
          if (existing) existing.kind = "hmr-browser";
          browserSockets.add(socket);
          startAutomaticWatcher();
        } else if (text.startsWith("s")) {
          if (existing && existing.kind !== "hmr-browser") existing.kind = "browser";
          browserSockets.add(socket);
        }
        if (text === "H") {
          const session = existing ?? {
            phase: "idle",
            snapshot: "",
            changedPaths: [],
            timer: null,
            kind: "control",
          };
          session.kind = "control";
          browserSockets.delete(socket);
          watchSessions.set(socket, session);
          if (session.phase === "idle") {
            session.phase = "watching";
            explicitWatchers += 1;
            session.snapshot = projectSnapshot(projectRoot);
            session.changedPaths = [];
            sendWatchEvent(socket, 0);
            const poll = () => {
              if (session.phase !== "watching") return;
              const nextSnapshot = projectSnapshot(projectRoot);
              if (nextSnapshot !== session.snapshot) {
                session.timer = null;
                session.changedPaths = changedSnapshotPaths(session.snapshot, nextSnapshot);
                sendWatchEvent(socket, 1);
                return;
              }
              session.timer = setTimeout(poll, 5);
            };
            session.timer = setTimeout(poll, 5);
          } else {
            if (session.timer !== null) clearTimeout(session.timer);
            session.timer = null;
            session.phase = "building";
            explicitWatchers = Math.max(0, explicitWatchers - 1);
            try {
              await runUpdate(session.changedPaths);
              automaticSnapshot = projectSnapshot(projectRoot);
              sendWatchEvent(socket, browserSockets.size > 0 ? 4 : 3);
            } catch (error) {
              console.error(error);
              sendWatchEvent(socket, 3);
            } finally {
              session.phase = "idle";
            }
          }
        }
        await userWebSocket.message?.(socket, message);
      },
      close(socket, code, reason) {
        const session = watchSessions.get(socket);
        if (session?.timer != null) clearTimeout(session.timer);
        if (session?.phase === "watching") explicitWatchers = Math.max(0, explicitWatchers - 1);
        watchSessions.delete(socket);
        browserSockets.delete(socket);
        if (browserSockets.size === 0 && automaticTimer !== null) {
          clearTimeout(automaticTimer);
          automaticTimer = null;
        }
        userWebSocket.close?.(socket, code, reason);
      },
    },
  };
}

function trackLifecycle(server) {
  const state = bakeState();
  state.activeServer = server;
  const stop = server.stop.bind(server);
  let stopped = false;
  server.stop = function stopBakeServer(force = false) {
    const result = stop(force);
    if (!stopped) {
      stopped = true;
      state.activeServer = null;
      state.deinitCount += 1;
    }
    return result;
  };
  return server;
}

function productionPageFiles(root) {
  const files = [];
  const visit = directory => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/i.test(entry.name)) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.sort();
}

function resolveProductionImport(importer, specifier) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
  const base = specifier.startsWith("/") ? specifier : path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    ...[".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"].map(extension => base + extension),
    ...[".tsx", ".ts", ".jsx", ".js"].map(extension => path.join(base, `index${extension}`)),
  ];
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function productionClientEntries(page) {
  const clients = new Set();
  const visited = new Set();
  const visit = filename => {
    filename = path.resolve(filename);
    if (visited.has(filename)) return;
    visited.add(filename);
    let source;
    try {
      source = readFileSync(filename, "utf8");
    } catch {
      return;
    }
    if (/^\s*["']use client["'];?/m.test(source)) clients.add(filename);
    const pattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
    for (const match of source.matchAll(pattern)) {
      const resolved = resolveProductionImport(filename, match[1]);
      if (resolved) visit(resolved);
    }
  };
  visit(page);
  return [...clients];
}

function productionRouteInfo(pagesRoot, page) {
  const relative = path.relative(pagesRoot, page).replaceAll(path.sep, "/").replace(/\.[^.]+$/, "");
  const segments = relative.split("/");
  if (segments.at(-1) === "index") segments.pop();
  const catchAll = segments.findIndex(segment => /^\[\.\.\.[^\]]+\]$/.test(segment));
  return {
    segments,
    catchAll,
    parameter: catchAll >= 0 ? segments[catchAll].slice(4, -1) : null,
  };
}

async function loadProductionPage(page) {
  const result = await Bun.build({
    entrypoints: [page],
    target: "bun",
    format: "cjs",
    packages: "external",
    sourcemap: "inline",
    inlineImportMetaProperties: true,
    minify: false,
  });
  const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
  if (!artifact) throw new Error(`Bake production build did not emit ${page}`);
  return executeCommonJSArtifact(await artifact.text(), page);
}

async function productionClientScripts(entries, outdir) {
  if (entries.length === 0) return [];
  const result = await Bun.build({
    entrypoints: entries,
    target: "browser",
    format: "esm",
    outdir,
    minify: false,
    naming: { entry: "[hash].[ext]" },
  });
  return result.outputs
    .filter(output => output.kind === "entry-point" && ["js", "jsx", "ts", "tsx"].includes(output.loader))
    .map(output => `/_bun/${path.basename(output.path)}`);
}

function productionDocument(markup, scripts) {
  const tags = scripts.map(source => `<script type="module" src="${source}"></script>`).join("");
  return `<!DOCTYPE html>${markup}${tags}`;
}

export async function buildProductionApp({ outdir = "dist" } = {}) {
  const projectRoot = globalThis.process?.cwd?.() ?? ".";
  const pagesRoot = path.join(projectRoot, "pages");
  const outputRoot = path.resolve(projectRoot, outdir);
  const clientRoot = path.join(outputRoot, "_bun");
  mkdirSync(clientRoot, { recursive: true });

  const reactModule = globalThis.require("react");
  const React = reactModule.default ?? reactModule;
  const { renderToStaticMarkup } = globalThis.require("react-dom/server");
  for (const page of productionPageFiles(pagesRoot)) {
    const source = readFileSync(page, "utf8");
    if (!/^\s*["']use client["'];?/m.test(source) &&
        /\bimport\s*\{[^}]*\buseState\b[^}]*\}\s*from\s*["']react["']/.test(source)) {
      throw new Error(
        '"useState" is not available in a server component. If you need interactivity, consider converting part of this to a Client Component (by adding `"use client";` to the top of the file).',
      );
    }

    const pageModule = await loadProductionPage(page);
    const Page = pageModule.default ?? pageModule;
    if (typeof Page !== "function") continue;
    const route = productionRouteInfo(pagesRoot, page);
    let variants = [{ params: {} }];
    if (route.catchAll >= 0 && typeof pageModule.getStaticPaths === "function") {
      const paths = await pageModule.getStaticPaths();
      variants = Array.isArray(paths?.paths) ? paths.paths : [];
    }

    const clients = productionClientEntries(page);
    const scripts = await productionClientScripts(clients, clientRoot);
    for (const variant of variants) {
      const params = variant?.params ?? {};
      const segments = [...route.segments];
      if (route.catchAll >= 0) {
        const value = params[route.parameter];
        const replacement = Array.isArray(value) ? value.map(String) : value == null ? [] : [String(value)];
        segments.splice(route.catchAll, 1, ...replacement);
      }
      const destination = path.join(outputRoot, ...segments, "index.html");
      mkdirSync(path.dirname(destination), { recursive: true });
      const markup = renderToStaticMarkup(React.createElement(Page, { params }));
      writeFileSync(destination, productionDocument(markup, scripts));
    }
  }
}

Object.defineProperty(globalThis, Symbol.for("cottontail.internal.buildBakeProduction"), {
  configurable: true,
  enumerable: false,
  value: buildProductionApp,
  writable: false,
});

export function startDefaultApp(entryNamespace) {
  const config = entryNamespace?.default;
  if (!isServerConfig(config) || globalThis.__cottontailServeEverCalled) return null;

  const bakeManaged = isBakeConfig(config);
  const development = bakeManaged && globalThis.process?.env?.NODE_ENV !== "production";
  const normalizedConfig = bakeManaged ? normalizeBakeRoutes(config) : config;
  const htmlFetch = createHtmlDispatcher(normalizedConfig, development);
  const baseConfig = htmlFetch?.serveConfig ?? normalizedConfig;
  const frameworkFetch = baseConfig.app !== undefined ? createFrameworkDispatcher(baseConfig) : null;
  const bakeRuntime = htmlFetch || frameworkFetch
    ? {
        projectRoot: htmlFetch?.projectRoot ?? frameworkFetch?.projectRoot,
        invalidate() {
          htmlFetch?.invalidate?.();
          frameworkFetch?.invalidate?.();
        },
        async update(changedPaths) {
          const htmlUpdate = htmlFetch ? await htmlFetch.update(changedPaths) : null;
          frameworkFetch?.invalidate?.();
          return htmlUpdate ?? { hardReload: true, packets: [] };
        },
      }
    : null;
  let serveConfig = development
    ? installDevelopmentSocket({ ...baseConfig, development: true }, bakeRuntime)
    : baseConfig;

  if (htmlFetch || frameworkFetch) {
    const fallbackFetch = serveConfig.fetch;
    serveConfig = {
      ...serveConfig,
      async fetch(request, server) {
        if (htmlFetch) {
          const response = await htmlFetch(request);
          if (response.status !== 404) return response;
        }
        if (frameworkFetch) {
          const response = await frameworkFetch(request);
          if (response.status !== 404) return response;
        }
        if (typeof fallbackFetch !== "function") return new Response("Not Found", { status: 404 });
        return fallbackFetch(request, server);
      },
    };
  }

  if (config.app !== undefined &&
      typeof serveConfig.fetch !== "function" &&
      Object.keys(serveConfig.routes ?? {}).length === 0 &&
      Object.keys(serveConfig.static ?? {}).length === 0) {
    serveConfig = {
      ...serveConfig,
      fetch() {
        return new Response("Not Found", { status: 404 });
      },
    };
  }

  const server = trackLifecycle(serve(serveConfig));
  const protocol = server.url?.protocol?.replace(/:$/, "") ?? "http";
  console.debug(
    `Started ${server.development ? "development " : ""}server: ${protocol}://${server.hostname}:${server.port}`,
  );
  if (globalThis.process?.env?.BUN_DEV_SERVER_TEST_RUNNER === "1") {
    globalThis.process.send?.({ type: "cottontail-bake-ready", port: server.port });
    const readyFile = globalThis.process.env.BUN_DEV_SERVER_TEST_READY_FILE;
    if (readyFile) writeFileSync(readyFile, String(server.port));
  }
  return server;
}

export function getDevServerDeinitCount() {
  return bakeState().deinitCount;
}
