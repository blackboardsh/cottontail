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
  rmdirSync,
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
  return encoder.encode(String(value));
}

function result(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, stdout: bytes(stdout), stderr: bytes(stderr) };
}

function concatBytes(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
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

function appendEchoEscapes(value) {
  const chunks = [];
  let text = "";
  const flush = () => {
    if (text.length === 0) return;
    chunks.push(bytes(text));
    text = "";
  };
  const appendByte = value => {
    flush();
    chunks.push(Uint8Array.of(value));
  };
  for (let index = 0; index < value.length;) {
    if (value[index] !== "\\" || index + 1 >= value.length) {
      text += value[index++];
      continue;
    }
    const escaped = value[index + 1];
    index += 2;
    if (escaped === "c") {
      flush();
      return { output: concatBytes(chunks), stopped: true };
    }
    if (escaped === "0") {
      const match = /^[0-7]{0,3}/.exec(value.slice(index))?.[0] ?? "";
      appendByte(Number.parseInt(match || "0", 8) & 0xff);
      index += match.length;
      continue;
    }
    if (escaped === "x") {
      const match = /^[\da-fA-F]{1,2}/.exec(value.slice(index))?.[0];
      if (match == null) {
        text += "\\x";
        continue;
      }
      appendByte(Number.parseInt(match, 16));
      index += match.length;
      continue;
    }
    const escapedByte = ({
      a: 0x07, b: 0x08, e: 0x1b, E: 0x1b, f: 0x0c, n: 0x0a,
      r: 0x0d, t: 0x09, v: 0x0b, "\\": 0x5c,
    })[escaped];
    if (escapedByte == null) text += `\\${escaped}`;
    else appendByte(escapedByte);
  }
  flush();
  return { output: concatBytes(chunks), stopped: false };
}

function trimRepeatedLeadingNewlines(value) {
  if (!value.startsWith("\n")) return value;
  let index = 1;
  while (value[index] === "\n") index += 1;
  return `\n${value.slice(index)}`;
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
  const operands = args.slice(index);
  if (!escapes) {
    const lastEndsInNewline = operands.at(-1)?.endsWith("\n") ?? false;
    const output = operands.map(trimRepeatedLeadingNewlines).join(" ");
    return result(0, output + (!lastEndsInNewline && newline ? "\n" : ""));
  }

  const output = [];
  let stopped = false;
  for (let operandIndex = 0; operandIndex < operands.length; operandIndex += 1) {
    const operand = operands[operandIndex];
    const last = operandIndex === operands.length - 1;
    const expanded = appendEchoEscapes(operand);
    output.push(expanded.output);
    stopped = expanded.stopped;
    if (stopped) break;
    if (!last) output.push(bytes(" "));
  }
  if (!stopped && newline) output.push(bytes("\n"));
  return result(0, concatBytes(output));
}

function printfEscapes(value) {
  let terminated = false;
  const output = String(value).replace(/\\([0-7]{1,3}|.)/g, (_, escape) => {
    if (escape === "c") { terminated = true; return ""; }
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    return ({ a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" })[escape] ?? escape;
  });
  return { output, terminated };
}

function printf(args) {
  if (args.length === 0) return result();
  const format = String(args[0]);
  let position = 1;
  let output = "";
  let terminated = false;
  const conversions = (format.match(/%(?!%)[sdiuoxXcb]/g) ?? []).length;

  do {
    let iteration = format.replace(/%([%sdiuoxXcb])/g, (_, specifier) => {
      if (specifier === "%") return "%";
      const value = args[position++] ?? "";
      if (specifier === "s") return String(value);
      if (specifier === "c") return String(value)[0] ?? "";
      if (specifier === "b") {
        const escaped = printfEscapes(value);
        terminated ||= escaped.terminated;
        return escaped.output;
      }
      const number = Number(value) || 0;
      if (specifier === "d" || specifier === "i" || specifier === "u") return String(Math.trunc(number));
      if (specifier === "o") return Math.trunc(number).toString(8);
      const hexadecimal = Math.trunc(number).toString(16);
      return specifier === "X" ? hexadecimal.toUpperCase() : hexadecimal;
    });
    const escaped = printfEscapes(iteration);
    output += escaped.output;
    terminated ||= escaped.terminated;
  } while (!terminated && conversions > 0 && position < args.length);

  return result(0, output);
}

function sequence(args) {
  const usage = "usage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last\n";
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
  const operands = args.slice(index);
  if (operands.length === 0) return result(1, "", usage);
  // Bun's seq parser consumes at most three numeric operands and ignores the
  // rest, matching the vendored SliceIterator implementation.
  const values = operands.slice(0, 3).map(Number);
  if (values.some(value => !Number.isFinite(value))) {
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

async function readInputBytes(input) {
  if (input == null || typeof input.getReader !== "function") return bytes(input);
  const reader = input.getReader();
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(bytes(value));
    }
  } finally {
    reader.releaseLock();
  }
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = globalThis.Buffer?.alloc ? Buffer.alloc(length) : new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function catArguments(args) {
  let index = 0;
  for (; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("-")) break;
    if (argument === "-") return { error: "cat: illegal option -- -\n" };
    const flag = argument.slice(1);
    if (argument.startsWith("--")) {
      return { error: `cat: illegal option -- ${argument.slice(2)}\n` };
    }
    if ("benstuv".includes(flag[0])) {
      return { error: `cat: unsupported option, please open a GitHub issue -- -${flag[0]}\n` };
    }
    return { error: `cat: illegal option -- ${flag}\n` };
  }
  return { operands: args.slice(index) };
}

function catNeedsExternalProcess(args, context) {
  const parsed = catArguments(args);
  if (parsed.error) return false;
  return parsed.operands.some(path => {
    try { return statSync(absolute(context, path)).isFIFO(); }
    catch { return false; }
  });
}

async function pipeCatInput(input, output) {
  if (input == null || typeof input.getReader !== "function") return output.write(bytes(input));
  const reader = input.getReader();
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        complete = true;
        return true;
      }
      if (await output.write(value)) continue;
      await reader.cancel(new Error("Pipeline output closed"));
      return false;
    }
  } finally {
    if (!complete) {
      try { await reader.cancel(); } catch {}
    }
    reader.releaseLock();
  }
}

