const { workerData } = require("node:worker_threads");
const { port, notify } = workerData;

try {
  // Do not require node:process first: a CommonJS package such as esbuild
  // expects the global process API to be initialized before its entry runs.
  port.postMessage({
    cwd: process.cwd(),
    pid: process.pid,
    arch: process.arch,
    execPathType: typeof process.execPath,
    nextTickType: typeof process.nextTick,
    hrtimeBigintType: typeof process.hrtime.bigint,
    targetArch: process.config.variables.target_arch,
    marker: process.env.COTTONTAIL_WORKER_PROCESS_BOOTSTRAP_MARKER,
    args: process.argv.slice(2),
  });
} catch (error) {
  port.postMessage({ error: String(error), stack: error.stack });
} finally {
  Atomics.store(notify, 0, 1);
  Atomics.notify(notify, 0);
  port.close();
}
