const capabilityCache = globalThis[Symbol.for("cottontail.capabilityModuleCache")] ??= new Map();

function capabilityError(name, detail = "") {
  const suffix = detail ? ` (${detail})` : "";
  return new Error(
    `Cottontail capability "${name}" is unavailable${suffix}. ` +
    `Add "${name}" to build.cottontail.capabilities in electrobun.config.ts.`,
  );
}

function loadCapabilityModule(name, modulePath) {
  const normalizedName = String(name);
  let pack = capabilityCache.get(normalizedName);
  if (pack == null) {
    for (const key of [
      "__cottontailBundlePath",
      "__cottontailBundleSourceMap",
      "__cottontailBundleSourceMapData",
      "__cottontailBundleSourceRoot",
    ]) {
      if (cottontail[key] === undefined && globalThis[key] !== undefined) cottontail[key] = globalThis[key];
    }
    const executable = String(cottontail.execPath?.() ?? globalThis.process?.execPath ?? "").replaceAll("\\", "/");
    const directory = executable.slice(0, executable.lastIndexOf("/"));
    const capabilityPath = `${directory}/cottontail-stdlib/${normalizedName}/main.jsc`;
    try {
      pack = cottontail.loadCapabilityBytecode(capabilityPath);
    } catch (error) {
      const detail = String(error?.message ?? error);
      if (/failed to open capability bytecode/i.test(detail)) throw capabilityError(normalizedName);
      throw capabilityError(normalizedName, detail);
    }
    if (pack?.modules == null || typeof pack.modules !== "object") {
      throw capabilityError(normalizedName, "bytecode did not provide modules");
    }
    capabilityCache.set(normalizedName, pack);
  }
  const namespace = pack.modules?.[modulePath];
  if (namespace == null) throw capabilityError(normalizedName, `missing module ${modulePath}`);
  return namespace;
}

function installCapabilityNamespace(parent, definitions) {
  for (const [property, capability, modulePath, facadePath, facadeSpecifier] of definitions) {
    Object.defineProperty(parent, property, {
      configurable: true,
      get() {
        let facadeNamespace;
        if (facadePath !== undefined) {
          const loadEmbedded = globalThis[Symbol.for("cottontail.internal.loadEmbeddedRuntimeModule")];
          if (typeof loadEmbedded === "function") facadeNamespace = loadEmbedded(facadePath);
        }
        const capabilityNamespace = loadCapabilityModule(capability, modulePath);
        const value = facadeSpecifier !== undefined && typeof globalThis.require === "function"
          ? globalThis.require(facadeSpecifier)
          : facadeNamespace ?? capabilityNamespace;
        Object.defineProperty(parent, property, { value, configurable: true });
        return value;
      },
    });
  }
}

const cottontailNamespace = globalThis.Cottontail ?? {};
if (globalThis.Cottontail == null) {
  Object.defineProperty(globalThis, "Cottontail", {
    value: cottontailNamespace,
    configurable: true,
  });
}

