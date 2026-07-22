import path from "../node/path.js";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "../node/fs.js";
import reactClientSource from "./bake-react-client.txt";
import reactServerSource from "./bake-react-server.txt";
import reactSsrSource from "./bake-react-ssr.txt";

const javascriptExtensions = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs", ".cts", ".cjs"];
const transpilers = new Map();
const pluginBoundaryPrefix = "cottontail-bake-client-boundary:";
export const ssrGraphBridgePrefix = "cottontail-bake-ssr:";

export function stripBakeGraphAttributes(source) {
  return source.replace(
    /\s+with\s*\{\s*bunBakeGraph\s*:\s*(?:"(?:client|server|ssr)"|'(?:client|server|ssr)')\s*,?\s*\}/g,
    "",
  );
}

function bridgeSsrGraphAttributes(source) {
  const bridged = source.replace(
    /(\b(?:from|import)\s*)(["'])([^"'\\]+)\2\s+with\s*\{\s*bunBakeGraph\s*:\s*(?:"ssr"|'ssr')\s*,?\s*\}/g,
    (_match, prefix, quote, specifier) => `${prefix}${quote}${ssrGraphBridgePrefix}${specifier}${quote}`,
  );
  return stripBakeGraphAttributes(bridged);
}

function builtInReactFramework() {
  return {
    builtInModules: [
      { import: "bun-framework-react/client.tsx", code: reactClientSource },
      { import: "bun-framework-react/server.tsx", code: reactServerSource },
      { import: "bun-framework-react/ssr.tsx", code: reactSsrSource },
    ],
    fileSystemRouterTypes: [{
      root: "pages",
      clientEntryPoint: "bun-framework-react/client.tsx",
      serverEntryPoint: "bun-framework-react/server.tsx",
      extensions: ["jsx", "tsx"],
      style: "nextjs-pages",
      layouts: true,
      ignoreUnderscores: true,
    }],
    staticRouters: ["public"],
    reactFastRefresh: {
      importSource: "react-refresh/runtime",
    },
    serverComponents: {
      separateSSRGraph: true,
      serverRegisterClientReferenceExport: "registerClientReference",
      serverRuntimeImportSource: "react-server-dom-bun/server",
    },
    __cottontailSsrEntryPoints: ["bun-framework-react/ssr.tsx"],
  };
}

export function normalizeBakeFramework(value) {
  if (value === "react") return builtInReactFramework();
  if (value === "react-server-components") {
    console.warn("deprecation notice: 'react-server-components' will be renamed to 'react'");
    return builtInReactFramework();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Framework must be an object");
  }
  return value;
}

export function resolveFrameworkRuntimeImports(framework, projectRoot, builtIns) {
  const serverComponents = framework.serverComponents;
  if (serverComponents === null || typeof serverComponents !== "object") return framework;

  const source = serverComponents.serverRuntimeImportSource;
  if (typeof source !== "string" || source.length === 0) return framework;

  let resolved = builtIns.alias[source];
  if (resolved === undefined && /^\.\.?[\\/]/.test(source)) {
    resolved = path.resolve(projectRoot, source);
  }
  if (resolved === undefined || resolved === source) return framework;

  return {
    ...framework,
    serverComponents: {
      ...serverComponents,
      serverRuntimeImportSource: resolved,
    },
  };
}

function sourceText(value) {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value);
  return null;
}

export function normalizeBuiltInModules(framework, projectRoot) {
  const alias = {};
  const files = {};
  const sources = new Map();
  const modules = framework.builtInModules ?? [];
  if (!Array.isArray(modules)) throw new TypeError("'framework.builtInModules' must be an array");

  for (let index = 0; index < modules.length; index += 1) {
    const item = modules[index];
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`'builtInModules[${index}]' is not an object`);
    }
    if (typeof item.import !== "string" || item.import.length === 0) {
      throw new TypeError(`'builtInModules[${index}]' is missing 'import'`);
    }

    let resolved;
    let source = null;
    if (typeof item.path === "string") {
      resolved = path.isAbsolute(item.path) ? item.path : path.resolve(projectRoot, item.path);
    } else if (typeof item.code === "string") {
      const extension = path.extname(item.import) || ".js";
      resolved = path.join(projectRoot, ".cottontail-bake-builtins", `module-${index}${extension}`);
      source = stripBakeGraphAttributes(item.code);
      files[resolved] = source;
      sources.set(path.normalize(resolved), item.code);
    } else {
      throw new TypeError(`'builtInModules[${index}]' needs either 'path' or 'code'`);
    }

    alias[item.import] = resolved;
  }

  return { alias, files, sources };
}

