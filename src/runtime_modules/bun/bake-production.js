import path from "../node/path.js";
import { mkdirSync, rmSync, statSync, writeFileSync } from "../node/fs.js";
import { pathToFileURL } from "../node/url.js";
import { __setBuiltinModules } from "../node/module.js";
import {
  bakeGraphAttributeFiles,
  copyStaticRouters,
  discoverClientBoundaries,
  frameworkBuildOptions,
  moduleIdForPath,
  normalizeBakeFramework,
  normalizeBuiltInModules,
  normalizeStaticRouters,
  resolveBakeImport,
  resolveFrameworkRuntimeImports,
  serverBoundaryFiles,
} from "./bake-framework.js";
import { FrameworkRouter } from "./bake-framework-router.js";

const sourceExtensions = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"];

function executeCommonJSArtifact(source, filename) {
  const sourceUrl = pathToFileURL(filename).href.replaceAll("\n", "");
  const factory = (0, eval)(`${source}\n//# sourceURL=${sourceUrl}`);
  if (typeof factory !== "function") throw new TypeError("Bake's server bundle did not produce a CommonJS factory");
  const module = { exports: {} };
  factory(module.exports, globalThis.require, module, filename, path.dirname(filename));
  return module.exports;
}

function commonJSFileSource(factorySource) {
  return `const __ctFactory = ${factorySource};\n__ctFactory(module.exports, require, module, __filename, __dirname);\n`;
}