installCapabilityNamespace(cottontailNamespace, [
  ["sqlite", "sqlite", "bun/sqlite.js", "bun/sqlite-capability.js", "bun:sqlite"],
  ["ffi", "ffi", "bun/ffi-implementation.js", "bun/ffi-capability.js", "bun:ffi"],
  ["redis", "redis", "bun/redis.js"],
  ["s3", "s3", "bun/s3.js"],
  ["toml", "toml", "bun/toml.js"],
  ["json5", "json5", "bun/json5.js"],
  ["colors", "colors", "bun/color.js"],
  ["jscTools", "jsc-tools", "bun/jsc.js", "bun/jsc-capability.js", "bun:jsc"],
  ["yaml", "yaml", "bun/yaml.js"],
  ["sql", "sql", "bun/sql.js"],
  ["test", "test", "bun/test.js", "bun/test-capability.js", "bun:test"],
  ["shell", "shell", "bun/shell.js"],
  ["build", "build", "bun/build.js"],
  ["bake", "bake", "bun/bake-dev-server.js"],
  ["cookies", "cookies", "bun/cookie.js"],
  ["websocket", "websocket", "vendor/ws.js", "vendor/ws-capability.js", "ws"],
  ["glob", "glob", "bun/glob.js"],
  ["text", "text", "bun/text.js"],
  ["uuid", "uuid", "bun/uuid.js"],
  ["password", "password", "bun/password.js"],
  ["hashing", "hashing", "bun/hashing.js"],
  ["data", "data", "bun/data.js"],
  ["markdown", "markdown", "bun/markdown.js"],
  ["compression", "compression", "node/zlib.js", "node/zlib-capability.js", "node:zlib"],
  ["archive", "archive", "bun/archive.js"],
  ["filesystemRouter", "filesystem-router", "bun/filesystem-router.js"],
  ["htmlRewriter", "html-rewriter", "bun/html-rewriter.js"],
  ["terminal", "terminal", "bun/terminal.js"],
  ["csrf", "csrf", "bun/csrf.js"],
  ["secrets", "secrets", "bun/secrets.js"],
]);

const nodeNamespace = cottontailNamespace.node ?? {};
installCapabilityNamespace(nodeNamespace, [
  ["inspector", "inspector", "node/inspector.js"],
  ["repl", "repl", "node/repl.js"],
  ["sea", "sea", "node/sea.js"],
  ["sqlite", "sqlite", "node/sqlite.js", "node/sqlite-capability.js", "node:sqlite"],
  ["test", "test", "node/test.js", "node/test-capability.js", "node:test"],
  ["zlib", "compression", "node/zlib.js", "node/zlib-capability.js", "node:zlib"],
]);
Object.defineProperty(cottontailNamespace, "node", {
  value: nodeNamespace,
  configurable: true,
});

const bunNamespace = cottontailNamespace.bun ?? {};
installCapabilityNamespace(bunNamespace, [
  ["archive", "archive", "bun/archive.js"],
  ["bake", "bake", "bun/bake-dev-server.js"],
  ["build", "build", "bun/build.js"],
  ["color", "colors", "bun/color.js"],
  ["cookie", "cookies", "bun/cookie.js"],
  ["data", "data", "bun/data.js"],
  ["ffi", "ffi", "bun/ffi-implementation.js", "bun/ffi-capability.js", "bun:ffi"],
  ["filesystemRouter", "filesystem-router", "bun/filesystem-router.js"],
  ["glob", "glob", "bun/glob.js"],
  ["hashing", "hashing", "bun/hashing.js"],
  ["htmlRewriter", "html-rewriter", "bun/html-rewriter.js"],
  ["jsc", "jsc-tools", "bun/jsc.js", "bun/jsc-capability.js", "bun:jsc"],
  ["json5", "json5", "bun/json5.js"],
  ["markdown", "markdown", "bun/markdown.js"],
  ["password", "password", "bun/password.js"],
  ["redis", "redis", "bun/redis.js"],
  ["s3", "s3", "bun/s3.js"],
  ["secrets", "secrets", "bun/secrets.js"],
  ["shell", "shell", "bun/shell.js"],
  ["sql", "sql", "bun/sql.js"],
  ["sqlite", "sqlite", "bun/sqlite.js", "bun/sqlite-capability.js", "bun:sqlite"],
  ["terminal", "terminal", "bun/terminal.js"],
  ["test", "test", "bun/test.js", "bun/test-capability.js", "bun:test"],
  ["text", "text", "bun/text.js"],
  ["toml", "toml", "bun/toml.js"],
  ["uuid", "uuid", "bun/uuid.js"],
  ["websocket", "websocket", "vendor/ws.js", "vendor/ws-capability.js", "ws"],
  ["yaml", "yaml", "bun/yaml.js"],
]);
Object.defineProperty(cottontailNamespace, "bun", {
  value: bunNamespace,
  configurable: true,
});

export { cottontailNamespace as Cottontail, loadCapabilityModule };
export default cottontailNamespace;
