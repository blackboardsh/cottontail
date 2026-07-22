let cachedUserAgent;

export function runtimeDefaultUserAgent(fallback) {
  if (cachedUserAgent !== undefined) return cachedUserAgent || fallback;

  cachedUserAgent = "";
  const execArgv = globalThis.process?.execArgv;
  if (Array.isArray(execArgv)) {
    for (let index = 0; index < execArgv.length; index += 1) {
      const argument = String(execArgv[index]);
      if (argument === "--user-agent") {
        cachedUserAgent = execArgv[index + 1] == null ? "" : String(execArgv[index + 1]);
        index += 1;
        continue;
      }
      if (argument.startsWith("--user-agent=")) {
        cachedUserAgent = argument.slice("--user-agent=".length);
      }
    }
  }
  return cachedUserAgent || fallback;
}
