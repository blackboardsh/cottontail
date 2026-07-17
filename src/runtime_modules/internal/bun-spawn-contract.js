// Source-derived Bun.spawn/Bun.spawnSync argument contract. Process creation
// stays in bun/index.js because it is coupled to Cottontail's host hooks.

const signalNames = [
  undefined,
  "SIGHUP",
  "SIGINT",
  "SIGQUIT",
  "SIGILL",
  "SIGTRAP",
  "SIGABRT",
  "SIGBUS",
  "SIGFPE",
  "SIGKILL",
  "SIGUSR1",
  "SIGSEGV",
  "SIGUSR2",
  "SIGPIPE",
  "SIGALRM",
  "SIGTERM",
  "SIG16",
  "SIGCHLD",
  "SIGCONT",
  "SIGSTOP",
  "SIGTSTP",
  "SIGTTIN",
  "SIGTTOU",
  "SIGURG",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGVTALRM",
  "SIGPROF",
  "SIGWINCH",
  "SIGIO",
  "SIGPWR",
  "SIGSYS",
];

const signalNumbers = new Map(signalNames.flatMap((name, number) => name == null ? [] : [[name, number]]));

export function isEmptyBunSpawnOption(value) {
  return value === undefined || value === null || value === "";
}

export function bunSignalName(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number < signalNames.length
    ? signalNames[number]
    : null;
}

export function bunSignalNumber(value = "SIGTERM") {
  if (value == null || value === "") return 15;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return 15;
    if (!Number.isFinite(value) || !Number.isInteger(value)) throw new TypeError("Unknown signal");
    if (value < 0) throw new TypeError("Invalid signal: must be >= 0");
    if (value > 31) throw new TypeError("Invalid signal: must be < 32");
    return value;
  }
  if (typeof value !== "string") throw new TypeError("Invalid signal: must be a string or an integer");
  const number = signalNumbers.get(value.toUpperCase());
  if (number == null) throw new TypeError("Unknown signal");
  return number;
}

function commandArray(command) {
  if (!Array.isArray(command)) throw new TypeError("cmd must be an array");
  if (command.length === 0) throw new TypeError("cmd must not be empty");
  if (command.length > 0xfffffffd) throw new TypeError("cmd array is too large");
  return command;
}

export function normalizeBunSpawnCommand(command, maybeArgsOrOptions = {}, maybeOptions = undefined) {
  let cmd;
  let options;
  if (Array.isArray(command)) {
    cmd = commandArray(command);
    options = maybeArgsOrOptions ?? {};
  } else if (command != null && typeof command === "object") {
    cmd = commandArray(command.cmd);
    // Bun's object form is self-contained. The second argument is only read
    // when the first argument is the command array form.
    options = command;
  } else if (typeof command === "string") {
    // Cottontail historically accepted Node's (file, args, options) overload.
    // Keep it as an additive extension without weakening Bun's array/object forms.
    const args = Array.isArray(maybeArgsOrOptions) ? maybeArgsOrOptions : [];
    cmd = [command, ...args];
    options = (Array.isArray(maybeArgsOrOptions) ? maybeOptions : maybeArgsOrOptions) ?? {};
  } else {
    throw new TypeError("cmd must be an array");
  }

  return [String(cmd[0]), cmd.slice(1).map(String), options];
}

export function normalizeBunSpawnTimeout(value) {
  if (value == null || value === Infinity) return undefined;
  if (typeof value !== "number") {
    throw new TypeError(`The "timeout" property must be of type number. Received ${typeof value}`);
  }
  if (Number.isNaN(value)) return undefined;
  if (!Number.isInteger(value)) {
    throw new TypeError(`The "timeout" property must be of type integer. Received number`);
  }
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(
      `The value of "timeout" is out of range. It must be >= 0 and <= ${Number.MAX_SAFE_INTEGER}. Received ${String(value)}`,
    );
  }
  return value === 0 ? undefined : value;
}

export function normalizeBunSpawnMaxBuffer(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}

export function assertBunAbortSignal(signal) {
  if (isEmptyBunSpawnOption(signal)) return;
  if (signal === null || typeof signal !== "object" || typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function") {
    throw new TypeError("signal must be an AbortSignal");
  }
}

export function validateBunSpawnCallbacks(options, sync = false) {
  for (const name of ["onExit", "onDisconnect"]) {
    if (!isEmptyBunSpawnOption(options[name]) && typeof options[name] !== "function") {
      throw new TypeError(`${name} must be a function or undefined`);
    }
  }
  if (typeof options.ipc === "function" && !isEmptyBunSpawnOption(options.serialization) &&
      options.serialization !== "json" && options.serialization !== "advanced") {
    throw new TypeError('serialization must be "json" or "advanced"');
  }
  if (sync && !isEmptyBunSpawnOption(options.terminal)) {
    throw new TypeError("terminal option is only supported for Bun.spawn, not Bun.spawnSync");
  }
}

export function isReadableStreamLike(value) {
  return value != null && typeof value === "object" && typeof value.getReader === "function";
}
