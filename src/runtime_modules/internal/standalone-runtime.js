import { parse as parseToml } from "../bun/toml.js";
import { dirname, resolve } from "../node/path.js";

export function installStandaloneRuntimeLoaders(processObject = globalThis.process) {
  globalThis.__cottontailLoadStandaloneBunfig = async function __cottontailLoadStandaloneBunfig() {
    const flags = globalThis.__cottontailStandaloneFlags;
    if (flags == null || globalThis.__cottontailStandaloneBunfigLoaded) return;

    let explicitConfig;
    const execArgv = (processObject ?? globalThis.process)?.execArgv ?? [];
    for (let index = 0; index < execArgv.length; index += 1) {
      const argument = String(execArgv[index]);
      if (argument === "--config" || argument === "-c") {
        if (index + 1 < execArgv.length) explicitConfig = String(execArgv[++index]);
      } else if (argument.startsWith("--config=")) {
        explicitConfig = argument.slice("--config=".length);
      } else if (argument.startsWith("-c=")) {
        explicitConfig = argument.slice("-c=".length);
      }
    }
    if (explicitConfig === undefined && flags.disableAutoloadBunfig === true) return;

    const configPath = resolve(cottontail.cwd(), explicitConfig ?? "bunfig.toml");
    let contents;
    try {
      contents = cottontail.readFile(configPath);
    } catch (error) {
      if (explicitConfig !== undefined) throw error;
      return;
    }

    globalThis.__cottontailStandaloneBunfigLoaded = true;
    const configured = parseToml(contents)?.preload;
    const preloads = configured == null ? [] : Array.isArray(configured) ? configured : [configured];
    for (const preload of preloads) {
      if (typeof preload !== "string") throw new TypeError("bunfig.toml preload must be a string or an array of strings");
      const importModule = globalThis.__cottontailImportModule;
      if (typeof importModule !== "function") throw new Error("Standalone Bunfig preloads require the module runtime");
      const specifier = preload.startsWith(".") || preload.startsWith("/")
        ? resolve(dirname(configPath), preload)
        : preload;
      await importModule(specifier, configPath);
    }
  };

  globalThis.__cottontailLoadStandaloneExecPreloads = async function __cottontailLoadStandaloneExecPreloads() {
    if (globalThis.__cottontailStandaloneFlags == null || globalThis.__cottontailStandaloneExecPreloadsLoaded) return;
    globalThis.__cottontailStandaloneExecPreloadsLoaded = true;

    const preloads = [];
    const execArgv = (processObject ?? globalThis.process)?.execArgv ?? [];
    for (let index = 0; index < execArgv.length; index += 1) {
      const argument = String(execArgv[index]);
      if (argument === "--preload" || argument === "--require" || argument === "-r" || argument === "--import") {
        if (index + 1 < execArgv.length) preloads.push(String(execArgv[++index]));
        continue;
      }
      for (const prefix of ["--preload=", "--require=", "--import="]) {
        if (argument.startsWith(prefix)) {
          preloads.push(argument.slice(prefix.length));
          break;
        }
      }
    }

    const importModule = globalThis.__cottontailImportModule;
    if (preloads.length > 0 && typeof importModule !== "function") {
      throw new Error("Standalone execArgv preloads require the module runtime");
    }
    const cwd = cottontail.cwd();
    const referrer = resolve(cwd, "__cottontail_standalone__.js");
    for (const preload of preloads) {
      const specifier = preload.startsWith(".") || preload.startsWith("/")
        ? resolve(cwd, preload)
        : preload;
      await importModule(specifier, referrer);
    }
  };
}

export default installStandaloneRuntimeLoaders;
