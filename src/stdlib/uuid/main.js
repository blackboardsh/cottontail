import * as module from "../../runtime_modules/bun/uuid.js";

const suffix = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
const executable = String(cottontail.execPath()).replaceAll("\\", "/");
const directory = executable.slice(0, executable.lastIndexOf("/"));
cottontail.loadCapabilityLibrary(`${directory}/cottontail-stdlib/uuid/uuid${suffix}`);

globalThis.__cottontailCapabilityResult = {
  namespace: module,
  modules: { "bun/uuid.js": module },
};
