{
const cacheKey = Symbol.for("cottontail.capabilityModuleCache");
const cache = globalThis[cacheKey] || (globalThis[cacheKey] = new Map());
const runtimeModuleCache = new Map();

const load = (name, path) => {
  let pack = cache.get(name);
  if (pack == null) {
    const executable = String(cottontail.execPath ? cottontail.execPath() : "")
      .split(String.fromCharCode(92)).join("/");
    const directory = executable.slice(0, executable.lastIndexOf("/"));
    try {
      pack = cottontail.loadCapabilityBytecode(directory + "/cottontail-stdlib/" + name + "/main.jsc");
    } catch (error) {
      const detail = String(error && error.message != null ? error.message : error);
      throw new Error("Cottontail capability " + name + " is unavailable (" + detail + "). Add " + name + " to build.cottontail.capabilities in electrobun.config.ts.");
    }
    if (!pack || !pack.modules || typeof pack.modules !== "object") {
      throw new Error("Cottontail capability " + name + " did not provide modules");
    }
    cache.set(name, pack);
  }
  const value = pack.modules[path];
  if (value == null) throw new Error("Cottontail capability " + name + " is missing module " + path);
  return value;
};

const capabilityRequire = specifier => {
  const text = String(specifier);
  if (text === "cottontail:core-bootstrap" || text.endsWith("/bun/core-bootstrap.js")) {
    const loadEmbedded = globalThis[Symbol.for("cottontail.internal.loadEmbeddedRuntimeModule")];
    if (typeof loadEmbedded === "function") return loadEmbedded("bun/core-bootstrap.js") ?? {};
    return {};
  }
  const capabilityAlias = {
    "bun:ffi": ["ffi", "bun/ffi-implementation.js"],
    "bun:jsc": ["jsc-tools", "bun/jsc.js"],
    "bun:sqlite": ["sqlite", "bun/sqlite.js"],
    "bun:sql": ["sql", "bun/sql.js"],
    "bun:test": ["test", "bun/test.js"],
    "node:zlib": ["compression", "node/zlib.js"],
  }[text];
  if (capabilityAlias) return load(capabilityAlias[0], capabilityAlias[1]);

  const filename = text.split("/").pop();
  const name = (filename || text).replace(/\.js$/, "").replace(/^node:/, "");
  const canonical = `node:${name}`;
  if (runtimeModuleCache.has(canonical)) return runtimeModuleCache.get(canonical);
  // Prefer an already-evaluated embedded builtin. Loading its split bytecode
  // again can duplicate module-local state (notably async_hooks) even when a
  // module anchors its public constructor on globalThis.
  const embeddedBuiltins = globalThis.__cottontailBuiltinModules;
  if (embeddedBuiltins && embeddedBuiltins.has(canonical)) {
    let value = embeddedBuiltins.get(canonical);
    if (typeof value === "function" && value[Symbol.for("cottontail.lazyBuiltin")] === true) {
      value = value();
    }
    runtimeModuleCache.set(canonical, value);
    return value;
  }
  const executable = String(cottontail.execPath ? cottontail.execPath() : "")
    .split(String.fromCharCode(92)).join("/");
  const directory = executable.slice(0, executable.lastIndexOf("/"));
  const pack = cottontail.loadCapabilityBytecode(directory + "/cottontail-core/runtime/" + name + ".jsc");
  const namespace = pack && pack.modules && pack.modules[canonical];
  if (namespace == null) throw new Error("Cottontail core runtime module " + canonical + " is unavailable");
  const value = namespace.default == null ? namespace : namespace.default;
  runtimeModuleCache.set(canonical, value);
  return value;
};
globalThis[Symbol.for("cottontail.capabilityRequire")] = capabilityRequire;

const makeNamespace = (definitions, initial) => {
  const target = initial || {};
  const values = new Map();
  for (const definition of definitions) {
    const property = definition[0];
    Object.defineProperty(target, property, {
      configurable: true,
      get() {
        if (values.has(property)) return values.get(property);
        const value = load(definition[1], definition[2]);
        values.set(property, value);
        return value;
      },
    });
  }
  return target;
};

const rootDefinitions = [
  ["sqlite", "sqlite", "bun/sqlite.js"], ["ffi", "ffi", "bun/ffi-implementation.js"],
  ["redis", "redis", "bun/redis.js"], ["s3", "s3", "bun/s3.js"], ["toml", "toml", "bun/toml.js"],
  ["json5", "json5", "bun/json5.js"], ["colors", "colors", "bun/color.js"],
  ["jscTools", "jsc-tools", "bun/jsc.js"], ["yaml", "yaml", "bun/yaml.js"], ["sql", "sql", "bun/sql.js"],
  ["test", "test", "bun/test.js"], ["shell", "shell", "bun/shell.js"], ["build", "build", "bun/build.js"],
  ["bake", "bake", "bun/bake-dev-server.js"], ["cookies", "cookies", "bun/cookie.js"],
  ["websocket", "websocket", "vendor/ws.js"], ["glob", "glob", "bun/glob.js"], ["text", "text", "bun/text.js"],
  ["uuid", "uuid", "bun/uuid.js"], ["password", "password", "bun/password.js"],
  ["hashing", "hashing", "bun/hashing.js"], ["data", "data", "bun/data.js"],
  ["markdown", "markdown", "bun/markdown.js"], ["compression", "compression", "node/zlib.js"],
  ["archive", "archive", "bun/archive.js"], ["filesystemRouter", "filesystem-router", "bun/filesystem-router.js"],
  ["htmlRewriter", "html-rewriter", "bun/html-rewriter.js"], ["terminal", "terminal", "bun/terminal.js"],
  ["csrf", "csrf", "bun/csrf.js"], ["secrets", "secrets", "bun/secrets.js"],
];

const nodeDefinitions = [
  ["inspector", "inspector", "node/inspector.js"], ["repl", "repl", "node/repl.js"],
  ["sea", "sea", "node/sea.js"], ["sqlite", "sqlite", "node/sqlite.js"],
  ["test", "test", "node/test.js"], ["zlib", "compression", "node/zlib.js"],
];

const bunDefinitions = [
  ["archive", "archive", "bun/archive.js"], ["bake", "bake", "bun/bake-dev-server.js"],
  ["build", "build", "bun/build.js"], ["color", "colors", "bun/color.js"],
  ["cookie", "cookies", "bun/cookie.js"], ["data", "data", "bun/data.js"],
  ["ffi", "ffi", "bun/ffi-implementation.js"], ["filesystemRouter", "filesystem-router", "bun/filesystem-router.js"],
  ["glob", "glob", "bun/glob.js"], ["hashing", "hashing", "bun/hashing.js"],
  ["htmlRewriter", "html-rewriter", "bun/html-rewriter.js"], ["jsc", "jsc-tools", "bun/jsc.js"],
  ["json5", "json5", "bun/json5.js"], ["markdown", "markdown", "bun/markdown.js"],
  ["password", "password", "bun/password.js"], ["redis", "redis", "bun/redis.js"],
  ["s3", "s3", "bun/s3.js"], ["secrets", "secrets", "bun/secrets.js"],
  ["shell", "shell", "bun/shell.js"], ["sql", "sql", "bun/sql.js"],
  ["sqlite", "sqlite", "bun/sqlite.js"], ["terminal", "terminal", "bun/terminal.js"],
  ["test", "test", "bun/test.js"], ["text", "text", "bun/text.js"],
  ["toml", "toml", "bun/toml.js"], ["uuid", "uuid", "bun/uuid.js"],
  ["websocket", "websocket", "vendor/ws.js"], ["yaml", "yaml", "bun/yaml.js"],
];

const node = makeNamespace(nodeDefinitions);
const bun = makeNamespace(bunDefinitions);
globalThis.Cottontail = makeNamespace(rootDefinitions, { node, bun });
}
