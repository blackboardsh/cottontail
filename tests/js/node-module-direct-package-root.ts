import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

const root = join(process.env.COTTONTAIL_TMP_DIR || "/tmp", `cottontail-direct-package-${process.pid}`);
rmSync(root, { recursive: true, force: true });

try {
  const wrapperDir = join(root, "@biomejs", "biome", "bin");
  const nativeDir = join(root, "@biomejs", "cli-darwin-arm64");
  mkdirSync(wrapperDir, { recursive: true });
  mkdirSync(nativeDir, { recursive: true });
  writeFileSync(join(root, "@biomejs", "biome", "package.json"), JSON.stringify({ name: "@biomejs/biome" }));
  writeFileSync(join(nativeDir, "package.json"), JSON.stringify({ name: "@biomejs/cli-darwin-arm64" }));
  writeFileSync(join(nativeDir, "biome"), "#!/bin/sh\n");

  const require = createRequire(join(wrapperDir, "biome"));
  const resolved = require.resolve("@biomejs/cli-darwin-arm64/biome");

  assert(resolved === join(nativeDir, "biome"), `direct package root resolve mismatch: ${resolved}`);
  console.log("node module direct package root passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
