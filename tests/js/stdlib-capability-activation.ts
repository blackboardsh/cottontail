const capabilities = [
  "ffi", "sqlite", "sql", "redis", "s3", "toml", "json5", "colors",
  "cookies", "websocket", "jscTools", "yaml", "test", "shell", "build",
  "bake", "glob", "text", "uuid", "password", "hashing", "data",
  "markdown", "compression", "archive", "filesystemRouter", "htmlRewriter",
  "terminal", "csrf", "secrets",
] as const;

for (const name of capabilities) {
  const namespace = Cottontail[name];
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) {
    throw new Error(`Cottontail.${name} did not activate a capability namespace`);
  }
}

for (const name of ["inspector", "repl", "sea", "sqlite", "test", "zlib"] as const) {
  const namespace = Cottontail.node[name];
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) {
    throw new Error(`Cottontail.node.${name} did not activate a capability namespace`);
  }
}

for (const name of ["ffi", "sqlite", "sql", "yaml", "jsc", "build"] as const) {
  const namespace = Cottontail.bun[name];
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) {
    throw new Error(`Cottontail.bun.${name} did not activate a capability namespace`);
  }
}

console.log("stdlib capability activation passed");
