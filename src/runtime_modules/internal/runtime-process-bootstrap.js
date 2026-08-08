export const nodeCompatVersion = "24.3.0";
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

  // Variables the spawning runtime injected so this process could be reached
  // through its wrapper are part of that handoff, not of the environment the
  // program asked for: keep their values for facade children of our own and
  // drop them (and the marker) from process.env.
  const injectedRouting = target.env.COTTONTAIL_SPAWN_ROUTING;
  if (injectedRouting != null) {
    const routing = {};
    for (const key of String(injectedRouting).split(",")) {
      if (key.length === 0) continue;
      const value = target.env[key];
      if (value != null) routing[key] = String(value);
      try { delete target.env[key]; } catch {}
    }
    try { delete target.env.COTTONTAIL_SPAWN_ROUTING; } catch {}
    Object.defineProperty(globalThis, "__cottontailFacadeRoutingEnv", {
      value: routing,
      writable: true,
      configurable: true,
    });
  }

  target.platform ??= cottontail.platform();
  target.arch ??= cottontail.arch();
  // Node exposes the node-gyp build configuration on every process, including
  // worker threads. Mirror the defaults node/process.js merges on top of so
  // lean runtimes (workers, spawned wrappers) see the same shape.
  target.config ??= Object.freeze({
    target_defaults: Object.freeze({
      cflags: Object.freeze([]),
      default_configuration: "Release",
      defines: Object.freeze([]),
      include_dirs: Object.freeze([]),
      libraries: Object.freeze([]),
    }),
    variables: Object.freeze({
      clang: 1,
      host_arch: target.arch,
      target_arch: target.arch,
      enable_lto: false,
      node_target_type: "executable",
      node_use_openssl: true,
      node_shared_zlib: false,
    }),
  });
  target.features ??= Object.freeze({
    inspector: false,
    debug: false,
    uv: true,
    ipv6: true,
    openssl_is_boringssl: false,
    tls_alpn: false,
    tls_sni: false,
    tls_ocsp: false,
    tls: false,
    cached_builtins: false,
    require_module: true,
    typescript: "transform",
  });
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
  target.chdir ??= directory => {
    if (typeof cottontail.chdir === "function") return cottontail.chdir(directory);
    return cottontail.processInfo("chdir", String(directory));
  };
  target.memoryUsage ??= function memoryUsage() {
    return cottontail.processInfo("memoryUsage");
  };
  target.memoryUsage.rss ??= () => Number(cottontail.processInfo("rss")) || 0;
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
    if (!this._exiting) {
      this._exiting = true;
      this.emit?.("exit", this.exitCode);
    }
    cottontail.exit(this.exitCode);
  };
  target.reallyExit ??= target.exit;

  globalThis.process = target;
  return target;
}

export const processObject = initializeRuntimeProcess();
export default processObject;
