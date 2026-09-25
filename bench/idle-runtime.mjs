// Compare released runtimes without opening Dash or modifying its profile:
// cottontail bench/idle-runtime.mjs --workers=6 --servers=1
// CPU includes all worker threads; mainPolls counts only the main runtime.
import { Worker, isMainThread, parentPort } from "node:worker_threads";

if (!isMainThread) {
  parentPort.on("message", () => {});
  parentPort.postMessage("ready");
} else {
  const numberOption = (name, fallback, minimum = 0) => {
    const argument = process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`));
    const value = argument ? Number(argument.slice(name.length + 3)) : fallback;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`--${name} must be an integer >= ${minimum}`);
    }
    return value;
  };
  const workerCount = numberOption("workers", 6);
  const serverCount = numberOption("servers", 0);
  const warmupMs = numberOption("warmup-ms", 15_000);
  const durationMs = numberOption("duration-ms", 12_000, 1);
  const workers = [];
  const servers = [];
  const cleanup = async () => {
    await Promise.all([
      ...servers.map((server) => server.stop(true)),
      ...workers.map((worker) => worker.terminate()),
    ]);
  };
  const polls = () => globalThis.cottontail?.runtimeDiagnostics?.().eventLoop.numPolls ?? null;
  const measure = () => {
    const beforePolls = polls();
    const beforeCpu = process.cpuUsage();
    const started = performance.now();
    setTimeout(async () => {
      const elapsedMs = performance.now() - started;
      const cpu = process.cpuUsage(beforeCpu);
      const afterPolls = polls();
      console.log(JSON.stringify({
        versions: {
          cottontail: process.versions.cottontail,
          bun: process.versions.bun,
          node: process.versions.node,
        },
        workers: workerCount,
        servers: serverCount,
        warmupMs,
        elapsedMs,
        cpuUserMs: cpu.user / 1000,
        cpuSystemMs: cpu.system / 1000,
        cpuPercent: (cpu.user + cpu.system) / elapsedMs / 10,
        mainPolls: beforePolls === null ? null : afterPolls - beforePolls,
      }));
      await cleanup();
    }, durationMs);
  };
  // Return from module evaluation before measuring. Keeping top-level await
  // pending would measure Cottontail's evaluation pump, not its idle loop.
  Promise.resolve().then(async () => {
    const ready = [];
    for (let index = 0; index < workerCount; index += 1) {
      const worker = new Worker(new URL(import.meta.url));
      workers.push(worker);
      ready.push(new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      }));
    }
    for (let index = 0; index < serverCount; index += 1) {
      servers.push(Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") }));
    }
    await Promise.all(ready);
    setTimeout(measure, warmupMs);
  }).catch(async (error) => {
    console.error(error);
    process.exitCode = 1;
    await cleanup();
  });
}
