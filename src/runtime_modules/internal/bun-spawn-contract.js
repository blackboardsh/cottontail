// Source-derived Bun.spawn/Bun.spawnSync argument contract. Process creation
// is implemented by bun/spawn.js against Cottontail's native host hooks.

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
const signalChoices = `${signalNames.slice(1, -1).map((name) => `'${name}'`).join(", ")} or '${signalNames.at(-1)}'`;

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
  const number = signalNumbers.get(value);
  if (number == null) throw new TypeError(`signal must be one of ${signalChoices}`);
  return number;
}

function bunSpawnString(value) {
  if (typeof value === "symbol") throw new TypeError("Cannot convert a symbol to a string");
  return String(value);
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
  } else {
    throw new TypeError("cmd must be an array");
  }

  return [bunSpawnString(cmd[0]), cmd.slice(1).map(bunSpawnString), options];
}

export function normalizeBunSpawnTimeout(value) {
  if (value == null || value === Infinity) return undefined;
  if (typeof value !== "number") {
    throw new TypeError(`The "timeout" property must be of type number. Received ${typeof value}`);
  }
  if (Number.isNaN(value)) return undefined;
  if (value === -Infinity) {
    throw new RangeError(
      `The value of "timeout" is out of range. It must be >= 0 and <= ${Number.MAX_SAFE_INTEGER}. Received -Infinity`,
    );
  }
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
  if (typeof globalThis.AbortSignal !== "function" || !(signal instanceof globalThis.AbortSignal)) {
    const type = typeof signal;
    const received = signal !== null && (type === "object" || type === "function")
      ? `an instance of ${signal?.constructor?.name ?? "Object"}`
      : `type ${type} (${String(signal)})`;
    throw new TypeError(`The "signal" argument must be of type AbortSignal. Received ${received}`);
  }
}

export function validateBunSpawnCallbacks(options, sync = false) {
  for (const name of ["onExit", "onDisconnect"]) {
    if (!isEmptyBunSpawnOption(options[name]) && typeof options[name] !== "function") {
      throw new TypeError(`${name} must be a function or undefined`);
    }
  }
  if (!sync && !isEmptyBunSpawnOption(options.serialization)) {
    if (typeof options.serialization !== "string") {
      throw new TypeError("Expected serialization to be a string for 'spawn'.");
    }
    if (options.serialization !== "json" && options.serialization !== "advanced") {
      throw new TypeError('serialization must be "json" or "advanced"');
    }
  }
  if (sync && !isEmptyBunSpawnOption(options.terminal)) {
    throw new TypeError("terminal option is only supported for Bun.spawn, not Bun.spawnSync");
  }
}

export function isReadableStreamLike(value) {
  return value != null && typeof value === "object" && typeof value.getReader === "function";
}
