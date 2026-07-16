import processDefault, * as processModule from "node:process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function assertThrows(callback: () => unknown, message: string) {
  try {
    callback();
  } catch {
    return;
  }
  throw new Error(message);
}

const tmpDir = process.env.COTTONTAIL_TMP_DIR;
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");

if (process.platform === "darwin") {
  const cleanEnvironment = spawnSync(
    process.execPath,
    ["-e", "console.log(JSON.stringify(process.env))"],
    { env: { COTTONTAIL_TMP_DIR: tmpDir }, encoding: "utf8" },
  );
  assert(cleanEnvironment.status === 0, "minimal environment child should exit successfully");
  const parsedEnvironment = JSON.parse(cleanEnvironment.stdout.trim());
  assert(!("__CF_USER_TEXT_ENCODING" in parsedEnvironment), "CoreFoundation environment internals should not leak");

}

assert(processDefault === process, "default process should be global process");
assert(processModule.pid === process.pid, "pid export mismatch");
assert(processModule.ppid > 0, "ppid should be present");
assert(typeof processModule.version === "string", "version missing");
assert(processModule.allowedNodeEnvironmentFlags.has("--enable-source-maps"), "allowedNodeEnvironmentFlags missing expected flag");
assert(processModule.config.variables.target_arch === process.arch, "config target_arch mismatch");
assert(processModule.features.require_module === true, "features.require_module mismatch");

const beforeCwd = process.cwd();
const workDir = `${tmpDir}/process-surface`;
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
process.chdir(workDir);
assert(process.cwd() === realpathSync(workDir), "process.chdir/cwd mismatch");
process.chdir(beforeCwd);

let nextTickRan = false;
await new Promise<void>((resolve) => {
  process.nextTick((value) => {
    nextTickRan = value === 42;
    resolve();
  }, 42);
});
assert(nextTickRan, "process.nextTick args mismatch");

const hr = process.hrtime();
assert(Array.isArray(hr) && hr.length === 2, "hrtime shape mismatch");
assert(typeof process.hrtime.bigint() === "bigint", "hrtime.bigint missing");
assert(process.uptime() >= 0, "uptime mismatch");

const cpu = process.cpuUsage();
assert(Number.isFinite(cpu.user) && Number.isFinite(cpu.system), "cpuUsage shape mismatch");
const threadCpu = process.threadCpuUsage();
assert(Number.isFinite(threadCpu.user) && Number.isFinite(threadCpu.system), "threadCpuUsage shape mismatch");
const resource = process.resourceUsage();
assert(Number.isFinite(resource.userCPUTime) && Number.isFinite(resource.systemCPUTime), "resourceUsage shape mismatch");
const memory = process.memoryUsage();
assert(Number.isFinite(memory.rss) && memory.rss >= 0, "memoryUsage rss mismatch");
assert(process.memoryUsage.rss() >= 0, "memoryUsage.rss mismatch");
assert(process.availableMemory() >= 0, "availableMemory mismatch");
assert(process.constrainedMemory() >= 0, "constrainedMemory mismatch");

assert(Number.isInteger(process.getuid()), "getuid mismatch");
assert(Number.isInteger(process.geteuid()), "geteuid mismatch");
assert(Number.isInteger(process.getgid()), "getgid mismatch");
assert(Number.isInteger(process.getegid()), "getegid mismatch");
assert(Array.isArray(process.getgroups()), "getgroups mismatch");
const oldMask = process.umask();
const previousMask = process.umask(oldMask);
assert(Number.isInteger(previousMask), "umask set should return old mask");
process.umask(oldMask);

let warningSeen = false;
function warningListener(error: Error) {
  warningSeen = error.name === "CottontailWarning" && error.message === "surface warning";
}
process.once("warning", warningListener);
process.emitWarning("surface warning", "CottontailWarning");
assert(warningSeen, "emitWarning did not emit warning event");

let customEventCount = 0;
function customListener(value: number) {
  customEventCount += value;
}
process.on("surface-event", customListener);
process.emit("surface-event", 2);
process.off("surface-event", customListener);
assert(customEventCount === 2, "process event emitter mismatch");
assert(process._eventsCount >= 0, "process _eventsCount mismatch");

assert(process.openStdin() === process.stdin, "openStdin mismatch");
assert(process._getActiveHandles().includes(process.stdout), "_getActiveHandles should include stdout");
assert(Array.isArray(process._getActiveRequests()), "_getActiveRequests mismatch");
assert(Array.isArray(process.getActiveResourcesInfo()), "getActiveResourcesInfo mismatch");