export function bakeGraphAttributeFiles(paths, files = {}, options = {}) {
  const overrides = {};
  for (const filename of paths) {
    if (typeof filename !== "string" || !path.isAbsolute(filename)) continue;
    let source = sourceText(options.sources?.get(path.normalize(filename))) ?? sourceText(files[filename]);
    if (source === null) {
      try {
        source = readFileSync(filename, "utf8");
      } catch {
        continue;
      }
    }
    const transformed = options.ssrBridge ? bridgeSsrGraphAttributes(source) : stripBakeGraphAttributes(source);
    if (transformed !== source) overrides[filename] = transformed;
  }
  return overrides;
}

export function frameworkBuildOptions(options, builtIns, extraFiles = undefined) {
  return {
    ...options,
    alias: {
      ...(options.alias ?? {}),
      ...builtIns.alias,
    },
    files: {
      ...(options.files ?? {}),
      ...builtIns.files,
      ...(extraFiles ?? {}),
    },
    // Built-in framework sources are part of Cottontail's embedded runtime
    // directory, including when no source checkout is present on disk.
    includeRuntimeModules: true,
  };
}

function skipSpaceAndComments(source, offset) {
  while (offset < source.length) {
    const code = source.charCodeAt(offset);
    if (code === 0xfeff || code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32) {
      offset += 1;
      continue;
    }
    if (source.startsWith("//", offset)) {
      const newline = source.indexOf("\n", offset + 2);
      return newline < 0 ? source.length : skipSpaceAndComments(source, newline + 1);
    }
    if (source.startsWith("/*", offset)) {
      const end = source.indexOf("*/", offset + 2);
      return end < 0 ? source.length : skipSpaceAndComments(source, end + 2);
    }
    break;
  }
  return offset;
}

function readDirective(source, offset) {
  const quote = source[offset];
  if (quote !== '"' && quote !== "'") return null;
  let value = "";
  let cursor = offset + 1;
  while (cursor < source.length) {
    const character = source[cursor++];
    if (character === quote) {
      let end = cursor;
      while (source[end] === " " || source[end] === "\t" || source[end] === "\v" || source[end] === "\f") end += 1;
      if (source[end] === ";") return { value, end: end + 1 };
      if (source[end] === "\n" || source[end] === "\r" || source[end] === undefined || source.startsWith("//", end)) {
        return { value, end };
      }
      if (source.startsWith("/*", end)) {
        const commentEnd = source.indexOf("*/", end + 2);
        if (commentEnd < 0) return { value, end: source.length };
        const comment = source.slice(end, commentEnd + 2);
        const afterComment = commentEnd + 2;
        if (comment.includes("\n") || comment.includes("\r") || source[afterComment] === ";") {
          return { value, end: source[afterComment] === ";" ? afterComment + 1 : afterComment };
        }
      }
      return null;
    }
    if (character === "\n" || character === "\r") return null;
    if (character !== "\\") {
      value += character;
      continue;
    }
    if (cursor >= source.length) return null;
    const escaped = source[cursor++];
    const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", 0: "\0" };
    value += escapes[escaped] ?? escaped;
  }
  return null;
}

export function hasUseClientDirective(source) {
  let offset = 0;
  if (source.startsWith("#!")) {
    const newline = source.indexOf("\n");
    offset = newline < 0 ? source.length : newline + 1;
  }
  while (true) {
    offset = skipSpaceAndComments(source, offset);
    const directive = readDirective(source, offset);
    if (directive === null) return false;
    if (directive.value === "use client") return true;
    offset = directive.end;
  }
}

function loaderForModule(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case ".tsx": return "tsx";
    case ".ts":
    case ".mts":
    case ".cts": return "ts";
    case ".jsx": return "jsx";
    default: return "js";
  }
}

function transpilerFor(filename) {
  const loader = loaderForModule(filename);
  return transpilerForLoader(loader);
}

function transpilerForLoader(loader) {
  let transpiler = transpilers.get(loader);
  if (transpiler === undefined) {
    transpiler = new globalThis.Bun.Transpiler({ loader });
    transpilers.set(loader, transpiler);
  }
  return transpiler;
}

function fileExists(filename, files) {
  if (Object.prototype.hasOwnProperty.call(files, filename)) return true;
  try {
    return statSync(filename).isFile();
  } catch {
    return false;
  }
}

function resolveFile(base, files) {
  const candidates = [base];
  if (!path.extname(base)) {
    for (const extension of javascriptExtensions) candidates.push(`${base}${extension}`);
    for (const extension of javascriptExtensions) candidates.push(path.join(base, `index${extension}`));
  }
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (fileExists(normalized, files)) return normalized;
  }
  return null;
}

