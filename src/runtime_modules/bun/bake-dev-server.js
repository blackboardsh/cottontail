import path from "../node/path.js";
import { readFileSync, readdirSync, statSync, writeFileSync } from "../node/fs.js";
import { pathToFileURL } from "../node/url.js";
import { __setBuiltinModules } from "../node/module.js";
import { Bun, serve } from "./index.js";
import {
  bakeGraphAttributeFiles,
  contentTypeForStaticFile,
  discoverClientBoundaries,
  frameworkBuildOptions,
  moduleIdForPath,
  normalizeBakeFramework,
  normalizeBuiltInModules,
  normalizeStaticRouters,
  resolveBakeImport,
  serverBoundaryFiles,
  staticRouterFile,
} from "./bake-framework.js";
import { FrameworkRouter } from "./bake-framework-router.js";
import { buildBakeProduction } from "./bake-production.js";

let responseOptionsAsyncLocalStorage = null;
let BakeResponse = null;

function currentBakeRequestStore(required) {
  if (responseOptionsAsyncLocalStorage === null) {
    if (required) throw new TypeError("Response.render() is only available in the Bun dev server");
    return null;
  }

  const store = responseOptionsAsyncLocalStorage.getStore();
  if (store === null || typeof store !== "object") {
    throw new TypeError("store value must be an object");
  }
  return store;
}

function assertBakeStreamingDisabled(displayFunction, required = false) {
  const store = currentBakeRequestStore(required);
  if (store === null) return null;
  if (typeof store.streaming !== "boolean") {
    throw new TypeError('"streaming" field must be a boolean');
  }
  if (store.streaming) {
    throw new TypeError(`"${displayFunction}" is not available when \`export const streaming = true\``);
  }
  return store;
}

function isJSXElement(value) {
  if (value === null || typeof value !== "object") return false;
  const marker = value.$$typeof;
  return marker === Symbol.for("react.element") || marker === Symbol.for("react.transitional.element");
}