process.setSourceMapsEnabled(true);
assert(processModule.sourceMapsEnabled === true, "setSourceMapsEnabled true mismatch");
process.setSourceMapsEnabled(false);
assert(processModule.sourceMapsEnabled === false, "setSourceMapsEnabled false mismatch");

assert(process.hasUncaughtExceptionCaptureCallback() === false, "capture callback should start false");
process.setUncaughtExceptionCaptureCallback(() => {});
assert(process.hasUncaughtExceptionCaptureCallback() === true, "capture callback should be set");
process.setUncaughtExceptionCaptureCallback(null);
assert(process.hasUncaughtExceptionCaptureCallback() === false, "capture callback should clear");

const envPath = `${workDir}/.env`;
writeFileSync(envPath, "COTTONTAIL_PROCESS_SURFACE=loaded\n");
process.loadEnvFile(envPath);
assert(process.env.COTTONTAIL_PROCESS_SURFACE === "loaded", "loadEnvFile mismatch");

const reportPath = `${workDir}/report.json`;
const writtenReport = process.report.writeReport(reportPath);
assert(writtenReport === reportPath, "report.writeReport return mismatch");
assert(JSON.parse(readFileSync(reportPath, "utf8")).header.processId === process.pid, "report content mismatch");
assert(process.report.getReport().header.processId === process.pid, "report.getReport mismatch");

assert(process.getBuiltinModule("process") === process, "getBuiltinModule process mismatch");
assert(typeof process.finalization.register === "function", "finalization.register missing");
assert(typeof process.finalization.unregister === "function", "finalization.unregister missing");

const constantsBinding = (process as any).binding("constants");
assert(constantsBinding.fs.O_RDONLY === 0, "process.binding constants fs mismatch");
assert(constantsBinding.os.errno.ENOENT === 2, "process.binding constants errno mismatch");
assert(constantsBinding.os.signals.SIGTERM === 15, "process.binding constants signals mismatch");
assert(constantsBinding.crypto.RSA_PKCS1_PADDING === 1, "process.binding constants crypto mismatch");
assert(Number.isInteger(constantsBinding.zlib.Z_OK), "process.binding constants zlib mismatch");
assert((process as any).binding("constants") === constantsBinding, "process.binding should cache constants binding");

const uvBinding = (process as any).binding("uv");
assert(uvBinding.UV_ENOENT === -2, "process.binding uv errno mismatch");
assert(uvBinding.errname(uvBinding.UV_ENOENT) === "ENOENT", "process.binding uv errname mismatch");

const utilBinding = (process as any).binding("util");
assert(utilBinding.isArrayBuffer(new ArrayBuffer(1)) === true, "process.binding util isArrayBuffer mismatch");
assert(utilBinding.isUint8Array(new Uint8Array(1)) === true, "process.binding util isUint8Array mismatch");
assert(utilBinding.isPromise(Promise.resolve()) === true, "process.binding util isPromise mismatch");

const configBinding = (process as any).binding("config");
assert(configBinding.hasOpenSSL === true, "process.binding config hasOpenSSL mismatch");
assert(configBinding.bits === 64 || configBinding.bits === 32, "process.binding config bits mismatch");
assert(typeof configBinding.getDefaultLocale() === "string", "process.binding config getDefaultLocale mismatch");

const ttyBinding = (process as any).binding("tty_wrap");
assert(typeof ttyBinding.TTY === "function", "process.binding tty_wrap TTY mismatch");
assert(typeof ttyBinding.TTY.prototype.getWindowSize === "function", "process.binding tty_wrap getWindowSize mismatch");
assert(typeof ttyBinding.TTY.prototype.setRawMode === "function", "process.binding tty_wrap setRawMode mismatch");
assert(ttyBinding.isTTY(0) === Boolean(process.stdin.isTTY), "process.binding tty_wrap stdin mismatch");
assert(ttyBinding.isTTY(9999999) === false, "process.binding tty_wrap invalid fd mismatch");
assertThrows(() => ttyBinding.TTY(), "process.binding tty_wrap TTY should require new");

const nativesBinding = (process as any).binding("natives");
assert(typeof nativesBinding.fs === "string" && nativesBinding.fs.includes("node:fs"), "process.binding natives fs mismatch");
assert(typeof nativesBinding.crypto === "string" && nativesBinding.crypto.includes("node:crypto"), "process.binding natives crypto mismatch");