function applyAlias(specifier, aliases) {
  if (Object.prototype.hasOwnProperty.call(aliases, specifier)) return String(aliases[specifier]);
  let best = null;
  for (const key of Object.keys(aliases)) {
    if (!specifier.startsWith(`${key}/`)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  if (best === null) return specifier;
  return `${aliases[best]}${specifier.slice(best.length)}`;
}

export function resolveBakeImport(importer, rawSpecifier, { alias = {}, files = {} } = {}) {
  let specifier = String(rawSpecifier);
  const suffix = specifier.search(/[?#]/);
  if (suffix >= 0) specifier = specifier.slice(0, suffix);
  specifier = applyAlias(specifier, alias);
  if (/^(?:bun|node|data|https?):/.test(specifier) || specifier.startsWith("#")) return null;

  if (path.isAbsolute(specifier)) return resolveFile(specifier, files);
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveFile(path.resolve(path.dirname(importer), specifier), files);
  }

  try {
    const resolved = globalThis.Bun.resolveSync(specifier, path.dirname(importer));
    return resolveFile(resolved, files);
  } catch {
    return null;
  }
}

function readModuleSource(filename, files, builtInSources) {
  const normalized = path.normalize(filename);
  const virtual = sourceText(files[normalized] ?? files[filename]);
  if (virtual !== null) return virtual;
  const builtIn = builtInSources?.get(normalized);
  if (builtIn !== undefined) return builtIn;
  return readFileSync(filename, "utf8");
}

export function moduleIdForPath(projectRoot, filename) {
  const relative = path.relative(projectRoot, filename).split(path.sep).join("/");
  return relative || path.basename(filename);
}

export function discoverClientBoundaries({
  projectRoot,
  roots,
  alias = {},
  files = {},
  builtInSources = null,
}) {
  const boundaries = [];
  const visited = new Set();

  const visit = filename => {
    filename = path.normalize(filename);
    if (visited.has(filename)) return;
    visited.add(filename);

    // Custom loaders are scanned after plugin onLoad callbacks have produced
    // JavaScript in pluginClientBoundaryReplacements().
    if (!javascriptExtensions.includes(path.extname(filename).toLowerCase())) return;

    let source;
    try {
      source = readModuleSource(filename, files, builtInSources);
    } catch {
      return;
    }
    if (hasUseClientDirective(source)) {
      const scan = transpilerFor(filename).scan(source);
      boundaries.push({
        path: filename,
        id: moduleIdForPath(projectRoot, filename),
        exports: [...new Set(scan.exports ?? [])],
        source,
      });
      return;
    }

    const scan = transpilerFor(filename).scan(source);
    for (const imported of scan.imports ?? []) {
      if (imported.kind !== "import-statement" && imported.kind !== "dynamic-import") continue;
      const resolved = resolveBakeImport(filename, imported.path, { alias, files });
      if (resolved !== null && javascriptExtensions.includes(path.extname(resolved).toLowerCase())) visit(resolved);
    }
  };

  for (const root of roots) {
    const resolved = resolveFile(path.normalize(root), files);
    if (resolved !== null) visit(resolved);
  }
  boundaries.sort((left, right) => left.id.localeCompare(right.id));
  return { boundaries, visited };
}

export function clientReferenceProxySource(boundary, serverComponents) {
  const runtime = serverComponents.serverRuntimeImportSource;
  const register = serverComponents.serverRegisterClientReferenceExport ?? "registerClientReference";
  if (typeof runtime !== "string" || runtime.length === 0) {
    throw new TypeError("Missing 'framework.serverComponents.serverRuntimeImportSource'");
  }

  const lines = [`import { ${register} as __ctRegisterClientReference } from ${JSON.stringify(runtime)};`];
  boundary.exports.forEach((name, index) => {
    const message = name === "default"
      ? `Attempted to call the default export of ${boundary.id} from the server, but it's on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.`
      : `Attempted to call ${name}() from the server but ${name} is on the client. It's not possible to invoke a client function from the server, it can only be rendered as a Component or passed to props of a Client Component.`;
    const local = `__ctClientReference${index}`;
    lines.push(`const ${local} = __ctRegisterClientReference(() => { throw new Error(${JSON.stringify(message)}); }, ${JSON.stringify(boundary.id)}, ${JSON.stringify(name)});`);
    lines.push(name === "default" ? `export default ${local};` : `export { ${local} as ${JSON.stringify(name)} };`);
  });
  return `${lines.join("\n")}\n`;
}

export function pluginClientBoundaryReplacements({
  projectRoot,
  modules,
  boundaries,
  serverComponents,
}) {
  const replacements = new Map();
  const boundaryIndexes = new Map(boundaries.map((boundary, index) => [boundary.id, index]));
  for (const module of modules) {
    if (!["js", "jsx", "ts", "tsx"].includes(module.loader)) continue;
    const source = sourceText(module.contents);
    if (source === null || !hasUseClientDirective(source)) continue;

    const namespace = String(module.namespace || "file");
    const modulePath = String(module.path);
    const id = String(module.id || (namespace === "file"
      ? moduleIdForPath(projectRoot, path.normalize(modulePath))
      : `${namespace}:${modulePath}`));
    const hash = BigInt.asUintN(64, globalThis.Bun.hash(`${namespace}\0${modulePath}`)).toString(16);
    const scan = transpilerForLoader(module.loader).scan(source);
    const boundary = {
      path: `${pluginBoundaryPrefix}${hash}`,
      id,
      exports: [...new Set(scan.exports ?? [])],
      source,
      __pluginTarget: { path: modulePath, namespace },
    };
    const existingIndex = boundaryIndexes.get(id);
    if (existingIndex === undefined) {
      boundaryIndexes.set(id, boundaries.length);
      boundaries.push(boundary);
    } else {
      boundaries[existingIndex] = boundary;
    }
    replacements.set(module.key, clientReferenceProxySource(boundary, serverComponents));
  }
  boundaries.sort((left, right) => left.id.localeCompare(right.id));
  return replacements;
}

export function pluginBoundaryResolverPlugin(boundaries) {
  const targets = new Map(boundaries
    .filter(boundary => boundary.__pluginTarget !== undefined)
    .map(boundary => [boundary.path, boundary.__pluginTarget]));
  return {
    name: "cottontail-bake-client-boundaries",
    setup(build) {
      build.onResolve({ filter: /^cottontail-bake-client-boundary:/ }, args => targets.get(args.path));
    },
  };
}

export function serverBoundaryFiles(boundaries, serverComponents) {
  const files = {};
  for (const boundary of boundaries) files[boundary.path] = clientReferenceProxySource(boundary, serverComponents);
  return files;
}

function normalizeStaticPrefix(value) {
  let prefix = value == null ? "/" : String(value);
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  while (prefix.length > 1 && prefix.endsWith("/")) prefix = prefix.slice(0, -1);
  return prefix;
}

export function normalizeStaticRouters(framework, projectRoot) {
  const configured = framework.staticRouters ?? [];
  if (!Array.isArray(configured)) throw new TypeError("'framework.staticRouters' must be an array");
  return configured.map((item, index) => {
    const object = typeof item === "string" ? { source: item } : item;
    if (object === null || typeof object !== "object" || typeof object.source !== "string") {
      throw new TypeError(`'staticRouters[${index}]' must be a string or an object with a source`);
    }
    return {
      source: path.resolve(projectRoot, object.source),
      prefix: normalizeStaticPrefix(object.prefix),
    };
  });
}

export function staticRouterFile(routers, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  for (const router of routers) {
    if (router.prefix !== "/" && decoded !== router.prefix && !decoded.startsWith(`${router.prefix}/`)) continue;
    const relative = router.prefix === "/" ? decoded.slice(1) : decoded.slice(router.prefix.length).replace(/^\//, "");
    const filename = path.resolve(router.source, relative || "index.html");
    const sourcePrefix = `${path.resolve(router.source)}${path.sep}`;
    if (filename !== path.resolve(router.source) && !filename.startsWith(sourcePrefix)) continue;
    try {
      if (statSync(filename).isFile()) return filename;
      const index = path.join(filename, "index.html");
      if (statSync(index).isFile()) return index;
    } catch {}
  }
  return null;
}

function visitStaticFiles(root, callback, directory = root) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visitStaticFiles(root, callback, absolute);
    else if (entry.isFile()) callback(absolute, path.relative(root, absolute));
  }
}

export function copyStaticRouters(routers, outputRoot) {
  for (const router of routers) {
    const prefix = router.prefix === "/" ? "" : router.prefix.slice(1);
    visitStaticFiles(router.source, (source, relative) => {
      const destination = path.join(outputRoot, prefix, relative);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(source));
    });
  }
}

export function contentTypeForStaticFile(filename) {
  switch (path.extname(filename).toLowerCase()) {
    case ".html":
    case ".htm": return "text/html; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".json": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".wasm": return "application/wasm";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}
