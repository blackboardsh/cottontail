const suffix = process.platform === "win32" ? ".dll" : process.platform === "darwin" ? ".dylib" : ".so";
const executable = String(cottontail.execPath()).replaceAll("\\", "/");
const directory = executable.slice(0, executable.lastIndexOf("/"));
cottontail.loadCapabilityLibrary(`${directory}/cottontail-stdlib/websocket/websocket${suffix}`);
