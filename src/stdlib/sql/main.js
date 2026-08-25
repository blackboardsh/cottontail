import * as module from "../../runtime_modules/bun/sql.js";
const suffix = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
const executable = String(cottontail.execPath()).replaceAll("\\", "/");
const directory = executable.slice(0, executable.lastIndexOf("/"));
cottontail.loadCapabilityLibrary(`${directory}/cottontail-stdlib/sql/sql${suffix}`);
globalThis.__cottontailCapabilityResult = { namespace: module, modules: { "bun/sql.js": module } };