function defineReactElementFields(response, type) {
  const fields = {
    $$typeof: Symbol.for("react.transitional.element"),
    type,
    key: null,
    props: {},
    _store: { validated: 0 },
    _owner: null,
    _debugInfo: null,
    _debugStack: null,
    _debugTask: null,
  };
  for (const [name, value] of Object.entries(fields)) {
    Object.defineProperty(response, name, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  return response;
}

function decorateComponentResponse(response, component, responseOptions) {
  return defineReactElementFields(response, function BakeResponseComponent() {
    const store = responseOptionsAsyncLocalStorage?.getStore?.();
    if (store && typeof store === "object") store.responseOptions = responseOptions;
    return component;
  });
}

function decorateControlResponse(response) {
  return defineReactElementFields(response, function BakeResponseControl() {
    throw response;
  });
}

function ensureBakeResponseInstalled() {
  if (BakeResponse !== null) return BakeResponse;
  const WebResponse = globalThis.Response;
  if (typeof WebResponse !== "function") {
    throw new TypeError("The Web Response constructor is not installed");
  }

  BakeResponse = class BakeResponse extends WebResponse {
    constructor(body = null, init = undefined) {
      const jsx = isJSXElement(body);
      if (jsx) assertBakeStreamingDisabled("new Response(<jsx />, { ... })");
      super(body, init);
      if (jsx) decorateComponentResponse(this, body, init);
      else defineReactElementFields(this, null);
    }

    static redirect(url, status = 302) {
      if (responseOptionsAsyncLocalStorage === null) return WebResponse.redirect(url, status);
      assertBakeStreamingDisabled("Response.redirect");
      const response = WebResponse.redirect(url, status);
      Object.setPrototypeOf(response, BakeResponse.prototype);
      return decorateControlResponse(response);
    }

    static render(path) {
      assertBakeStreamingDisabled("Response.render", true);
      if (arguments.length < 1) {
        throw new TypeError("Response.render() requires at least a path argument");
      }
      if (typeof path !== "string") {
        throw new TypeError("Response.render() path must be a string");
      }
      return decorateControlResponse(new BakeResponse(null, {
        headers: { location: path },
        status: 200,
      }));
    }
  };

  __setBuiltinModules({ "bun:app": Object.freeze({ Response: BakeResponse }) });
  return BakeResponse;
}

function setBakeResponseAsyncLocalStorage(storage) {
  if (storage === null || typeof storage !== "object" || typeof storage.getStore !== "function") {
    throw new TypeError("bakeEnsureAsyncLocalStorage requires an AsyncLocalStorage instance");
  }
  responseOptionsAsyncLocalStorage = storage;
  ensureBakeResponseInstalled();
}

// Bun exposes bun:app natively. Install its stock-JSC equivalent after the
// cyclic runtime bootstrap has initialized the Web Response constructor.
queueMicrotask(() => {
  if (typeof globalThis.Response === "function") ensureBakeResponseInstalled();
});

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

function normalizeDefaultServerConfig(config) {
  // Bun ignores array-valued `routes` fields. Framework applications such as
  // Hono expose their own route registry there while also providing fetch().
  if (!Array.isArray(config.routes)) return config;
  return { ...config, routes: undefined };
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

function rewriteBakeClientBuiltins(source) {
  return source
    .replaceAll('"bake/client"', '"bun:bake/client"')
    .replaceAll("'bake/client'", "'bun:bake/client'");
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

function createBakeFrameworkUpdatePacket(serverRouteIds, routeStyles, cssMutations) {
  const encoder = new TextEncoder();
  const encodedCss = cssMutations.map(({ id, source }) => {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new TypeError(`Invalid Bake CSS id: ${id}`);
    return { id, source: encoder.encode(source) };
  });
  let size = 1 + (serverRouteIds.length + 1) * 4 + 4 + 4;
  for (const styles of routeStyles.values()) size += 8 + (styles === null ? 0 : styles.length * 16);
  for (const item of encodedCss) size += 20 + item.source.length;

  const packet = new Uint8Array(size);
  const view = new DataView(packet.buffer);
  let offset = 0;
  packet[offset++] = "u".charCodeAt(0);
  for (const routeId of serverRouteIds) {
    view.setInt32(offset, routeId, true);
    offset += 4;
  }
  view.setInt32(offset, -1, true);
  offset += 4;
  for (const [routeId, styles] of routeStyles) {
    view.setInt32(offset, routeId, true);
    offset += 4;
    view.setInt32(offset, styles === null ? -1 : styles.length, true);
    offset += 4;
    if (styles !== null) {
      for (const id of styles) {
        if (!/^[a-f0-9]{16}$/.test(id)) throw new TypeError(`Invalid Bake CSS id: ${id}`);
        packet.set(encoder.encode(id), offset);
        offset += 16;
      }
    }
  }
  view.setInt32(offset, -1, true);
  offset += 4;
  view.setUint32(offset, encodedCss.length, true);
  offset += 4;
  for (const item of encodedCss) {
    packet.set(encoder.encode(item.id), offset);
    offset += 16;
    view.setUint32(offset, item.source.length, true);
    offset += 4;
    packet.set(item.source, offset);
    offset += item.source.length;
  }
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
    let hardReload = false;
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

function clientBuildOptions(framework, app) {
  const frameworkOptions = framework.bundlerOptions ?? {};
  const appOptions = app.bundlerOptions ?? {};
  const options = {
    ...frameworkOptions,
    ...(frameworkOptions.client ?? {}),
    ...appOptions,
    ...(appOptions.client ?? {}),
  };
  delete options.client;
  delete options.server;
  delete options.ssr;
  return options;
}

function ssrBuildOptions(framework, app) {
  const frameworkOptions = framework.bundlerOptions ?? {};
  const appOptions = app.bundlerOptions ?? {};
  const options = {
    ...frameworkOptions,
    ...(frameworkOptions.ssr ?? {}),
    ...appOptions,
    ...(appOptions.ssr ?? {}),
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

function adaptFrameworkPlugins(plugins, side) {
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
                side,
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

function isCssArtifact(artifact) {
  return artifact.loader === "css" || path.extname(String(artifact.path)).toLowerCase() === ".css";
}

function frameworkArtifactContentType(artifact) {
  if (isCssArtifact(artifact)) return "text/css; charset=utf-8";
  if (artifact.kind === "sourcemap") return "application/json; charset=utf-8";
  if (isJavaScriptArtifact(artifact)) return "text/javascript; charset=utf-8";
  return artifact.type || "application/octet-stream";
}

function metafileOutputForArtifact(metafile, artifact, projectRoot) {
  const artifactPath = path.resolve(projectRoot, String(artifact.path));
  const basename = path.basename(artifactPath);
  let basenameMatch = null;
  for (const [outputPath, output] of Object.entries(metafile?.outputs ?? {})) {
    const candidates = [
      path.resolve(projectRoot, outputPath),
      path.resolve(path.dirname(artifactPath), path.basename(outputPath)),
    ];
    if (candidates.some(candidate => path.normalize(candidate) === path.normalize(artifactPath))) return output;
    if (path.basename(outputPath) === basename) {
      if (basenameMatch !== null) return null;
      basenameMatch = output;
    }
  }
  return basenameMatch;
}

function bakeCssId(metafile, artifact, projectRoot) {
  const output = metafileOutputForArtifact(metafile, artifact, projectRoot);
  const inputs = Object.keys(output?.inputs ?? {})
    .filter(input => loaderForPath(input) === "css")
    .map(input => metafileInputPath(projectRoot, input))
    .sort();
  const key = inputs.length > 0 ? inputs.join("\0") : path.resolve(projectRoot, String(artifact.path));
  return BigInt.asUintN(64, Bun.hash(key)).toString(16).padStart(16, "0");
}

function bakeRouteClientUrl(routeId, generation) {
  const id = (routeId >>> 0).toString(16).padStart(8, "0");
  const version = (generation >>> 0).toString(16).padStart(8, "0");
  return `/_bun/client/route-${id}${version}.js`;
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

function hmrImportWrapperSource(imports) {
  return imports.map((specifier, index) => `import * as __ctGraph${index} from ${JSON.stringify(specifier)};`).join("\n") ||
    "export {};";
}

function prefixHmrGraph(parsed, prefix) {
  const sourceIds = new Set(Object.keys(parsed.modules));
  const modules = {};
  for (const [id, definition] of Object.entries(parsed.modules)) {
    const next = [...definition];
    const encoded = Array.isArray(definition?.[0]) ? [...definition[0]] : null;
    if (encoded !== null) {
      for (let index = 0; index < encoded.length;) {
        if (sourceIds.has(encoded[index])) encoded[index] = `${prefix}${encoded[index]}`;
        index += 2 + encoded[index + 1];
      }
      next[0] = encoded;
    }
    modules[`${prefix}${id}`] = next;
  }
  return { modules };
}

function rewriteHmrDependencies(modules, replacements) {
  if (replacements.size === 0) return modules;
  const rewritten = {};
  for (const [id, definition] of Object.entries(modules)) {
    const next = [...definition];
    const encoded = Array.isArray(definition?.[0]) ? [...definition[0]] : null;
    if (encoded !== null) {
      for (let index = 0; index < encoded.length;) {
        encoded[index] = replacements.get(encoded[index]) ?? encoded[index];
        index += 2 + encoded[index + 1];
      }
      next[0] = encoded;
    }
    rewritten[id] = next;
  }
  return rewritten;
}

function createFrameworkDispatcher(config) {
  const app = config.app;
  if (!app || app.framework == null) return null;
  const framework = normalizeBakeFramework(app.framework);
  ensureBakeResponseInstalled();

  const projectRoot = globalThis.process?.cwd?.() ?? ".";
  const builtIns = normalizeBuiltInModules(framework, projectRoot);
  const staticRouters = normalizeStaticRouters(framework, projectRoot);
  const componentServerManifest = Object.create(null);
  const componentSsrManifest = Object.create(null);
  const componentManifestModule = Object.freeze({
    actionManifest: undefined,
    serverManifest: componentServerManifest,
    ssrManifest: componentSsrManifest,
  });
  __setBuiltinModules({
    "bake/server": componentManifestModule,
    "bun:bake/server": componentManifestModule,
  });
  const configuredPlugins = [...(framework.plugins ?? []), ...(app.plugins ?? [])];
  const serverPlugins = adaptFrameworkPlugins(configuredPlugins, "server");
  const clientPlugins = adaptFrameworkPlugins(configuredPlugins, "client");
  const serverOptions = serverBuildOptions(framework, app);
  const clientOptions = clientBuildOptions(framework, app);
  const ssrOptions = ssrBuildOptions(framework, app);
  const serverComponents = framework.serverComponents && typeof framework.serverComponents === "object"
    ? framework.serverComponents
    : null;
  const reactFastRefresh = framework.reactFastRefresh === true ||
    (framework.reactFastRefresh !== null && typeof framework.reactFastRefresh === "object");
  const development = globalThis.process?.env?.NODE_ENV !== "production";
  const bundles = new Map();
  const wrapperPaths = new Map();
  const clientWrapperPaths = new Map();
  const ssrWrapperPaths = new Map();
  const hmrDefinitions = new Map();
  const routeRecords = [];
  const routeRecordByPage = new Map();
  const assets = new Map();
  const retiredClientEntries = new Set();
  let hmrRuntime = null;
  let wrapperId = 0;
  let hotUpdateId = 0;
  let hadBuildErrors = false;
  const routerTypes = framework.fileSystemRouterTypes ?? [];
  const graphAlias = { ...(serverOptions.alias ?? {}), ...builtIns.alias };
  const graphFiles = { ...(serverOptions.files ?? {}), ...builtIns.files };
  const createRouters = () => routerTypes.map(type => {
    const root = path.resolve(projectRoot, String(type.root));
    return {
      type,
      prefix: normalizePrefix(type.prefix),
      router: new FrameworkRouter({
        root,
        style: type.style,
        layouts: type.layouts ?? false,
        ignoreUnderscores: type.ignoreUnderscores,
        ignoreDirs: type.ignoreDirs,
        extensions: type.extensions ?? [".jsx", ".tsx", ".js", ".ts", ".cjs", ".cts", ".mjs", ".mts"],
      }),
      serverEntryPoint: resolveImportSource(projectRoot, type.serverEntryPoint),
      clientEntryPoint: type.clientEntryPoint == null
        ? null
        : resolveImportSource(projectRoot, type.clientEntryPoint),
    };
  });
  let routers = createRouters();

  function nextHotUpdateId() {
    hotUpdateId = (hotUpdateId + 1) >>> 0;
    return hotUpdateId.toString(16).padStart(16, "0");
  }

  function randomGeneration() {
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
    }
    return Math.floor(Math.random() * 0x100000000) >>> 0;
  }

  function getRouteRecord(page) {
    let record = routeRecordByPage.get(page);
    if (record) return record;
    record = {
      id: routeRecords.length,
      page,
      pathname: null,
      generation: randomGeneration(),
      route: null,
      promise: null,
    };
    routeRecords.push(record);
    routeRecordByPage.set(page, record);
    return record;
  }

  async function collectBuildAssets(result) {
    const css = new Map();
    for (const artifact of result.outputs) {
      if (artifact.kind === "entry-point" || artifact.kind === "sourcemap") continue;
      if (isCssArtifact(artifact)) {
        const id = bakeCssId(result.metafile, artifact, projectRoot);
        const url = `/_bun/asset/${id}.css`;
        const source = await artifact.text();
        assets.set(url, { body: source, type: "text/css; charset=utf-8" });
        css.set(id, { id, source, url });
        continue;
      }
      const url = `/_bun/asset/${path.basename(String(artifact.path))}`;
      assets.set(url, { body: artifact, type: frameworkArtifactContentType(artifact) });
    }
    return css;
  }

  function addComponentManifests(boundaries) {
    for (const boundary of boundaries) {
      const ssr = componentSsrManifest[boundary.id] ??= Object.create(null);
      for (const exportName of boundary.exports) {
        componentServerManifest[`${boundary.id}#${exportName}`] = {
          id: boundary.id,
          name: exportName,
          chunks: [],
        };
        ssr[exportName] = {
          specifier: `ssr:${boundary.id}`,
          name: exportName,
        };
      }
    }
  }

  function deleteComponentManifests(ids) {
    for (const id of ids) {
      const ssr = componentSsrManifest[id];
      for (const exportName of Object.keys(ssr ?? {})) {
        delete componentServerManifest[`${id}#${exportName}`];
      }
      delete componentSsrManifest[id];
    }
  }

  async function buildSsrRoute(record, boundaries) {
    if (serverComponents === null) return null;
    const configuredRoots = framework.__cottontailSsrEntryPoints ?? [];
    const roots = configuredRoots.map(source => resolveImportSource(projectRoot, source));
    const imports = [...roots, ...boundaries.map(boundary => boundary.path)];
    if (imports.length === 0) return null;

    let wrapperPath = ssrWrapperPaths.get(record.page);
    if (!wrapperPath) {
      wrapperPath = path.join(projectRoot, `.cottontail-bake-ssr-${record.id}.js`);
      ssrWrapperPaths.set(record.page, wrapperPath);
    }
    const configuredConditions = Array.isArray(ssrOptions.conditions) ? ssrOptions.conditions : [];
    const result = await Bun.build(frameworkBuildOptions({
      ...ssrOptions,
      entrypoints: [wrapperPath],
      format: "internal_bake_dev",
      minify: false,
      target: "bun",
      sourcemap: "external",
      serverComponents: false,
      conditions: [...new Set([...configuredConditions, "node"])],
      external: [...new Set([...(ssrOptions.external ?? []), "bun:bake/server"])],
      metafile: true,
      write: false,
      throw: false,
      plugins: serverPlugins,
    }, builtIns, { [wrapperPath]: hmrImportWrapperSource(imports) }));
    if (!result.success || result.outputs.length === 0) {
      throw new AggregateError(result.logs ?? [], `Failed to bundle Bake SSR graph for ${record.page}`);
    }
    const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
    const parsed = parseHmrArtifact(await artifact.text());
    const prefixed = prefixHmrGraph(parsed, "ssr:");
    const rootIds = roots.map(source => {
      const resolved = resolveBakeImport(wrapperPath, source, {
        alias: { ...(ssrOptions.alias ?? {}), ...builtIns.alias },
        files: { ...(ssrOptions.files ?? {}), ...builtIns.files },
      });
      return resolved === null ? null : moduleIdForPath(projectRoot, resolved);
    }).filter(id => id !== null && Object.prototype.hasOwnProperty.call(parsed.modules, id));
    return {
      modules: rewriteHmrDependencies(prefixed.modules, new Map([["bake/server", "bun:bake/server"]])),
      roots: rootIds,
      styles: await collectBuildAssets(result),
    };
  }

  async function buildClientRoute(record, router, boundaries) {
    let wrapperPath = clientWrapperPaths.get(record.page);
    if (!wrapperPath) {
      wrapperPath = path.join(projectRoot, `.cottontail-bake-client-${record.id}.js`);
      clientWrapperPaths.set(record.page, wrapperPath);
    }
    const imports = [
      ...(router.clientEntryPoint === null ? [] : [router.clientEntryPoint]),
      ...boundaries.map(boundary => boundary.path),
    ];
    const source = hmrImportWrapperSource(imports);
    const result = await Bun.build(frameworkBuildOptions({
      ...clientOptions,
      entrypoints: [wrapperPath],
      format: development ? "internal_bake_dev" : "esm",
      minify: development ? false : clientOptions.minify,
      target: "browser",
      publicPath: "/_bun/asset",
      sourcemap: development ? "external" : "none",
      reactFastRefresh: development && reactFastRefresh,
      serverComponents: false,
      external: [...new Set([...(clientOptions.external ?? []), "bun:bake/client"])],
      metafile: true,
      write: false,
      throw: false,
      plugins: clientPlugins,
    }, builtIns, { [wrapperPath]: source }));
    if (!result.success || result.outputs.length === 0) {
      throw new AggregateError(result.logs ?? [], `Failed to bundle Bake client entry ${router.clientEntryPoint ?? wrapperPath}`);
    }
    const artifact = result.outputs.find(isJavaScriptEntry);
    if (!artifact) throw new Error(`Bake's client build did not emit ${router.clientEntryPoint ?? wrapperPath}`);

    const originalSource = rewriteBakeClientBuiltins(await artifact.text());
    const url = bakeRouteClientUrl(record.id, record.generation);
    let servedSource = originalSource;
    const sourceMap = artifact.sourcemap ?? result.outputs.find(output => output.kind === "sourcemap");
    if (sourceMap) {
      const sourceMapComment = `//# sourceMappingURL=${url}.map`;
      servedSource = /\/\/# sourceMappingURL=[^\r\n]*/.test(servedSource)
        ? servedSource.replace(/\/\/# sourceMappingURL=[^\r\n]*/g, sourceMapComment)
        : `${servedSource}\n${sourceMapComment}\n`;
      assets.set(`${url}.map`, {
        body: sourceMap,
        type: "application/json; charset=utf-8",
      });
    }
    retiredClientEntries.delete(url);
    assets.set(url, { body: servedSource, type: "text/javascript; charset=utf-8" });
    return {
      modules: development ? bakeRegistryModules(originalSource) : null,
      styles: await collectBuildAssets(result),
      url,
    };
  }

  async function bundleRoute(router, matched, force = false) {
    const { page, layouts } = routeFiles(matched.route);
    if (!page) return null;
    const record = getRouteRecord(page);
    if (!force && record.route !== null) return record.route;
    if (!force && record.promise !== null) return record.promise;

    const pending = (async () => {
      let wrapperPath = wrapperPaths.get(page);
      if (!wrapperPath) {
        wrapperPath = path.join(projectRoot, `.cottontail-bake-route-${wrapperId++}.ts`);
        wrapperPaths.set(page, wrapperPath);
      }
      const configuredConditions = Array.isArray(serverOptions.conditions) ? serverOptions.conditions : [];
      const conditions = serverComponents === null
        ? configuredConditions
        : [...new Set([...configuredConditions, "react-server"])];
      const graph = serverComponents === null
        ? { boundaries: [] }
        : discoverClientBoundaries({
            projectRoot,
            roots: [page, ...layouts],
            alias: graphAlias,
            files: graphFiles,
            builtInSources: builtIns.sources,
          });
      const boundaryFiles = serverComponents === null
        ? {}
        : serverBoundaryFiles(graph.boundaries, serverComponents);
      const serverEntryFile = resolveBakeImport(wrapperPath, router.serverEntryPoint, {
        alias: graphAlias,
        files: graphFiles,
      });
      const graphAttributeFiles = serverComponents === null
        ? {}
        : bakeGraphAttributeFiles([serverEntryFile, ...graph.visited], graphFiles);
      const result = await Bun.build(frameworkBuildOptions({
        ...serverOptions,
        entrypoints: [wrapperPath],
        format: development ? "internal_bake_dev" : "cjs",
        minify: development ? false : serverOptions.minify,
        target: "bun",
        publicPath: "/_bun/asset",
        sourcemap: development ? "external" : serverOptions.sourcemap,
        serverComponents: serverComponents !== null,
        conditions,
        external: [...new Set([...(serverOptions.external ?? []), "bun:bake/server"])],
        metafile: true,
        write: false,
        throw: false,
        plugins: serverPlugins,
      }, builtIns, {
        ...graphAttributeFiles,
        ...boundaryFiles,
        [wrapperPath]: development
          ? hmrRouteWrapperSource(router.serverEntryPoint, page, layouts)
          : commonJSRouteWrapperSource(router.serverEntryPoint, page, layouts),
      }));
      if (!result.success || result.outputs.length === 0) {
        throw new AggregateError(result.logs ?? [], `Failed to bundle Bake route ${page}`);
      }
      const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
      const serverStyles = await collectBuildAssets(result);
      const client = await buildClientRoute(record, router, graph.boundaries);
      const ssr = development ? await buildSsrRoute(record, graph.boundaries) : null;
      const styles = new Map([...serverStyles, ...(ssr?.styles ?? []), ...client.styles]);
      if (development) {
        const parsed = parseHmrArtifact(await artifact.text());
        if (hmrRuntime === null) {
          hmrRuntime = parsed.factory(serverComponents?.separateSSRGraph === true, {
            require: globalThis.require,
            resolve: specifier => specifier,
            bakeBuiltin: bakeBuiltinNamespace,
            url: pathToFileURL(`${projectRoot}${path.sep}`).href,
          });
          if (typeof hmrRuntime?.handleRequest !== "function" || typeof hmrRuntime?.registerUpdate !== "function") {
            throw new TypeError("Bake's server HMR runtime is missing its host exports");
          }
        }

        const replacements = new Map([
          ["bake/server", "bun:bake/server"],
          ...(ssr?.roots ?? []).map(id => [id, `ssr:${id}`]),
        ]);
        const serverModules = rewriteHmrDependencies(parsed.modules, replacements);
        const allModules = { ...serverModules, ...(ssr?.modules ?? {}) };
        const changedModules = {};
        for (const [id, definition] of Object.entries(allModules)) {
          const signature = moduleDefinitionSignature(definition);
          if (hmrDefinitions.get(id) === signature) continue;
          hmrDefinitions.set(id, signature);
          changedModules[id] = definition;
        }

        const previousBoundaries = new Map((record.route?.boundaries ?? []).map(item => [item.id, item]));
        const nextBoundaries = new Map(graph.boundaries.map(item => [item.id, item]));
        const changedBoundaryIds = graph.boundaries
          .filter(item => JSON.stringify(previousBoundaries.get(item.id)?.exports) !== JSON.stringify(item.exports))
          .map(item => item.id);
        const removedBoundaryIds = [...previousBoundaries.keys()].filter(id => {
          if (nextBoundaries.has(id)) return false;
          return !routeRecords.some(other => other !== record && other.route?.boundaries?.some(item => item.id === id));
        });
        const manifestDeletes = [...new Set([...changedBoundaryIds.filter(id => previousBoundaries.has(id)), ...removedBoundaryIds])];
        if (manifestDeletes.length > 0) {
          deleteComponentManifests(manifestDeletes);
          await hmrRuntime.registerUpdate({}, null, manifestDeletes);
        }
        addComponentManifests(graph.boundaries);
        await hmrRuntime.registerUpdate(changedModules, changedBoundaryIds, null);

        const entryDefinition = serverModules[parsed.bundleConfig.main];
        const [serverId, pageId, ...layoutIds] = moduleDependencyIds(entryDefinition);
        if (!serverId || !pageId) throw new TypeError("Bake's HMR route bundle is missing framework modules");
        const route = {
          clientModules: client.modules,
          boundaries: graph.boundaries,
          css: styles,
          matched,
          router,
          serverModules: allModules,
          hmrArgs: {
            routerTypeMain: serverId,
            routeModules: [pageId, ...layoutIds],
            clientEntryUrl: client.url,
            styles: [...styles.values()].map(item => item.url),
          },
          render(request, metadata) {
            return hmrRuntime.handleRequest(
              request,
              serverId,
              [pageId, ...layoutIds],
              client.url,
              [...styles.values()].map(item => item.url),
              metadata.params,
              setBakeResponseAsyncLocalStorage,
              bundleNewRoute,
              newRouteParams,
            );
          },
        };
        return route;
      }

      const exports = executeCommonJSArtifact(await artifact.text(), artifact.path || wrapperPath);
      if (typeof exports.render !== "function") {
        throw new TypeError(`Bake route bundle for ${page} did not export render()`);
      }
      return {
        clientModules: null,
        boundaries: graph.boundaries,
        css: styles,
        matched,
        router,
        serverModules: null,
        hmrArgs: {
          clientEntryUrl: client.url,
          styles: [...styles.values()].map(item => item.url),
        },
        render: exports.render,
      };
    })();
    record.promise = pending;
    bundles.set(page, pending);
    try {
      const route = await pending;
      record.route = route;
      return route;
    } catch (error) {
      if (record.route === null) bundles.delete(page);
      throw error;
    } finally {
      if (record.promise === pending) record.promise = null;
    }
  }

  function matchFrameworkRoute(url, requestUrl) {
    const pathname = new URL(String(url), requestUrl).pathname;
    for (const router of routers) {
      const relativePathname = pathnameForRouter(pathname, router.prefix);
      if (relativePathname === null) continue;
      const matched = router.router.match(relativePathname);
      if (matched !== null) return { matched, router };
    }
    return null;
  }

  function bundleNewRoute(request, url) {
    const found = matchFrameworkRoute(url, request.url);
    if (found === null) throw new Error(`No route found for path: ${new URL(String(url), request.url).pathname}`);
    const { page } = routeFiles(found.matched.route);
    if (!page) throw new Error(`No page found for path: ${new URL(String(url), request.url).pathname}`);

    const record = getRouteRecord(page);
    record.pathname = new URL(String(url), request.url).pathname;
    const promise = record.route === null
      ? bundleRoute(found.router, found.matched).then(route => {
          if (route === null) throw new Error(`No route bundle produced for path: ${String(url)}`);
        })
      : undefined;
    return [record.id, promise];
  }

  function newRouteParams(request, routeBundleIndex, url) {
    if (!Number.isInteger(routeBundleIndex) || routeBundleIndex < 0 || routeBundleIndex >= routeRecords.length) {
      throw new TypeError("Route bundle index must be an integer");
    }
    const record = routeRecords[routeBundleIndex];
    if (record.route === null) throw new Error(`Route bundle ${routeBundleIndex} has not finished loading`);

    const found = matchFrameworkRoute(url, request.url);
    if (found === null) throw new Error(`No route found for path: ${new URL(String(url), request.url).pathname}`);
    const { page } = routeFiles(found.matched.route);
    if (page !== record.page) {
      throw new Error(`Route index mismatch for path: ${new URL(String(url), request.url).pathname}`);
    }
    return {
      ...record.route.hmrArgs,
      params: found.matched.params,
    };
  }

  const dispatchFrameworkRequest = async function dispatchFrameworkRequest(request) {
    const pathname = new URL(request.url).pathname;
    const asset = assets.get(pathname);
    if (asset) {
      return new Response(asset.body, {
        headers: {
          "cache-control": "no-cache",
          "content-type": asset.type,
        },
      });
    }
    if (retiredClientEntries.has(pathname)) {
      return new Response(
        "try{location.reload()}catch(_){}\naddEventListener(\"DOMContentLoaded\",()=>location.reload())",
        { headers: { "content-type": "text/javascript; charset=utf-8" } },
      );
    }
    const staticFile = staticRouterFile(staticRouters, pathname);
    if (staticFile !== null) {
      return new Response(readFileSync(staticFile), {
        headers: {
          "cache-control": "no-cache",
          "content-type": contentTypeForStaticFile(staticFile),
        },
      });
    }
    const found = matchFrameworkRoute(request.url, request.url);
    if (found === null) return new Response("Not Found", { status: 404 });
    const { page } = routeFiles(found.matched.route);
    if (!page) return new Response("Not Found", { status: 404 });
    const record = getRouteRecord(page);
    record.pathname = pathname;
    const route = await bundleRoute(found.router, found.matched);
    if (route === null) return new Response("Not Found", { status: 404 });
    return route.render(request, {
      params: found.matched.params,
      modules: [route.hmrArgs?.clientEntryUrl ?? ""],
      modulepreload: [],
      styles: route.hmrArgs?.styles ?? [],
    });
  };
  dispatchFrameworkRequest.projectRoot = projectRoot;
  dispatchFrameworkRequest.routeIdForPath = pathname => {
    const found = matchFrameworkRoute(pathname, "http://localhost/");
    if (found === null) return null;
    const { page } = routeFiles(found.matched.route);
    if (!page) return null;
    const record = getRouteRecord(page);
    record.pathname = new URL(String(pathname), "http://localhost/").pathname;
    return record.id;
  };
  dispatchFrameworkRequest.invalidate = () => {
    bundles.clear();
    for (const record of routeRecords) {
      if (record.route?.hmrArgs?.clientEntryUrl) {
        const url = record.route.hmrArgs.clientEntryUrl;
        assets.delete(url);
        assets.delete(`${url}.map`);
        retiredClientEntries.add(url);
      }
    }
    routeRecords.length = 0;
    routeRecordByPage.clear();
    wrapperPaths.clear();
    clientWrapperPaths.clear();
    ssrWrapperPaths.clear();
    routers = createRouters();
  };
  dispatchFrameworkRequest.update = async (changedPaths = []) => {
    const activeRecords = routeRecords.filter(record => record.route !== null);
    const previousRouters = routers;
    const packets = [];
    const serverRouteIds = [];
    const routeStyles = new Map();
    const cssMutations = new Map();
    const changedClientModules = {};
    let hardReload = false;
    let buildFailed = false;

    try {
      routers = createRouters();
    } catch (error) {
      routers = previousRouters;
      const errors = bakeBuildErrors(error?.errors ?? [error], projectRoot);
      packets.push(createBakeErrorUpdatePacket(errors, nextHotUpdateId()));
      hadBuildErrors = true;
      return { hardReload: false, packets };
    }

    for (const record of activeRecords) {
      const previous = record.route;
      const found = matchFrameworkRoute(record.pathname ?? "/", "http://localhost/");
      const nextPage = found === null ? null : routeFiles(found.matched.route).page;
      if (found === null || nextPage !== record.page) {
        hardReload = true;
        continue;
      }

      let next;
      try {
        next = await bundleRoute(found.router, found.matched, true);
      } catch (error) {
        const errors = bakeBuildErrors(error?.errors ?? [error], record.page);
        packets.push(createBakeErrorUpdatePacket(errors, nextHotUpdateId()));
        buildFailed = true;
        continue;
      }

      if (development) {
        let serverChanged = false;
        const previousServerModules = previous.serverModules ?? {};
        const nextServerModules = next.serverModules ?? {};
        const serverModuleIds = new Set([...Object.keys(previousServerModules), ...Object.keys(nextServerModules)]);
        for (const id of serverModuleIds) {
          if (moduleDefinitionSignature(previousServerModules[id]) !== moduleDefinitionSignature(nextServerModules[id])) {
            serverChanged = true;
            break;
          }
        }
        if (serverChanged) serverRouteIds.push(record.id);

        const previousClientModules = previous.clientModules ?? {};
        for (const [id, definition] of Object.entries(next.clientModules ?? {})) {
          if (changedPathMatchesModule(projectRoot, changedPaths, id) ||
              moduleDefinitionSignature(previousClientModules[id]) !== moduleDefinitionSignature(definition)) {
            changedClientModules[id] = definition;
          }
        }

        const previousCssIds = [...previous.css.keys()];
        const nextCssIds = [...next.css.keys()];
        const stylesChanged = previousCssIds.length !== nextCssIds.length ||
          previousCssIds.some((id, index) => id !== nextCssIds[index]);
        if (serverChanged || stylesChanged) {
          routeStyles.set(record.id, stylesChanged ? nextCssIds : null);
        }
        for (const [id, item] of next.css) {
          if (previous.css.get(id)?.source !== item.source) cssMutations.set(id, item);
        }
      }
    }

    if (buildFailed) {
      routers = previousRouters;
      hadBuildErrors = true;
    } else if (hadBuildErrors) {
      packets.push(createBakeErrorUpdatePacket([], nextHotUpdateId()));
      hadBuildErrors = false;
    }
    if (serverRouteIds.length > 0 || routeStyles.size > 0 || cssMutations.size > 0) {
      packets.push(createBakeFrameworkUpdatePacket(
        serverRouteIds,
        routeStyles,
        [...cssMutations.values()],
      ));
    }
    if (Object.keys(changedClientModules).length > 0) {
      packets.push(createBakeHotUpdatePacket(changedClientModules, nextHotUpdateId()));
    }
    return { hardReload, packets };
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
    if (!update.hardReload && update.packets.length === 0) return;
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
          const routeId = bakeRuntime?.routeIdForPath?.(text.slice(1) || "/");
          if (Number.isInteger(routeId) && routeId >= 0) {
            const response = new Uint8Array(5);
            response[0] = "n".charCodeAt(0);
            new DataView(response.buffer).setUint32(1, routeId, true);
            socket.sendBinary(response);
          }
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

export async function buildProductionApp(options = {}) {
  ensureBakeResponseInstalled();
  const { AsyncLocalStorage } = globalThis.require("node:async_hooks");
  const storage = new AsyncLocalStorage();
  setBakeResponseAsyncLocalStorage(storage);
  return buildBakeProduction(options, {
    runWithResponseContext(streaming, callback) {
      return storage.run({ responseOptions: {}, streaming: Boolean(streaming) }, callback);
    },
  });
}

Object.defineProperty(globalThis, Symbol.for("cottontail.internal.buildBakeProduction"), {
  configurable: true,
  enumerable: false,
  value: buildProductionApp,
  writable: false,
});

export function startDefaultApp(entryNamespace) {
  const exportedConfig = entryNamespace?.default;
  if (!isServerConfig(exportedConfig) || globalThis.__cottontailServeEverCalled) return null;
  const config = normalizeDefaultServerConfig(exportedConfig);

  const bakeManaged = isBakeConfig(config);
  const development = bakeManaged && globalThis.process?.env?.NODE_ENV !== "production";
  const normalizedConfig = bakeManaged ? normalizeBakeRoutes(config) : config;
  const htmlFetch = createHtmlDispatcher(normalizedConfig, development);
  const baseConfig = htmlFetch?.serveConfig ?? normalizedConfig;
  const frameworkFetch = baseConfig.app !== undefined ? createFrameworkDispatcher(baseConfig) : null;
  const bakeRuntime = htmlFetch || frameworkFetch
    ? {
        projectRoot: htmlFetch?.projectRoot ?? frameworkFetch?.projectRoot,
        routeIdForPath(pathname) {
          return frameworkFetch?.routeIdForPath?.(pathname) ?? null;
        },
        invalidate() {
          htmlFetch?.invalidate?.();
          frameworkFetch?.invalidate?.();
        },
        async update(changedPaths) {
          const htmlUpdate = htmlFetch ? await htmlFetch.update(changedPaths) : null;
          const frameworkUpdate = frameworkFetch ? await frameworkFetch.update(changedPaths) : null;
          if (!htmlUpdate && !frameworkUpdate) return { hardReload: true, packets: [] };
          return {
            hardReload: Boolean(htmlUpdate?.hardReload || frameworkUpdate?.hardReload),
            packets: [...(htmlUpdate?.packets ?? []), ...(frameworkUpdate?.packets ?? [])],
          };
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
        const pathname = new URL(request.url).pathname;
        if (frameworkFetch && (pathname.startsWith("/_bun/client/") || pathname.startsWith("/_bun/asset/"))) {
          const response = await frameworkFetch(request);
          if (response.status !== 404) return response;
        }
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
