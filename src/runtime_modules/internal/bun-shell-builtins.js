// Builtins follow the behavior and diagnostics of src/compiler/src/shell/builtin.
// They operate on an interpreter context instead of process-global cwd/env so
// pipelines and subshells receive Bun's copy-on-execute state.

import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "../node/fs.js";
import { basename, dirname, isAbsolute, join, resolve } from "../node/path.js";

const encoder = new TextEncoder();

function bytes(value = "") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return globalThis.Buffer?.from ? Buffer.from(String(value)) : encoder.encode(String(value));
}

function result(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, stdout: bytes(stdout), stderr: bytes(stderr) };
}

function absolute(context, path) {
  return isAbsolute(path) ? path : resolve(context.cwd, path);
}

function errorReason(error) {
  const code = error?.code;
  if (code === "ENOENT") return "No such file or directory";
  if (code === "ENOTDIR") return "Not a directory";
  if (code === "EACCES" || code === "EPERM") return "Permission denied";
  if (code === "ENOTEMPTY") return "Directory not empty";
  if (code === "EISDIR") return "Is a directory";
  return String(error?.message ?? error ?? "Unknown error").replace(/^.*?:\s*/, "");
}

function parseFlags(args, accepted) {
  const flags = new Set();
  let index = 0;
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") return { flags, operands: args.slice(index + 1) };
    if (!argument.startsWith("-") || argument === "-") break;
    for (const flag of argument.slice(1)) {
      if (!accepted.includes(flag)) return { illegal: flag };
      flags.add(flag);
    }
  }
  return { flags, operands: args.slice(index) };
}