async function cat(args, context, input, pipelineOutput = null) {
  const parsed = catArguments(args);
  if (parsed.error) return result(1, "", parsed.error);
  const operands = parsed.operands;
  const consumesInput = operands.length === 0;

  if (pipelineOutput != null) {
    let stderr = "";
    let open = true;
    if (consumesInput) {
      open = await pipeCatInput(input, pipelineOutput);
    } else {
      for (const path of operands) {
        try { open = await pipelineOutput.write(readFileSync(absolute(context, path))); }
        catch (error) { stderr = `cat: ${path}: ${errorReason(error)}\n`; }
        if (!open || stderr) break;
      }
    }
    return { ...result(stderr ? 1 : open ? 0 : 1, "", stderr), consumedInput: consumesInput, piped: true };
  }

  const stdin = consumesInput ? await readInputBytes(input) : bytes();
  if (operands.length === 0) return { ...result(0, stdin), consumedInput: true };
  const chunks = [];
  let stderr = "";
  for (const path of operands) {
    try {
      chunks.push(bytes(readFileSync(absolute(context, path))));
    } catch (error) {
      stderr = `cat: ${path}: ${errorReason(error)}\n`;
      break;
    }
  }
  return { exitCode: stderr ? 1 : 0, stdout: context.concat(chunks), stderr: bytes(stderr), consumedInput: consumesInput };
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

const LS_FILE_TYPE_MASK = 0o170000;
const LS_FILE_TYPES = new Map([
  [0o040000, "d"],
  [0o120000, "l"],
  [0o060000, "b"],
  [0o020000, "c"],
  [0o010000, "p"],
  [0o140000, "s"],
]);
const LS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function lsStatNumber(value, fallback = 0) {
  if (typeof value === "bigint") return Number(value);
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function lsPermissions(mode) {
  const bit = (mask, character) => mode & mask ? character : "-";
  const ownerExecute = mode & 0o100;
  const groupExecute = mode & 0o010;
  const otherExecute = mode & 0o001;
  return [
    bit(0o400, "r"),
    bit(0o200, "w"),
    mode & 0o4000 ? ownerExecute ? "s" : "S" : ownerExecute ? "x" : "-",
    bit(0o040, "r"),
    bit(0o020, "w"),
    mode & 0o2000 ? groupExecute ? "s" : "S" : groupExecute ? "x" : "-",
    bit(0o004, "r"),
    bit(0o002, "w"),
    mode & 0o1000 ? otherExecute ? "t" : "T" : otherExecute ? "x" : "-",
  ].join("");
}

function lsTimestamp(stat, nowSeconds) {
  const rawSeconds = stat.mtimeMs != null
    ? lsStatNumber(stat.mtimeMs) / 1000
    : stat.mtime instanceof Date
      ? stat.mtime.getTime() / 1000
      : 0;
  const seconds = Math.max(0, Math.trunc(rawSeconds));
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) return "??? ?? ??:??";

  const month = LS_MONTHS[date.getUTCMonth()] ?? "???";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const sixMonths = 180 * 24 * 60 * 60;
  const recent = seconds > nowSeconds - sixMonths && seconds <= nowSeconds + sixMonths;
  if (recent) {
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${month} ${day} ${hours}:${minutes}`;
  }
  return `${month} ${day}  ${String(date.getUTCFullYear()).padStart(4, "0")}`;
}

function lsLongEntry(path, display, nowSeconds) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return `?????????? ? ? ? ?            ? ${display}\n`;
  }

  const mode = lsStatNumber(stat.mode);
  const type = LS_FILE_TYPES.get(mode & LS_FILE_TYPE_MASK) ?? "-";
  const links = String(Math.trunc(lsStatNumber(stat.nlink, 1))).padStart(3, " ");
  const uid = String(Math.trunc(lsStatNumber(stat.uid))).padStart(5, " ");
  const gid = String(Math.trunc(lsStatNumber(stat.gid))).padStart(5, " ");
  const size = String(Math.trunc(lsStatNumber(stat.size))).padStart(8, " ");
  return `${type}${lsPermissions(mode)} ${links} ${uid} ${gid} ${size} ${lsTimestamp(stat, nowSeconds)} ${display}\n`;
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
    output.push(options.long && !stat.isDirectory()
      ? lsLongEntry(path, display, options.nowSeconds)
      : `${display}\n`);
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
  for (const name of names) {
    output.push(options.long
      ? lsLongEntry(join(path, name), name, options.nowSeconds)
      : `${name}\n`);
  }
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
  const parsed = parseFlags(args, "RAad1l");
  if (parsed.illegal) return result(1, "", `ls: illegal option -- ${parsed.illegal}\n`);
  const options = {
    recursive: parsed.flags.has("R"),
    all: parsed.flags.has("a"),
    almostAll: parsed.flags.has("A"),
    directory: parsed.flags.has("d"),
    long: parsed.flags.has("l"),
    nowSeconds: Math.trunc(Date.now() / 1000),
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
      if (stat.isDirectory() && directory && !recursive) rmdirSync(path);
      else rmSync(path, { recursive, force });
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
  return async function runBuiltin(name, args, context, input = bytes(), pipelineOutput = null) {
    switch (name) {
      case ":":
      case "true": return result();
      case "false": return result(1);
      case "echo": return echo(args);
      case "printf": return printf(args);
      case "seq": return sequence(args);
      case "cat":
        return catNeedsExternalProcess(args, context) ? null : cat(args, context, input, pipelineOutput);
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
          const output = Object.keys(context.exported).sort().map(key => `${key}=${context.env[key] ?? ""}\n`).join("");
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
      case "wait": {
        if (args.length > 0) return result(127, "", `wait: ${args[0]}: no such job\n`);
        const pending = context.background.splice(0);
        if (pending.length === 0) return result();
        const completed = await Promise.all(pending);
        return {
          exitCode: completed.at(-1)?.exitCode ?? 0,
          stdout: context.concat(completed.map(item => item.stdout)),
          stderr: context.concat(completed.map(item => item.stderr)),
        };
      }
      case "basename":
        return args.length
          ? result(0, `${args.map(value => basename(value) || (/^\/+$/u.test(value) ? "/" : "")).join("\n")}\n`)
          : result(1, "", "usage: basename string\n");
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
        const line = `${args.length ? args.join(" ") : "y"}\n`;
        if (pipelineOutput != null) {
          const repetitions = Math.max(1, Math.ceil(8192 / line.length));
          const block = line.repeat(repetitions);
          while (await pipelineOutput.write(block)) {}
          return { ...result(1), piped: true };
        }
        // COTTONTAIL-COMPAT: Bun shell standalone yes cancellation - the public
        // shell host does not yet pass an AbortSignal into this interpreter.
        return result(0, line.repeat(4096));
      }
      default: return null;
    }
  };
}
