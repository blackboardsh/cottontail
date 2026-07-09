import os, { arch, getPriority, hostname, homedir, networkInterfaces, platform, setPriority, tmpdir } from "node:os";

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

const interfaces = networkInterfaces();
const interfaceEntries = Object.values(interfaces).flat();
assert(interfaceEntries.length > 0, "networkInterfaces should report at least one address");
assert(interfaceEntries.some((entry) => entry.internal), "networkInterfaces should include an internal address");
for (const entry of interfaceEntries) {
  assert(entry.family === "IPv4" || entry.family === "IPv6", `networkInterfaces family mismatch: ${entry.family}`);
  assert(typeof entry.address === "string" && entry.address.length > 0, "networkInterfaces address missing");
  assert(typeof entry.netmask === "string", "networkInterfaces netmask missing");
  assert(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(entry.mac), `networkInterfaces mac mismatch: ${entry.mac}`);
  assert(entry.cidr === null || String(entry.cidr).includes("/"), "networkInterfaces cidr mismatch");
  if (entry.family === "IPv6") assert(Number.isInteger(entry.scopeid), "networkInterfaces IPv6 scopeid mismatch");
}

const priority = getPriority();
assert(Number.isInteger(priority), "getPriority should return an integer");
setPriority(process.pid, priority);
assert(getPriority(process.pid) === priority, "setPriority should preserve same priority");

console.log("node os passed");
