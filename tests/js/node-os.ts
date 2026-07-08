import os, { arch, hostname, homedir, platform, tmpdir } from "node:os";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(typeof os.hostname === "function", "node:os default hostname export missing");
assert(typeof hostname === "function", "node:os hostname named export missing");
assert(typeof cottontail.hostname === "function", "cottontail.hostname missing");

const resolvedHostname = hostname();
assert(typeof resolvedHostname === "string", "node:os hostname did not return a string");
assert(resolvedHostname === os.hostname(), "node:os default and named hostname mismatch");
assert(resolvedHostname === cottontail.hostname(), "node:os and native hostname mismatch");

assert(platform() === os.platform(), "node:os default and named platform mismatch");
assert(arch() === os.arch(), "node:os default and named arch mismatch");
assert(typeof homedir() === "string" && homedir().length > 0, "node:os homedir invalid");
assert(typeof tmpdir() === "string" && tmpdir().length > 0, "node:os tmpdir invalid");

console.log("node os passed");