const fsBinding = (process as any).binding("fs");
assert(fsBinding.internalModuleStat(workDir) === 1, "process.binding fs internalModuleStat directory mismatch");
assert(fsBinding.internalModuleStat(`${workDir}/missing`) < 0, "process.binding fs internalModuleStat missing mismatch");
assert(fsBinding.readFileUtf8(envPath).includes("COTTONTAIL_PROCESS_SURFACE"), "process.binding fs readFileUtf8 mismatch");
const bindingFile = `${workDir}/binding-fs.txt`;
const bindingFd = fsBinding.open(bindingFile, "w+", 0o666);
assert(Number.isInteger(bindingFd), "process.binding fs open mismatch");
assert(fsBinding.writeString(bindingFd, "binding-ok", 0, "binding-ok".length, null) === "binding-ok".length, "process.binding fs writeString mismatch");
fsBinding.close(bindingFd);
assert(readFileSync(bindingFile, "utf8") === "binding-ok", "process.binding fs writeString content mismatch");

const bufferBinding = (process as any).binding("buffer");
assert(bufferBinding.byteLengthUtf8("hé") === 3, "process.binding buffer byteLengthUtf8 mismatch");
const filled = Buffer.alloc(4);
bufferBinding.fill(filled, "ab", 0, 4, "utf8");
assert(filled.toString() === "abab", "process.binding buffer fill mismatch");
assert(bufferBinding.indexOfString(Buffer.from("abcabc"), "bc", 0, "utf8") === 1, "process.binding buffer indexOfString mismatch");
assert(bufferBinding.indexOfNumber(Buffer.from([1, 2, 3]), 2, 0) === 1, "process.binding buffer indexOfNumber mismatch");

const osBinding = (process as any).binding("os");
assert(typeof osBinding.getHostname() === "string", "process.binding os hostname mismatch");
const loadAverage = new Float64Array(3);
osBinding.getLoadAvg(loadAverage);
assert(loadAverage.length === 3, "process.binding os loadavg mismatch");

const spawnSyncBinding = (process as any).binding("spawn_sync");
const privateSpawn = spawnSyncBinding.spawn({
  file: "sh",
  args: ["sh", "-c", "printf binding-spawn"],
  stdio: "pipe",
});
assert(privateSpawn.status === 0, `process.binding spawn_sync status mismatch: ${privateSpawn.status}`);
assert(privateSpawn.output[1].toString() === "binding-spawn", "process.binding spawn_sync stdout mismatch");

const zlibBinding = (process as any).binding("zlib");
assert(zlibBinding.crc32("abc") === 0x352441c2, "process.binding zlib crc32 mismatch");

try {
  (process as any).binding("definitely_missing");
  throw new Error("process.binding missing name should throw");
} catch (error) {
  assert(String((error as Error).message).includes("No such module"), "process.binding missing error mismatch");
}

try {
  (process as any)._linkedBinding("x");
  throw new Error("process._linkedBinding should throw");
} catch (error) {
  assert((error as Error & { code?: string }).code === "ERR_INVALID_MODULE", "process._linkedBinding error code mismatch");
}

try {
  (process as any).dlopen({ exports: {} }, "x.node");
  throw new Error("process.dlopen should throw");
} catch (error) {
  assert((error as Error & { code?: string }).code === "ERR_DLOPEN_FAILED", "process.dlopen error code mismatch");
}

let execveValidationThrew = false;
try {
  (process as any).execve("/bin/sh", "bad-args", process.env);
} catch {
  execveValidationThrew = true;
}
assert(execveValidationThrew, "process.execve should validate args");

if (process.platform !== "win32") {
  const execveOutput = `${workDir}/execve-output.txt`;
  const execveChild = new URL("./fixtures/process-execve-child.js", import.meta.url).pathname;
  const execveResult = spawnSync(process.execPath, [execveChild], {
    env: { ...process.env, COTTONTAIL_EXECVE_OUTPUT: execveOutput },
    encoding: "utf8",
  });
  assert(execveResult.status === 0, `process.execve child exit mismatch: ${execveResult.status} ${execveResult.stderr}`);
  assert(readFileSync(execveOutput, "utf8") === "execve-ok", "process.execve output mismatch");
}

rmSync(workDir, { recursive: true, force: true });
console.log("node process surface passed");
