export function execSync(command, options = {}) {
  const result = cottontail.spawnSync(cottontail.platform() === "win32" ? "cmd" : "sh", cottontail.platform() === "win32" ? ["/d", "/s", "/c", String(command)] : ["-c", String(command)], {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: options.env,
  });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || `Command failed: ${command}`);
    error.status = result.status;
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return options.encoding ? result.stdout : { toString: () => result.stdout };
}

export function spawnSync(file, args = [], options = {}) {
  return cottontail.spawnSync(String(file), Array.from(args, String), {
    stdio: options.stdio === "inherit" ? "inherit" : "pipe",
    cwd: options.cwd,
    env: options.env,
  });
}

export function spawn(file, args = [], options = {}) {
  const listeners = new Map();
  const child = {
    pid: 0,
    on(name, handler) {
      const handlers = listeners.get(name) ?? [];
      handlers.push(handler);
      listeners.set(name, handlers);
      return child;
    },
    once(name, handler) {
      const wrapped = (...values) => {
        child.off(name, wrapped);
        handler(...values);
      };
      return child.on(name, wrapped);
    },
    off(name, handler) {
      const handlers = listeners.get(name) ?? [];
      listeners.set(name, handlers.filter((item) => item !== handler));
      return child;
    },
    kill() {},
  };
  Promise.resolve().then(() => {
    const result = spawnSync(file, args, options);
    for (const handler of listeners.get("exit") ?? []) handler(result.status, null);
    for (const handler of listeners.get("close") ?? []) handler(result.status, null);
  });
  return child;
}

export default { execSync, spawn, spawnSync };
