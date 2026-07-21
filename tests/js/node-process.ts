import processModule from "node:process";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

assert(process.release?.name === "node", "global process.release.name mismatch");
assert(processModule.release?.name === "node", "node:process release.name mismatch");
assert(typeof process.version === "string" && process.version.length > 0, "process.version missing");
assert(typeof process.versions?.node === "string", "process.versions.node missing");
assert(typeof process.versions?.cottontail === "string", "process.versions.cottontail missing");

console.log("node process passed");
