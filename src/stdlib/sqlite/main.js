import * as bunSqlite from "../../runtime_modules/bun/sqlite.js";
import * as nodeSqlite from "../../runtime_modules/node/sqlite.js";

const suffix = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
const executable = String(cottontail.execPath()).replaceAll("\\", "/");
const directory = executable.slice(0, executable.lastIndexOf("/"));
cottontail.loadCapabilityLibrary(`${directory}/cottontail-stdlib/sqlite/sqlite${suffix}`);

globalThis.__cottontailCapabilityResult = {
  modules: {
    "bun/sqlite.js": bunSqlite,
    "node/sqlite.js": nodeSqlite,
  },
};