function echo(args) {
  let newline = true;
  let escapes = false;
  let index = 0;
  while (/^-[nEe]+$/.test(args[index] ?? "")) {
    for (const flag of args[index].slice(1)) {
      if (flag === "n") newline = false;
      else escapes = flag === "e";
    }
    index += 1;
  }
  let output = args.slice(index).join(" ");
  if (escapes) {
    let stopped = false;
    output = output.replace(/\\(0[0-7]{0,3}|x[\da-fA-F]{1,2}|.)/g, (_, escape) => {
      if (escape === "c") {
        stopped = true;
        return "";
      }
      if (escape[0] === "0") return String.fromCharCode(Number.parseInt(escape.slice(1) || "0", 8));
      if (escape[0] === "x") return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
      return ({ a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" })[escape] ?? `\\${escape}`;
    });
    if (stopped) newline = false;
  }
  return result(0, output + (newline ? "\n" : ""));
}

function printf(args) {
  if (args.length === 0) return result();
  let position = 1;
  let output = String(args[0]).replace(/%([%sdboxXc])/g, (_, specifier) => {
    if (specifier === "%") return "%";
    const value = args[position++] ?? "";
    if (specifier === "s") return String(value);
    if (specifier === "c") return String(value)[0] ?? "";
    const number = Number(value) || 0;
    if (specifier === "d") return String(Math.trunc(number));
    if (specifier === "b") return Math.trunc(number).toString(2);
    if (specifier === "o") return Math.trunc(number).toString(8);
    return Math.trunc(number).toString(16)[specifier === "X" ? "toUpperCase" : "toLowerCase"]();
  });
  output = output.replace(/\\([0-7]{1,3}|.)/g, (_, escape) => {
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    return ({ n: "\n", r: "\r", t: "\t", "\\": "\\" })[escape] ?? escape;
  });
  return result(0, output);
}

function sequence(args) {
  let separator = "\n";
  let terminator = "";
  let index = 0;
  while (index < args.length) {
    const option = args[index];
    if (option === "-s" || option === "--separator") {
      if (index + 1 >= args.length) return result(1, "", "seq: option requires an argument -- s\n");
      separator = args[index + 1];
      index += 2;
    } else if (option.startsWith("-s") && option.length > 2) {
      separator = option.slice(2);
      index += 1;
    } else if (option === "-t" || option === "--terminator") {
      if (index + 1 >= args.length) return result(1, "", "seq: option requires an argument -- t\n");
      terminator = args[index + 1];
      index += 2;
    } else if (option.startsWith("-t") && option.length > 2) {
      terminator = option.slice(2);
      index += 1;
    } else if (option === "-w" || option === "--fixed-width") index += 1;
    else break;
  }
  const values = args.slice(index).map(Number);
  if (values.length < 1 || values.length > 3 || values.some(value => !Number.isFinite(value))) {
    return result(1, "", "seq: invalid argument\n");
  }
  let start = 1;
  let step = 1;
  let end = values[0];
  if (values.length === 2) [start, end] = values;
  else if (values.length === 3) [start, step, end] = values;
  else if (end < start) step = -1;
  if (values.length === 2 && start > end) step = -1;
  if (step === 0) return result(1, "", "seq: zero increment\n");
  if ((start < end && step < 0) || (start > end && step > 0)) {
    return result(1, "", `seq: needs ${step < 0 ? "positive increment" : "negative decrement"}\n`);
  }
  const output = [];
  for (let value = start; step > 0 ? value <= end : value >= end; value += step) output.push(String(value));
  return result(0, output.length ? output.join(separator) + separator + terminator : terminator);
}

function cat(args, context, input) {
  if (args.length === 0 || (args.length === 1 && args[0] === "-")) return result(0, input);
  const chunks = [];
  let stderr = "";
  for (const path of args) {
    if (path === "-") {
      chunks.push(input);
      continue;
    }
    try {
      chunks.push(bytes(readFileSync(absolute(context, path))));
    } catch (error) {
      stderr += `cat: ${path}: ${errorReason(error)}\n`;
    }
  }
  return { exitCode: stderr ? 1 : 0, stdout: context.concat(chunks), stderr: bytes(stderr) };
}

function mkdir(args, context) {
  if (args[0] === "--help") return result(1, "", "mkdir: illegal option -- help\n");
  const parsed = parseFlags(args, "pv");
  if (parsed.illegal) return result(1, "", `mkdir: illegal option -- ${parsed.illegal}\n`);
  if (parsed.operands.length === 0) return result(1, "", "mkdir: missing operand\n");
  let stderr = "";
  let stdout = "";
  for (const path of parsed.operands) {
    try {
      mkdirSync(absolute(context, path), { recursive: parsed.flags.has("p") });
      if (parsed.flags.has("v")) stdout += `${path}\n`;
    } catch (error) {
      stderr += `mkdir: ${path}: ${errorReason(error)}\n`;
    }
  }
  return result(stderr ? 1 : 0, stdout, stderr);
}

function touch(args, context) {
  if (args[0] === "--help") return result(1, "", "touch: illegal option -- help\n");
  const parsed = parseFlags(args, "acm");
  if (parsed.illegal) return result(1, "", `touch: illegal option -- ${parsed.illegal}\n`);
  if (parsed.operands.length === 0) return result(1, "", "touch: missing file operand\n");
  let stderr = "";
  for (const path of parsed.operands) {
    const target = absolute(context, path);
    try {
      if (!existsSync(target)) writeFileSync(target, "");
      else appendFileSync(target, "");
    } catch (error) {
      stderr += `touch: ${path}: ${errorReason(error)}\n`;
    }
  }
  return result(stderr ? 1 : 0, "", stderr);
}

function listDirectory(path, display, options, context, output, errors, includeHeader) {
  let stat;
  try {
    stat = statSync(path);
  } catch (error) {
    errors.push(`ls: ${display}: ${errorReason(error)}\n`);
    return;
  }
  if (!stat.isDirectory() || options.directory) {
    output.push(`${display}\n`);
    return;
  }
  if ((Number(stat.mode) & 0o444) === 0) {
    errors.push(`ls: ${display}: Permission denied\n`);
    return;
  }
  if (includeHeader) output.push(`${display}:\n`);
  let names;
  try {
    names = readdirSync(path).map(String).sort();
  } catch (error) {
    errors.push(`ls: ${display}: ${errorReason(error)}\n`);
    return;
  }
  if (!options.all && !options.almostAll) names = names.filter(name => !name.startsWith("."));
  if (options.all) names = [".", "..", ...names];
  for (const name of names) output.push(`${name}\n`);
  if (!options.recursive) return;
  for (const name of names) {
    if (name === "." || name === "..") continue;
    const child = join(path, name);
    try {
      const childLstat = lstatSync(child);
      if (childLstat.isDirectory() && !childLstat.isSymbolicLink()) {
        output.push("\n");
        const childDisplay = display === "." || display.startsWith("./")
          ? `${display}/${name}`
          : join(display, name);
        listDirectory(child, childDisplay, options, context, output, errors, true);
      }
    } catch {}
  }
}

function ls(args, context) {
  const parsed = parseFlags(args, "RAad1");
  if (parsed.illegal) return result(1, "", `ls: illegal option -- ${parsed.illegal}\n`);
  const options = {
    recursive: parsed.flags.has("R"),
    all: parsed.flags.has("a"),
    almostAll: parsed.flags.has("A"),
    directory: parsed.flags.has("d"),
  };
  const operands = parsed.operands.length ? parsed.operands : ["."];
  const output = [];
  const errors = [];
  const includeHeader = operands.length > 1;
  for (let index = 0; index < operands.length; index += 1) {
    if (index > 0 && output.length) output.push("\n");
    listDirectory(absolute(context, operands[index]), operands[index], options, context, output, errors, includeHeader);
  }
  return result(errors.length ? 1 : 0, output.join(""), errors.join(""));
}

function copy(args, context) {
  const parsed = parseFlags(args, "Rrvn");
  if (parsed.illegal) return result(1, "", `cp: illegal option -- ${parsed.illegal}\n`);
  if (parsed.operands.length < 2) {
    return result(1, "", "usage: cp [-R [-H | -L | -P]] [-fi | -n] [-aclpsvXx] source_file target_file\n       cp [-R [-H | -L | -P]] [-fi | -n] [-aclpsvXx] source_file ... target_directory\n");
  }
  const recursive = parsed.flags.has("R") || parsed.flags.has("r");
  const verbose = parsed.flags.has("v");
  const sources = parsed.operands.slice(0, -1);
  const destinationArg = parsed.operands.at(-1);
  const destination = absolute(context, destinationArg);
  let destinationStat = null;
  try { destinationStat = statSync(destination); } catch {}
  let stdout = "";
  let stderr = "";
  for (const sourceArg of sources) {
    const source = absolute(context, sourceArg);
    let sourceStat;
    try { sourceStat = statSync(source); } catch (error) {
      stderr += `cp: ${sourceArg}: ${errorReason(error)}\n`;
      continue;
    }
    if (sourceStat.isDirectory() && !recursive) {
      stderr += `cp: ${sourceArg} is a directory (not copied)\n`;
      continue;
    }
    const destinationExists = destinationStat != null;
    const destinationIsDirectory = destinationStat?.isDirectory() ?? false;
    const destinationLooksLikeDirectory = destinationIsDirectory || (!destinationExists && /[\\/]$/.test(destinationArg));
    let target = destination;
    if (!sourceStat.isDirectory() && !destinationLooksLikeDirectory && sources.length === 1) {
      // source_file -> target_file
    } else if (recursive) {
      if (destinationExists) target = join(destination, basename(source));
      else if (sources.length !== 1) {
        stderr += `cp: directory ${destinationArg} does not exist\n`;
        continue;
      }
    } else {
      if (!destinationExists || !destinationIsDirectory) {
        stderr += `cp: ${destinationArg} is not a directory\n`;
        continue;
      }
      target = join(destination, basename(source));
    }
    if (resolve(source) === resolve(target)) {
      stderr += `cp: ${sourceArg} and ${sourceArg} are identical (not copied)\n`;
      continue;
    }
    try {
      cpSync(source, target, { recursive, force: !parsed.flags.has("n"), errorOnExist: false });
      if (verbose) stdout += `${source} -> ${target}\n`;
    } catch (error) {
      stderr += `cp: ${sourceArg}: ${errorReason(error)}\n`;
    }
  }
  return result(stderr ? 1 : 0, stdout, stderr);
}

function collectRemoved(path, display, recursive, output) {
  let stat;
  try { stat = lstatSync(path); } catch { return; }
  if (recursive && stat.isDirectory() && !stat.isSymbolicLink()) {
    for (const name of readdirSync(path)) collectRemoved(join(path, name), join(display, String(name)), true, output);
  }
  output.push(display);
}

function remove(args, context) {
  const parsed = parseFlags(args, "Rrfdv");
  if (parsed.illegal) return result(1, "", `rm: illegal option -- ${parsed.illegal}\n`);
  const recursive = parsed.flags.has("R") || parsed.flags.has("r");
  const force = parsed.flags.has("f");
  const directory = parsed.flags.has("d");
  const verbose = parsed.flags.has("v");
  if (parsed.operands.length === 0) return force ? result() : result(1, "", "rm: missing operand\n");
  let stdout = "";
  let stderr = "";
  for (const operand of parsed.operands) {
    const path = absolute(context, operand);
    let stat;
    try { stat = lstatSync(path); } catch (error) {
      if (!force) stderr += `rm: ${operand}: ${errorReason(error)}\n`;
      continue;
    }
    if (stat.isDirectory() && !recursive && !directory) {
      stderr += `rm: ${operand}: Is a directory\n`;
      continue;
    }
    const removed = [];
    if (verbose) collectRemoved(path, operand, recursive, removed);
    try {
      rmSync(path, { recursive, force });
      if (verbose) stdout += removed.map(item => `${item}\n`).join("");
    } catch (error) {
      stderr += `rm: ${operand}: ${errorReason(error)}\n`;
    }
  }
  return result(stderr ? 1 : 0, stdout, stderr);
}

function move(args, context) {
  const parsed = parseFlags(args, "fivn");
  if (parsed.illegal) return result(1, "", `mv: illegal option -- ${parsed.illegal}\n`);
  if (parsed.operands.length < 2) return result(1, "", "mv: missing file operand\n");
  const sources = parsed.operands.slice(0, -1);
  const destinationArg = parsed.operands.at(-1);
  const destination = absolute(context, destinationArg);
  let destinationStat = null;
  try { destinationStat = statSync(destination); } catch {}
  if ((sources.length > 1 || /[\\/]$/.test(destinationArg)) && !destinationStat?.isDirectory()) {
    return result(1, "", `mv: ${destinationArg}: No such file or directory\n`);
  }
  let stdout = "";
  let stderr = "";
  let notDirectory = false;
  for (const sourceArg of sources) {
    const source = absolute(context, sourceArg);
    let sourceStat;
    try { sourceStat = statSync(source); } catch (error) {
      stderr += `mv: ${sourceArg}: ${errorReason(error)}\n`;
      continue;
    }
    if (sourceStat.isDirectory() && destinationStat && !destinationStat.isDirectory()) {
      notDirectory = true;
      stderr += `mv: ${destinationArg}: Not a directory\n`;
      continue;
    }
    const target = destinationStat?.isDirectory() ? join(destination, basename(source)) : destination;
    try {
      renameSync(source, target);
      if (parsed.flags.has("v")) stdout += `${source} -> ${target}\n`;
    } catch (error) {
      stderr += `mv: ${destinationArg}: ${errorReason(error)}\n`;
    }
  }
  return result(stderr ? (notDirectory ? 20 : 1) : 0, stdout, stderr);
}

export function createShellBuiltins(host) {
  return async function runBuiltin(name, args, context, input = bytes()) {
    switch (name) {
      case ":":
      case "true": return result();
      case "false": return result(1);
      case "echo": return echo(args);
      case "printf": return printf(args);
      case "seq": return sequence(args);
      case "cat": return cat(args, context, input);
      case "pwd":
        return args.length ? result(1, "", "pwd: too many arguments\n") : result(0, `${context.cwd}\n`);
      case "cd": {
        if (args.length > 1) return result(1, "", "cd: too many arguments\n");
        const requested = args[0] ?? context.env.HOME ?? context.env.USERPROFILE ?? context.cwd;
        const target = requested === "-" ? context.env.OLDPWD ?? context.cwd : absolute(context, requested);
        try {
          if (!statSync(target).isDirectory()) return result(1, "", `cd: not a directory: ${requested}\n`);
          const previous = context.cwd;
          context.cwd = resolve(target);
          context.env.OLDPWD = previous;
          context.env.PWD = context.cwd;
          return result();
        } catch (error) {
          return result(1, "", `cd: no such file or directory: ${requested}\n`);
        }
      }
      case "export": {
        if (args.length === 0) {
          const output = Object.keys(context.exported).sort().map(key => `declare -x ${key}=${JSON.stringify(context.env[key] ?? "")}\n`).join("");
          return result(0, output);
        }
        for (const assignment of args) {
          const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/.exec(assignment);
          if (!match) return result(1, "", `export: ${assignment}: not a valid identifier\n`);
          if (match[2] !== undefined) context.env[match[1]] = match[2];
          context.exported[match[1]] = true;
        }
        return result();
      }
      case "unset":
        for (const key of args) { delete context.env[key]; delete context.exported[key]; delete context.externalEnv[key]; }
        return result();
      case "exit": {
        if (args.length === 0) return result();
        if (args.length > 1) return result(1, "", "exit: too many arguments\n");
        if (!/^[+-]?\d+$/.test(args[0])) return result(1, "", "exit: numeric argument required\n");
        const value = BigInt(args[0]);
        return result(Number(((value % 256n) + 256n) % 256n));
      }
      case "basename":
        return args.length ? result(0, `${args.map(value => basename(value)).join("\n")}\n`) : result(1, "", "usage: basename string\n");
      case "dirname":
        return args.length ? result(0, `${args.map(value => dirname(value)).join("\n")}\n`) : result(1, "", "usage: dirname string\n");
      case "mkdir": return mkdir(args, context);
      case "touch": return touch(args, context);
      case "ls": return ls(args, context);
      case "cp": return copy(args, context);
      case "rm": return remove(args, context);
      case "mv": return move(args, context);
      case "which": {
        if (args.length === 0) return result(1, "", "which: missing command\n");
        let stdout = "";
        let failed = false;
        for (const command of args) {
          const found = host.which(command, context.env, context.cwd);
          if (found) stdout += `${found}\n`;
          else { stdout += `${command} not found\n`; failed = true; }
        }
        return result(failed ? 1 : 0, stdout);
      }
      case "yes": {
        // COTTONTAIL-COMPAT: Bun shell yes streaming - the JS interpreter still
        // materializes pipeline stages, so emit a bounded producer block until
        // native backpressure and EPIPE can drive builtin lifecycle directly.
        const line = `${args.length ? args.join(" ") : "y"}\n`;
        return result(0, line.repeat(4096));
      }
      default: return null;
    }
  };
}