function loaderForPath(value) {
  switch (path.extname(String(value)).toLowerCase()) {
    case ".js":
    case ".mjs":
    case ".cjs": return "js";
    case ".ts":
    case ".mts":
    case ".cts": return "ts";
    case ".jsx": return "jsx";
    case ".tsx": return "tsx";
    case ".css": return "css";
    case ".json": return "json";
    case ".toml": return "toml";
    case ".txt": return "text";
    case ".wasm": return "wasm";
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

function splitBuildOptions(framework, app, side) {
  const frameworkOptions = framework.bundlerOptions ?? {};
  const appOptions = app.bundlerOptions ?? {};
  const options = {
    ...frameworkOptions,
    ...(frameworkOptions[side] ?? {}),
    ...appOptions,
    ...(appOptions[side] ?? {}),
  };
  delete options.client;
  delete options.server;
  delete options.ssr;
  return options;
}

function resolveImportSource(projectRoot, source) {
  const value = String(source);
  if (path.isAbsolute(value)) return value;
  if (value.startsWith("./") || value.startsWith("../")) return path.resolve(projectRoot, value);
  return value;
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

function routeFiles(route) {
  const layouts = [];
  const page = route?.page;
  while (route) {
    if (route.layout) layouts.push(route.layout);
    route = route.parent;
  }
  return { page, layouts };
}

function routePattern(prefix, pattern) {
  if (prefix === "/") return pattern;
  return pattern === "/" ? prefix : `${prefix}${pattern}`;
}

function productionDefines(options, side) {
  return {
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.MODE": '"production"',
    "import.meta.env.SSR": side === "client" ? "false" : "true",
    "import.meta.env.STATIC": "true",
    "process.env.NODE_ENV": '"production"',
    ...(options.define ?? {}),
  };
}

function findConfigEntrypoint(projectRoot, entrypoint) {
  const requested = entrypoint == null ? "./bun.app" : String(entrypoint);
  const absolute = path.isAbsolute(requested) ? requested : path.resolve(projectRoot, requested);
  const candidates = [absolute];
  if (!path.extname(absolute)) {
    for (const extension of sourceExtensions) candidates.push(`${absolute}${extension}`);
    for (const extension of sourceExtensions) candidates.push(path.join(absolute, `index${extension}`));
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  try {
    return globalThis.Bun.resolveSync(requested, projectRoot);
  } catch {
    throw new Error(`Could not resolve application config file ${JSON.stringify(requested)}`);
  }
}

async function loadProductionConfig(projectRoot, entrypoint) {
  const configPath = findConfigEntrypoint(projectRoot, entrypoint);
  const result = await globalThis.Bun.build({
    entrypoints: [configPath],
    target: "bun",
    format: "cjs",
    packages: "external",
    sourcemap: "inline",
    inlineImportMetaProperties: true,
    includeRuntimeModules: true,
    minify: false,
  });
  const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
  if (!artifact) throw new Error(`Bake production build did not emit ${configPath}`);
  const namespace = executeCommonJSArtifact(await artifact.text(), configPath);
  const config = namespace?.default ?? namespace;
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("Your config file's default export must be an object");
  }
  if (config.app === null || typeof config.app !== "object" || Array.isArray(config.app)) {
    throw new TypeError("Your config file's default export must contain an 'app' object");
  }
  return config;
}

function routeWrapperSource(serverEntryPoint, page, layouts) {
  const imports = [
    `import * as __ctServer from ${JSON.stringify(serverEntryPoint)};`,
    `import * as __ctPage from ${JSON.stringify(page)};`,
    ...layouts.map((layout, index) => `import * as __ctLayout${index} from ${JSON.stringify(layout)};`),
  ];
  return `${imports.join("\n")}
export const framework = __ctServer;
export const pageModule = __ctPage;
export const layouts = [${layouts.map((_, index) => `__ctLayout${index}`).join(", ")}];`;
}

function clientWrapperSource(clientEntryPoint) {
  return clientEntryPoint === null ? "export {};" : `import ${JSON.stringify(clientEntryPoint)};`;
}

function outputRelativePath(artifact) {
  const value = String(artifact.path).replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value || value.startsWith("../") || path.isAbsolute(value)) return `_bun/${path.basename(value || "asset")}`;
  return value.startsWith("_bun/") ? value : `_bun/${path.basename(value)}`;
}

async function writePublicArtifact(outputRoot, artifact) {
  const relative = outputRelativePath(artifact);
  const destination = path.resolve(outputRoot, relative);
  const rootPrefix = `${path.resolve(outputRoot)}${path.sep}`;
  if (!destination.startsWith(rootPrefix)) throw new Error(`Invalid Bake output path: ${artifact.path}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  await globalThis.Bun.write(destination, artifact);
  return `/${relative.split(path.sep).join("/")}`;
}

function isJavaScriptArtifact(artifact) {
  return ["js", "jsx", "ts", "tsx"].includes(artifact.loader) || /\.[cm]?js$/i.test(String(artifact.path));
}

function isCssArtifact(artifact) {
  return artifact.loader === "css" || path.extname(String(artifact.path)).toLowerCase() === ".css";
}

function metafileOutputForArtifact(result, artifact) {
  const basename = path.basename(String(artifact.path));
  let match = null;
  for (const [outputPath, metadata] of Object.entries(result.metafile?.outputs ?? {})) {
    if (path.basename(outputPath) !== basename) continue;
    if (match !== null) return null;
    match = metadata;
  }
  return match;
}

function entrySourceForArtifact(result, artifact, projectRoot) {
  const entryPoint = metafileOutputForArtifact(result, artifact)?.entryPoint;
  if (typeof entryPoint !== "string") return null;
  return path.isAbsolute(entryPoint) ? path.normalize(entryPoint) : path.resolve(projectRoot, entryPoint);
}

async function writeClientGraph(context, route) {
  const { clientOptions, clientPlugins, builtIns, outputRoot, projectRoot, serverComponents } = context;
  const needsRuntime = serverComponents === null || route.boundaries.length > 0;
  const entrypoints = [];
  let wrapperPath = null;
  if (needsRuntime && route.clientEntryPoint !== null) {
    wrapperPath = path.join(projectRoot, `.cottontail-bake-prod-client-${route.index}.js`);
    entrypoints.push(wrapperPath);
  }
  if (serverComponents !== null) entrypoints.push(...route.boundaries.map(boundary => boundary.path));
  if (entrypoints.length === 0) {
    return { boundaryUrls: new Map(), modules: [], modulepreload: [], styles: [] };
  }

  const files = wrapperPath === null ? {} : { [wrapperPath]: clientWrapperSource(route.clientEntryPoint) };
  const clientRuntimePath = path.join(projectRoot, ".cottontail-bake-builtins", "bun-bake-client.js");
  const clientBuiltIns = {
    ...builtIns,
    alias: {
      ...builtIns.alias,
      "bake/client": clientRuntimePath,
      "bun:bake/client": clientRuntimePath,
    },
    files: {
      ...builtIns.files,
      [clientRuntimePath]: "export function onServerSideReload() {}\n",
    },
  };
  const result = await globalThis.Bun.build(frameworkBuildOptions({
    ...clientOptions,
    entrypoints,
    target: "browser",
    format: "esm",
    splitting: true,
    naming: {
      entry: "_bun/[name]-[hash].[ext]",
      chunk: "_bun/[name]-[hash].[ext]",
      asset: "_bun/[name]-[hash].[ext]",
      ...(typeof clientOptions.naming === "object" ? clientOptions.naming : {}),
    },
    define: productionDefines(clientOptions, "client"),
    jsx: { ...(clientOptions.jsx ?? {}), development: false },
    minify: clientOptions.minify ?? true,
    publicPath: "/",
    serverComponents: false,
    external: clientOptions.external ?? [],
    metafile: true,
    write: false,
    throw: false,
    plugins: clientPlugins,
  }, clientBuiltIns, files));
  if (!result.success) throw new AggregateError(result.logs ?? [], `Failed to bundle client graph for ${route.page}`);

  const boundaryByPath = new Map(route.boundaries.map(boundary => [path.normalize(boundary.path), boundary]));
  const boundaryUrls = new Map();
  const modules = [];
  const modulepreload = [];
  const styles = [];
  for (const artifact of result.outputs) {
    if (artifact.kind === "sourcemap") continue;
    const url = await writePublicArtifact(outputRoot, artifact);
    if (isCssArtifact(artifact)) {
      styles.push(url);
      continue;
    }
    if (!isJavaScriptArtifact(artifact)) continue;
    const source = entrySourceForArtifact(result, artifact, projectRoot);
    if (source !== null && wrapperPath !== null && path.normalize(source) === path.normalize(wrapperPath)) {
      modules.push(url);
    } else if (source !== null && boundaryByPath.has(path.normalize(source))) {
      boundaryUrls.set(boundaryByPath.get(path.normalize(source)).id, url);
    } else if (artifact.kind === "chunk") {
      modulepreload.push(url);
    }
  }
  return {
    boundaryUrls,
    modules: [...new Set(modules)],
    modulepreload: [...new Set(modulepreload)],
    styles: [...new Set(styles)],
  };
}

async function writeStandardCommonJS(result, filename) {
  const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
  if (!artifact) throw new Error(`Bake build did not emit ${filename}`);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, commonJSFileSource(await artifact.text()));
  return filename;
}

async function writeStandardESM(result, filename) {
  const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
  if (!artifact) throw new Error(`Bake build did not emit ${filename}`);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, await artifact.text());
  return filename;
}

async function buildSsrFrameworkAliases(context) {
  const { framework, ssrOptions, serverPlugins, builtIns, tempRoot } = context;
  const aliases = {};
  const roots = framework.__cottontailSsrEntryPoints ?? [];
  for (let index = 0; index < roots.length; index += 1) {
    const specifier = String(roots[index]);
    const wrapperPath = path.join(context.projectRoot, `.cottontail-bake-prod-ssr-framework-${index}.js`);
    const result = await globalThis.Bun.build(frameworkBuildOptions({
      ...ssrOptions,
      entrypoints: [wrapperPath],
      target: "bun",
      format: "esm",
      conditions: [...new Set([...(ssrOptions.conditions ?? []), "node"])],
      define: productionDefines(ssrOptions, "server"),
      jsx: { ...(ssrOptions.jsx ?? {}), development: false },
      minify: false,
      serverComponents: false,
      external: [...new Set([...(ssrOptions.external ?? []), "bake/server", "bun:bake/server"])],
      write: false,
      throw: false,
      plugins: serverPlugins,
    }, builtIns, { [wrapperPath]: `export * from ${JSON.stringify(specifier)};` }));
    if (!result.success) throw new AggregateError(result.logs ?? [], `Failed to bundle SSR framework module ${specifier}`);
    const filename = path.join(tempRoot, `framework-${index}.mjs`);
    aliases[specifier] = await writeStandardESM(result, filename);
  }
  return aliases;
}

async function buildSsrComponents(context, route) {
  const result = new Map();
  for (let index = 0; index < route.boundaries.length; index += 1) {
    const boundary = route.boundaries[index];
    const build = await globalThis.Bun.build(frameworkBuildOptions({
      ...context.ssrOptions,
      entrypoints: [boundary.path],
      target: "bun",
      format: "esm",
      conditions: [...new Set([...(context.ssrOptions.conditions ?? []), "node"])],
      define: productionDefines(context.ssrOptions, "server"),
      jsx: { ...(context.ssrOptions.jsx ?? {}), development: false },
      minify: false,
      serverComponents: false,
      external: [...new Set([...(context.ssrOptions.external ?? []), "bake/server", "bun:bake/server"])],
      write: false,
      throw: false,
      plugins: context.serverPlugins,
    }, context.builtIns));
    if (!build.success) throw new AggregateError(build.logs ?? [], `Failed to bundle SSR component ${boundary.path}`);
    const hash = BigInt.asUintN(64, globalThis.Bun.hash(`${route.index}:${boundary.id}`)).toString(16);
    const filename = path.join(context.tempRoot, `component-${hash}.mjs`);
    result.set(boundary.id, await writeStandardESM(build, filename));
  }
  return result;
}

async function loadServerRoute(context, route) {
  const wrapperPath = path.join(context.projectRoot, `.cottontail-bake-prod-route-${route.index}.js`);
  const proxyFiles = context.serverComponents === null
    ? {}
    : serverBoundaryFiles(route.boundaries, context.serverComponents);
  const serverEntryFile = resolveBakeImport(wrapperPath, route.serverEntryPoint, {
    alias: { ...(context.serverOptions.alias ?? {}), ...context.builtIns.alias },
    files: { ...(context.serverOptions.files ?? {}), ...context.builtIns.files },
  });
  const graphAttributeFiles = context.serverComponents === null
    ? {}
    : bakeGraphAttributeFiles(
        [serverEntryFile, ...(route.graphFiles ?? [])],
        { ...context.serverOptions.files, ...context.builtIns.files },
      );
  const routeBuiltIns = {
    ...context.builtIns,
    alias: {
      ...context.builtIns.alias,
      ...context.ssrFrameworkAliases,
    },
  };
  const configuredConditions = [...(context.serverOptions.conditions ?? []), "node"];
  const conditions = context.serverComponents === null
    ? configuredConditions
    : [...new Set([...configuredConditions, "react-server"])];
  const result = await globalThis.Bun.build(frameworkBuildOptions({
    ...context.serverOptions,
    entrypoints: [wrapperPath],
    target: "bun",
    format: "esm",
    conditions,
    define: productionDefines(context.serverOptions, "server"),
    jsx: { ...(context.serverOptions.jsx ?? {}), development: false },
    minify: false,
    serverComponents: context.serverComponents !== null,
    external: [...new Set([...(context.serverOptions.external ?? []), "bake/server", "bun:bake/server"])],
    metafile: true,
    write: false,
    throw: false,
    plugins: context.serverPlugins,
  }, routeBuiltIns, {
    ...graphAttributeFiles,
    ...proxyFiles,
    [wrapperPath]: routeWrapperSource(route.serverEntryPoint, route.page, route.layouts),
  }));
  if (!result.success) throw new AggregateError(result.logs ?? [], `Failed to bundle server route ${route.page}`);
  const artifact = result.outputs.find(output => output.kind === "entry-point") ?? result.outputs[0];
  if (!artifact) throw new Error(`Bake's server build did not emit ${route.page}`);

  const serverStyles = [];
  for (const output of result.outputs) {
    if (output === artifact || output.kind === "sourcemap") continue;
    const url = await writePublicArtifact(context.outputRoot, output);
    if (isCssArtifact(output)) serverStyles.push(url);
  }
  const filename = path.join(context.tempRoot, `route-${route.index}.mjs`);
  await writeStandardESM(result, filename);
  const exports = await import(pathToFileURL(filename).href);
  if (exports.framework === null || typeof exports.framework !== "object") {
    throw new TypeError(`Bake server entrypoint for ${route.page} did not produce a module namespace`);
  }
  return {
    framework: exports.framework,
    layouts: exports.layouts ?? [],
    pageModule: exports.pageModule,
    styles: [...new Set([...serverStyles, ...route.client.styles])],
  };
}

function installComponentManifests(serverManifest, ssrManifest) {
  const module = Object.freeze({ actionManifest: undefined, serverManifest, ssrManifest });
  __setBuiltinModules({
    "bake/server": module,
    "bun:bake/server": module,
  });
}

function clearObject(value) {
  for (const key of Object.keys(value)) delete value[key];
}

function activateRouteManifests(context, route) {
  clearObject(context.serverManifest);
  clearObject(context.ssrManifest);
  for (const boundary of route.boundaries) {
    const clientId = route.client.boundaryUrls.get(boundary.id);
    const ssrSpecifier = route.ssrComponents.get(boundary.id);
    if (clientId === undefined || ssrSpecifier === undefined) {
      throw new Error(`Bake did not emit both client and SSR modules for ${boundary.id}`);
    }
    const ssrEntries = context.ssrManifest[clientId] ??= Object.create(null);
    context.ssrManifest[boundary.id] = ssrEntries;
    for (const exportName of boundary.exports) {
      context.serverManifest[`${boundary.id}#${exportName}`] = {
        id: clientId,
        name: exportName,
        chunks: [],
      };
      ssrEntries[exportName] = { specifier: ssrSpecifier, name: exportName };
    }
  }
}

function routeSegments(route, params) {
  const segments = route.prefix === "/" ? [] : route.prefix.slice(1).split("/");
  for (const part of route.parts) {
    if (part.type === "group") continue;
    if (part.type === "text") {
      segments.push(part.value);
      continue;
    }
    const value = params?.[part.value];
    if (value === undefined || value === null) {
      if (part.type === "catch_all_optional") continue;
      throw new Error(`Missing param ${part.value} for route ${JSON.stringify(route.sourceFile)}`);
    }
    if (part.type === "catch_all" || part.type === "catch_all_optional") {
      const values = Array.isArray(value) ? value : [value];
      segments.push(...values.map(String));
    } else if (Array.isArray(value)) {
      if (value.length !== 1) throw new Error(`Param ${part.value} must contain one segment`);
      segments.push(String(value[0]));
    } else {
      segments.push(String(value));
    }
  }
  return segments;
}

function matchProductionRoute(context, rawPathname) {
  const pathname = new URL(String(rawPathname), "http://localhost/").pathname;
  for (const router of context.routers) {
    const relative = pathnameForRouter(pathname, router.prefix);
    if (relative === null) continue;
    const matched = router.router.match(relative);
    if (matched === null) continue;
    const page = routeFiles(matched.route).page;
    const route = context.routesByPage.get(page);
    if (route) return { params: matched.params, route };
  }
  return null;
}

async function paramsForRoute(route) {
  if (!route.dynamic) return [null];
  const callback = route.server.framework.getParams;
  if (typeof callback !== "function") {
    throw new Error(`Framework server entrypoint for ${route.sourceFile} is missing the "getParams" export`);
  }
  const iterator = await callback({ pageModule: route.server.pageModule, layouts: route.server.layouts });
  const pages = [];
  if (iterator?.[Symbol.asyncIterator] !== undefined) {
    for await (const params of iterator) pages.push(params);
  } else if (iterator?.[Symbol.iterator] !== undefined) {
    for (const params of iterator) pages.push(params);
  } else if (Array.isArray(iterator?.pages)) {
    pages.push(...iterator.pages);
  } else {
    throw new TypeError(`Framework getParams() for ${route.sourceFile} did not return an iterator or { pages }`);
  }
  return pages;
}

async function prerenderRoute(context, initialRoute, params) {
  let route = initialRoute;
  let renderParams = params;
  for (let transition = 0; transition < 64; transition += 1) {
    activateRouteManifests(context, route);
    const callback = route.server.framework.prerender;
    if (typeof callback !== "function") {
      throw new Error(`Framework server entrypoint for ${route.sourceFile} is missing the "prerender" export`);
    }
    const metadata = {
      layouts: route.server.layouts,
      modulepreload: route.client.modulepreload,
      modules: route.client.modules,
      pageModule: route.server.pageModule,
      params: renderParams,
      styles: route.server.styles,
    };
    try {
      return await context.runWithResponseContext(
        route.server.pageModule?.streaming ?? false,
        () => callback(metadata),
      );
    } catch (error) {
      if (!(error instanceof Response) || error.status === 302) throw error;
      const location = error.headers.get("location");
      if (!location) throw new Error("Response.render(...) was expected to have a Location header");
      const matched = matchProductionRoute(context, location);
      if (matched === null) throw new Error(`No route found for path: ${new URL(location, "http://localhost/").pathname}`);
      route = matched.route;
      renderParams = matched.params;
    }
  }
  throw new Error(`Response.render() exceeded 64 route transitions for ${initialRoute.sourceFile}`);
}

async function writePrerenderResult(context, route, params, result) {
  if (result === null || typeof result !== "object" || result.files === null || typeof result.files !== "object") {
    throw new Error(`Route ${JSON.stringify(route.sourceFile)} cannot be pre-rendered to a static page.`);
  }
  const routeBase = path.resolve(context.outputRoot, ...routeSegments(route, params));
  const routePrefix = `${routeBase}${path.sep}`;
  await Promise.all(Object.entries(result.files).map(async ([name, value]) => {
    const relative = String(name).replace(/^[/\\]+/, "");
    const destination = path.resolve(routeBase, relative);
    if (destination !== routeBase && !destination.startsWith(routePrefix)) {
      throw new Error(`Invalid prerender output path ${JSON.stringify(name)} for ${route.sourceFile}`);
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    await globalThis.Bun.write(destination, value);
  }));
}

function createRoutes(context, framework) {
  const routerTypes = framework.fileSystemRouterTypes;
  if (!Array.isArray(routerTypes)) throw new TypeError("Missing 'framework.fileSystemRouterTypes'");
  let routeIndex = 0;
  for (let typeIndex = 0; typeIndex < routerTypes.length; typeIndex += 1) {
    const type = routerTypes[typeIndex];
    const prefix = normalizePrefix(type.prefix);
    const router = new FrameworkRouter({
      root: path.resolve(context.projectRoot, String(type.root)),
      style: type.style,
      layouts: type.layouts ?? false,
      ignoreUnderscores: type.ignoreUnderscores,
      ignoreDirs: type.ignoreDirs,
      extensions: type.extensions ?? [".jsx", ".tsx", ".js", ".ts", ".cjs", ".cts", ".mjs", ".mts"],
    });
    const descriptor = {
      clientEntryPoint: type.clientEntryPoint == null ? null : resolveImportSource(context.projectRoot, type.clientEntryPoint),
      prefix,
      router,
      serverEntryPoint: resolveImportSource(context.projectRoot, type.serverEntryPoint),
      typeIndex,
    };
    context.routers.push(descriptor);
    for (const found of router.routes()) {
      const files = routeFiles(found.route);
      if (!files.page) continue;
      const route = {
        ...found,
        ...files,
        clientEntryPoint: descriptor.clientEntryPoint,
        index: routeIndex++,
        prefix,
        router: descriptor,
        serverEntryPoint: descriptor.serverEntryPoint,
        sourceFile: moduleIdForPath(context.projectRoot, files.page),
        typeIndex,
      };
      context.routes.push(route);
      context.routesByPage.set(route.page, route);
    }
  }
}

export async function buildBakeProduction({ entrypoint, outdir = "dist" } = {}, host) {
  const projectRoot = globalThis.process?.cwd?.() ?? ".";
  const outputRoot = path.resolve(projectRoot, outdir);
  const tempRoot = path.join(outputRoot, ".cottontail-bake-server");
  const config = await loadProductionConfig(projectRoot, entrypoint);
  const app = config.app;
  const normalizedFramework = normalizeBakeFramework(app.framework);
  const builtIns = normalizeBuiltInModules(normalizedFramework, projectRoot);
  const framework = resolveFrameworkRuntimeImports(normalizedFramework, projectRoot, builtIns);
  const configuredPlugins = [...(framework.plugins ?? []), ...(app.plugins ?? [])];
  const serverManifest = Object.create(null);
  const ssrManifest = Object.create(null);
  installComponentManifests(serverManifest, ssrManifest);

  const context = {
    app,
    builtIns,
    clientOptions: splitBuildOptions(framework, app, "client"),
    clientPlugins: adaptFrameworkPlugins(configuredPlugins, "client"),
    framework,
    outputRoot,
    projectRoot,
    routers: [],
    routes: [],
    routesByPage: new Map(),
    runWithResponseContext: host.runWithResponseContext,
    serverComponents: framework.serverComponents && typeof framework.serverComponents === "object"
      ? framework.serverComponents
      : null,
    serverManifest,
    serverOptions: splitBuildOptions(framework, app, "server"),
    serverPlugins: adaptFrameworkPlugins(configuredPlugins, "server"),
    ssrFrameworkAliases: {},
    ssrManifest,
    ssrOptions: splitBuildOptions(framework, app, "ssr"),
    tempRoot,
  };
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });

  try {
    createRoutes(context, framework);
    copyStaticRouters(normalizeStaticRouters(framework, projectRoot), outputRoot);
    context.ssrFrameworkAliases = await buildSsrFrameworkAliases(context);

    const graphAlias = { ...(context.serverOptions.alias ?? {}), ...builtIns.alias };
    const graphFiles = { ...(context.serverOptions.files ?? {}), ...builtIns.files };
    for (const route of context.routes) {
      const graph = context.serverComponents === null
        ? { boundaries: [] }
        : discoverClientBoundaries({
            projectRoot,
            roots: [route.page, ...route.layouts],
            alias: graphAlias,
            files: graphFiles,
            builtInSources: builtIns.sources,
          });
      route.boundaries = graph.boundaries;
      route.graphFiles = graph.visited ?? new Set();
      route.client = await writeClientGraph(context, route);
      route.ssrComponents = context.serverComponents !== null
        ? await buildSsrComponents(context, route)
        : new Map();
      activateRouteManifests(context, route);
      route.server = await loadServerRoute(context, route);
    }

    for (const route of context.routes) {
      activateRouteManifests(context, route);
      for (const params of await paramsForRoute(route)) {
        const result = await prerenderRoute(context, route, params);
        await writePrerenderResult(context, route, params, result);
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export default buildBakeProduction;
