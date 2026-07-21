import { readFileSync } from "../node/fs.js";
import { resolve } from "../node/path.js";
import { parse as parseTOML } from "../bun/toml.js";

const argv = Array.from(globalThis.process?.argv ?? []).slice(2).map(String);
let cachedConfig;

function configuredPath() {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--config=")) return argument.slice("--config=".length);
    if (argument.startsWith("-c=")) return argument.slice("-c=".length);
    if ((argument === "--config" || argument === "-c") && index + 1 < argv.length) {
      return argv[index + 1];
    }
  }
  return "bunfig.toml";
}

export function bunTestConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  const cwd = String(globalThis.process?.cwd?.() ?? ".");
  const path = resolve(cwd, configuredPath());
  try {
    const document = parseTOML(String(readFileSync(path, "utf8")));
    cachedConfig = document?.test && typeof document.test === "object" ? document.test : Object.create(null);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    cachedConfig = Object.create(null);
  }
  return cachedConfig;
}
