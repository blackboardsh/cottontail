export function parseArgs(options = {}) {
  const input = options.args || [];
  const values = {};
  const positionals = [];
  for (let index = 0; index < input.length; index += 1) {
    const arg = input[index];
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(2, eq === -1 ? undefined : eq);
      const spec = options.options?.[name] || {};
      if (spec.type === "boolean") {
        values[name] = eq === -1 ? true : arg.slice(eq + 1) !== "false";
      } else if (eq !== -1) {
        values[name] = arg.slice(eq + 1);
      } else {
        values[name] = input[++index];
      }
    } else if (options.allowPositionals) {
      positionals.push(arg);
    }
  }
  return { values, positionals };
}

export function inspect(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function format(...args) {
  if (args.length === 0) return "";
  const first = args[0];
  if (typeof first !== "string") {
    return args.map(inspect).join(" ");
  }

  let index = 1;
  const output = first.replace(/%[sdijoO%]/g, (token) => {
    if (token === "%%") return "%";
    if (index >= args.length) return token;
    const value = args[index++];
    switch (token) {
      case "%s":
        return String(value);
      case "%d":
      case "%i":
        return String(Number.parseInt(value, 10));
      case "%j":
        try {
          return JSON.stringify(value);
        } catch {
          return "[Circular]";
        }
      case "%o":
      case "%O":
      default:
        return inspect(value);
    }
  });

  const rest = args.slice(index).map(inspect);
  return rest.length === 0 ? output : `${output} ${rest.join(" ")}`;
}

export function formatWithOptions(_options, ...args) {
  return format(...args);
}

export function deprecate(fn, message) {
  let warned = false;
  return function deprecated(...args) {
    if (!warned) {
      warned = true;
      if (globalThis.process?.emitWarning) {
        globalThis.process.emitWarning(message, "DeprecationWarning");
      }
    }
    return fn.apply(this, args);
  };
}

export function promisify(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("The original argument must be of type function");
  }
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (error, value) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      });
    });
}

promisify.custom = Symbol.for("nodejs.util.promisify.custom");

export default { deprecate, format, formatWithOptions, inspect, parseArgs, promisify };
