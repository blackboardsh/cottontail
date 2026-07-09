import processModule from "node:process";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

assert(process.release?.name === "cottontail", "global process.release.name mismatch");
assert(processModule.release?.name === "cottontail", "node:process release.name mismatch");
assert(typeof process.version === "string" && process.version.length > 0, "process.version missing");
assert(typeof process.versions?.node === "string", "process.versions.node missing");

console.log("node process passed");
