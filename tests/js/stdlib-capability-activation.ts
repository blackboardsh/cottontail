import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const stdlibDirectory = join(dirname(process.execPath), "cottontail-stdlib");
const manifestPath = join(stdlibDirectory, "capabilities.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest?.schema !== 1 || manifest.capabilities == null || typeof manifest.capabilities !== "object") {
  throw new Error(`invalid Cottontail capability manifest: ${manifestPath}`);
}

const installedCapabilityDirectories = readdirSync(stdlibDirectory, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();
const manifestCapabilities = Object.keys(manifest.capabilities).sort();
if (JSON.stringify(manifestCapabilities) !== JSON.stringify(installedCapabilityDirectories)) {
  throw new Error(
    `capability manifest catalog does not match installed directories: ` +
    `${JSON.stringify(manifestCapabilities)} !== ${JSON.stringify(installedCapabilityDirectories)}`,
  );
}

const observedEdges = Object.fromEntries(
  manifestCapabilities
    .map(name => [name, [...manifest.capabilities[name].requires].sort()] as const)
    .filter(([, requires]) => requires.length > 0),
);
const expectedEdges = {
  archive: ["compression"],
  bake: ["build", "hashing"],
  "filesystem-router": ["glob"],
  "html-rewriter": ["text"],
  repl: ["terminal"],
  sql: ["sqlite"],
  test: ["glob", "shell", "toml"],
};
if (JSON.stringify(observedEdges) !== JSON.stringify(expectedEdges)) {
  throw new Error(
    `unexpected generated capability dependency edges: ` +
    `${JSON.stringify(observedEdges)} !== ${JSON.stringify(expectedEdges)}`,
  );
}

const capabilities = [
  "ffi", "sqlite", "sql", "redis", "s3", "toml", "json5", "colors",
  "cookies", "websocket", "jscTools", "yaml", "test", "shell", "build",
  "bake", "glob", "text", "uuid", "password", "hashing", "data",
  "markdown", "compression", "archive", "filesystemRouter", "htmlRewriter",
  "terminal", "csrf", "secrets",
] as const;

for (const name of capabilities) {
  console.log(`activating Cottontail.${name}`);
  const namespace = Cottontail[name];
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) {
    throw new Error(`Cottontail.${name} did not activate a capability namespace`);
  }
}

for (const name of ["inspector", "repl", "sea", "sqlite", "test", "zlib"] as const) {
  console.log(`activating Cottontail.node.${name}`);
  const namespace = Cottontail.node[name];
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) {
    throw new Error(`Cottontail.node.${name} did not activate a capability namespace`);
  }
}

for (const name of ["ffi", "sqlite", "sql", "yaml", "jsc", "build"] as const) {
  console.log(`activating Cottontail.bun.${name}`);
  const namespace = Cottontail.bun[name];
  if (namespace == null || (typeof namespace !== "object" && typeof namespace !== "function")) {
    throw new Error(`Cottontail.bun.${name} did not activate a capability namespace`);
  }
}

console.log("stdlib capability activation passed");
