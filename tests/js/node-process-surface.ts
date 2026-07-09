import processDefault, * as processModule from "node:process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const tmpDir = process.env.COTTONTAIL_TMP_DIR;
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");

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

for (const name of ["binding", "_linkedBinding", "dlopen", "execve"] as const) {
  let threw = false;
  try {
    (process as any)[name]("x");
  } catch {
    threw = true;
  }
  assert(threw, `${name} should throw unsupported`);
}

rmSync(workDir, { recursive: true, force: true });
console.log("node process surface passed");
