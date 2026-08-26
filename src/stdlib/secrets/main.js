import * as module from "../../runtime_modules/bun/secrets.js";

if (process.platform === "win32") {
  const executable = String(cottontail.execPath()).replaceAll("\\", "/");
  const directory = executable.slice(0, executable.lastIndexOf("/"));
  cottontail.loadCapabilityLibrary(`${directory}/cottontail-stdlib/secrets/secrets.dll`);
}

globalThis.__cottontailCapabilityResult = {
  namespace: module,
  modules: { "bun/secrets.js": module },
};
