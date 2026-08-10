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

if (process.platform === "win32") {
  assert(/^\d+(?:\.\d+)+$/.test(os.release()), `Windows os.release invalid: ${os.release()}`);
  assert(/^Windows\b/.test(os.version()), `Windows os.version invalid: ${os.version()}`);
  assert(os.type() === "Windows_NT", `Windows os.type mismatch: ${os.type()}`);
  assert(os.machine() === "x86_64", `Windows os.machine mismatch: ${os.machine()}`);

  const cpus = os.cpus();
  assert(cpus.length > 0, "Windows os.cpus should not be empty");
  assert(cpus.every((cpu) => cpu.model.length > 0 && cpu.speed > 0), "Windows os.cpus model/speed invalid");
  assert(cpus.some((cpu) => Object.values(cpu.times).some((value) => value > 0)), "Windows os.cpus times are all zero");
  assert(os.totalmem() > 0 && os.totalmem() >= os.freemem(), "Windows total/free memory invalid");
  assert(os.uptime() >= process.uptime(), "Windows os.uptime should report system rather than process uptime");

  if (process.env.USERPROFILE) {
    assert(homedir().toLowerCase() === process.env.USERPROFILE.toLowerCase(), "Windows homedir should prefer USERPROFILE");
  }
  const user = os.userInfo();
  assert(user.shell === null, "Windows userInfo shell should be null");
  const bufferedUser = os.userInfo({ encoding: "buffer" });
  assert(Buffer.isBuffer(bufferedUser.username), "Windows buffered userInfo username should be a Buffer");
  assert(Buffer.isBuffer(bufferedUser.homedir), "Windows buffered userInfo homedir should be a Buffer");
  assert(bufferedUser.shell === null, "Windows buffered userInfo shell should be null");
}

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
assert(getPriority(0) === priority, "getPriority(0) should target the current process");
setPriority(process.pid, priority);
assert(getPriority(process.pid) === priority, "setPriority should preserve same priority");

function expectPriorityValidationError(
  operation: () => unknown,
  code: "ERR_INVALID_ARG_TYPE" | "ERR_OUT_OF_RANGE",
  argument: "pid" | "priority",
  label: string,
) {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `${label} should throw a catchable Error`);
  assert((caught as Error & { code?: string }).code === code, `${label} error code mismatch`);
  assert(
    code === "ERR_INVALID_ARG_TYPE" ? caught instanceof TypeError : caught instanceof RangeError,
    `${label} error type mismatch`,
  );
  assert(caught.message.includes(`"${argument}"`), `${label} error should identify ${argument}`);
}

expectPriorityValidationError(
  () => (os.setPriority as (...args: unknown[]) => void)(),
  "ERR_INVALID_ARG_TYPE",
  "priority",
  "os.setPriority()",
);
expectPriorityValidationError(
  () => (os.setPriority as (...args: unknown[]) => void)(Number.NaN),
  "ERR_OUT_OF_RANGE",
  "priority",
  "os.setPriority(NaN)",
);
const invalidPriorityPidTypes: unknown[] = [null, true, false, "0", [], {}];
for (const invalidPid of invalidPriorityPidTypes) {
  expectPriorityValidationError(
    () => (os.getPriority as (pid: unknown) => number)(invalidPid),
    "ERR_INVALID_ARG_TYPE",
    "pid",
    `getPriority(${String(invalidPid)})`,
  );
  expectPriorityValidationError(
    () => (os.setPriority as (pid: unknown, priority: number) => void)(invalidPid, priority),
    "ERR_INVALID_ARG_TYPE",
    "pid",
    `setPriority(${String(invalidPid)}, priority)`,
  );
}
for (const invalidPid of [Number.NaN, Infinity, -Infinity, 1.5, -2147483649, 2147483648]) {
  expectPriorityValidationError(
    () => getPriority(invalidPid),
    "ERR_OUT_OF_RANGE",
    "pid",
    `getPriority(${invalidPid})`,
  );
  expectPriorityValidationError(
    () => setPriority(invalidPid, priority),
    "ERR_OUT_OF_RANGE",
    "pid",
    `setPriority(${invalidPid}, priority)`,
  );
}
for (const invalidPriority of [null, true, false, "0", [], {}]) {
  expectPriorityValidationError(
    () => (os.setPriority as (pid: number, priority: unknown) => void)(process.pid, invalidPriority),
    "ERR_INVALID_ARG_TYPE",
    "priority",
    `setPriority(process.pid, ${String(invalidPriority)})`,
  );
}
for (const invalidPriority of [Number.NaN, Infinity, -Infinity, -21, 20, 1.5]) {
  expectPriorityValidationError(
    () => setPriority(process.pid, invalidPriority),
    "ERR_OUT_OF_RANGE",
    "priority",
    `setPriority(${invalidPriority})`,
  );
}
expectPriorityValidationError(
  () => setPriority(2147483647, Number.NaN),
  "ERR_OUT_OF_RANGE",
  "priority",
  "setPriority(unknown pid, NaN)",
);
expectPriorityValidationError(
  () => (os.setPriority as (pid: number, priority: unknown) => void)(2147483647, "0"),
  "ERR_INVALID_ARG_TYPE",
  "priority",
  "setPriority(unknown pid, string priority)",
);

