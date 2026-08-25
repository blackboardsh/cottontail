import * as ffi from "../../runtime_modules/bun/ffi-implementation.js";

const suffix = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
const executable = String(cottontail.execPath()).replaceAll("\\", "/");
const directory = executable.slice(0, executable.lastIndexOf("/"));
cottontail.loadCapabilityLibrary(`${directory}/cottontail-stdlib/ffi/ffi${suffix}`);

globalThis.__cottontailCapabilityResult = {
  modules: {
    "bun/ffi-implementation.js": ffi,
  },
};
