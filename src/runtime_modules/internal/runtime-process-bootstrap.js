export const nodeCompatVersion = "24.11.1";
export const bunCompatVersion = "1.3.10";

const processStartNs = BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000));

function initializeRuntimeProcess() {
  const execPath = String(cottontail.execPath?.() ?? "cottontail");
  const argv = Array.isArray(cottontail.argv)
    ? [...cottontail.argv]
    : [execPath, ...(cottontail.args ?? [])];
  if (argv.length === 0) argv.push(execPath);
  if (argv[0] === "cottontail") {
    argv[0] = globalThis.__cottontailStandaloneFlags == null ? execPath : "bun";
  }

  const target = globalThis.process ?? {};
  target.argv ??= argv;
  target.argv0 ??= execPath;
  target.execPath ??= execPath;
  target.execArgv ??= Array.from(cottontail.execArgv ?? [], String);
  target.env ??= cottontail.env();

  const inheritedSpawnArgv0 = target.env.COTTONTAIL_SPAWN_ARGV0;
  if (inheritedSpawnArgv0 != null) {
    Object.defineProperty(target, "argv0", {
      value: String(inheritedSpawnArgv0),
      writable: true,
      enumerable: true,
      configurable: true,
    });
    try { delete target.env.COTTONTAIL_SPAWN_ARGV0; } catch {}
  }

  const inheritedSpawnExecPath = target.env.COTTONTAIL_SPAWN_EXEC_PATH;
  if (inheritedSpawnExecPath != null) {
    const displayExecPath = String(inheritedSpawnExecPath);
    Object.defineProperty(target, "execPath", {
      value: displayExecPath,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    if (Array.isArray(target.argv) && target.argv.length > 0) target.argv[0] = displayExecPath;
    try { delete target.env.COTTONTAIL_SPAWN_EXEC_PATH; } catch {}
  }

  target.platform ??= cottontail.platform();
  target.arch ??= cottontail.arch();
  target.pid ??= Number(cottontail.pid?.() ?? 0);
  target.ppid ??= Number(cottontail.processInfo?.("ppid") ?? 0);
  target.version ??= `v${nodeCompatVersion}`;
  target.versions ??= {};
  target.versions.node ??= nodeCompatVersion;
  target.versions.bun ??= bunCompatVersion;
  target.versions.cottontail ??= String(cottontail.processInfo?.("version") ?? "0.0.0-dev");
  target.revision ??= "cottontail";
  target.release ??= { name: "node" };
  target.title ??= "bun";
  target.isBun ??= true;
  target.browser ??= false;
  target.exitCode ??= undefined;
  target.cwd ??= () => cottontail.cwd();
  target.chdir ??= directory => cottontail.chdir(directory);
  target.memoryUsage ??= function memoryUsage() {
    return cottontail.processInfo("memoryUsage");
  };
  target.memoryUsage.rss ??= () => Number(cottontail.processInfo("memoryUsage").rss) || 0;
  target.uptime ??= () => Number(BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000)) - processStartNs) / 1e9;
  target.hrtime ??= function hrtime(previous) {
    let value = BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000));
    if (previous !== undefined) value -= BigInt(previous[0] ?? 0) * 1_000_000_000n + BigInt(previous[1] ?? 0);
    return [Number(value / 1_000_000_000n), Number(value % 1_000_000_000n)];
  };
  target.hrtime.bigint ??= () => BigInt(Math.floor(cottontail.nanotime?.() ?? Date.now() * 1_000_000));
  target.nextTick ??= (callback, ...args) => queueMicrotask(() => callback(...args));
  target.exit ??= function exit(code = this.exitCode ?? 0) {
    this.exitCode = Number(code) || 0;
    cottontail.exit(this.exitCode);
  };
  target.reallyExit ??= target.exit;

  globalThis.process = target;
  return target;
}

export const processObject = initializeRuntimeProcess();
export default processObject;