let missingProcessError: unknown;
try {
  getPriority(-1);
} catch (error) {
  missingProcessError = error;
}
assert(missingProcessError instanceof Error, "getPriority(-1) should throw a catchable Error");
assert(missingProcessError.name === "SystemError", "getPriority(-1) should throw a SystemError");
assert(
  (missingProcessError as Error & { code?: string }).code === "ERR_SYSTEM_ERROR",
  "getPriority(-1) system error code mismatch",
);
assert(
  (missingProcessError as Error & { errno?: number }).errno === (process.platform === "win32" ? -4040 : -3),
  "getPriority(-1) system errno mismatch",
);

assert(typeof cottontail.osGetPriority === "function", "native osGetPriority binding missing");
assert(typeof cottontail.osSetPriority === "function", "native osSetPriority binding missing");
const nativeGetPriority = cottontail.osGetPriority as (...args: unknown[]) => unknown;
const nativeSetPriority = cottontail.osSetPriority as (...args: unknown[]) => unknown;
for (const [label, operation] of [
  ["native osSetPriority()", () => nativeSetPriority()],
  ["native osGetPriority(null)", () => nativeGetPriority(null)],
  ["native osGetPriority(string)", () => nativeGetPriority("0")],
  ["native osGetPriority(array)", () => nativeGetPriority([])],
  ["native osGetPriority(object)", () => nativeGetPriority({})],
  ["native osGetPriority(NaN)", () => nativeGetPriority(Number.NaN)],
  ["native osGetPriority(negative pid)", () => nativeGetPriority(-1)],
  ["native osGetPriority(out of range)", () => nativeGetPriority(2147483648)],
  ["native osSetPriority(null pid)", () => nativeSetPriority(null, priority)],
  ["native osSetPriority(string pid)", () => nativeSetPriority("0", priority)],
  ["native osSetPriority(array pid)", () => nativeSetPriority([], priority)],
  ["native osSetPriority(object pid)", () => nativeSetPriority({}, priority)],
  ["native osSetPriority(NaN pid)", () => nativeSetPriority(Number.NaN, priority)],
  ["native osSetPriority(negative pid)", () => nativeSetPriority(-1, priority)],
  ["native osSetPriority(out-of-range pid)", () => nativeSetPriority(2147483648, priority)],
  ["native osSetPriority(null priority)", () => nativeSetPriority(process.pid, null)],
  ["native osSetPriority(string priority)", () => nativeSetPriority(process.pid, "0")],
  ["native osSetPriority(array priority)", () => nativeSetPriority(process.pid, [])],
  ["native osSetPriority(object priority)", () => nativeSetPriority(process.pid, {})],
  ["native osSetPriority(NaN)", () => nativeSetPriority(process.pid, Number.NaN)],
  ["native osSetPriority(out-of-range priority)", () => nativeSetPriority(process.pid, 20)],
] as const) {
  let caught: unknown;
  try {
    operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `${label} should throw a catchable Error`);
}

console.log("node os passed");
