import { appendFileSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "../node/fs.js";
import { basename, dirname, isAbsolute, join, resolve } from "../node/path.js";
import picomatch from "../vendor/picomatch.js";
import { createShellBuiltins } from "./bun-shell-builtins.js";
import { parseShell } from "./bun-shell-parser.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value = "") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return globalThis.Buffer?.from ? Buffer.from(String(value)) : encoder.encode(String(value));
}

function concat(chunks) {
  const values = chunks.filter(Boolean).map(bytes);
  const length = values.reduce((total, value) => total + value.byteLength, 0);
  const output = globalThis.Buffer?.alloc ? Buffer.alloc(length) : new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function result(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, stdout: bytes(stdout), stderr: bytes(stderr) };
}

function cloneContext(context) {
  return {
    cwd: context.cwd,
    env: { ...context.env },
    exported: { ...context.exported },
    externalEnv: { ...context.externalEnv },
    status: context.status,
    argv: [...context.argv],
    outputTargets: context.outputTargets,
    background: context.background,
    pid: context.pid,
    concat,
  };
}

function exportedEnvironment(context) {
  const env = {};
  for (const [key, value] of Object.entries(context.env)) {
    if (context.exported[key]) env[key] = value;
  }
  Object.assign(env, context.externalEnv);
  return env;
}

function expandBraces(value, output = [], depth = 0) {
  if (depth > 64 || output.length > 32768) throw new RangeError("Brace expansion is too large");
  let open = -1;
  let nesting = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "{") { open = index; break; }
  }
  if (open < 0) { output.push(value); return output; }
  let close = -1;
  escaped = false;
  for (let index = open; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "{") nesting += 1;
    else if (char === "}" && --nesting === 0) { close = index; break; }
  }
  if (close < 0) { output.push(value); return output; }
  const body = value.slice(open + 1, close);
  const choices = [];
  let start = 0;
  nesting = 0;
  escaped = false;
  for (let index = 0; index <= body.length; index += 1) {
    const char = body[index];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "{") nesting += 1;
    else if (char === "}") nesting -= 1;
    if (index === body.length || (char === "," && nesting === 0)) {
      choices.push(body.slice(start, index));
      start = index + 1;
    }
  }
  if (choices.length === 1) { output.push(value); return output; }
  const prefix = value.slice(0, open);
  const suffix = value.slice(close + 1);
  for (const choice of choices) expandBraces(prefix + choice + suffix, output, depth + 1);
  return output;
}

function descendantDirectories(root, output = []) {
  let names;
  try { names = readdirSync(root).map(String).sort(); } catch { return output; }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const child = join(root, name);
    let stat;
    try { stat = lstatSync(child); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    output.push({ path: child, suffix: name });
    for (const nested of descendantDirectories(child)) {
      output.push({ path: nested.path, suffix: `${name}/${nested.suffix}` });
    }
  }
  return output;
}

// Bun's expansion walker matches each path component, including **, instead
// of applying a matcher only to the final basename.
function globCandidates(pattern, cwd) {
  const normalized = pattern.replace(/\\/g, "/");
  let root = cwd;
  let displayRoot = "";
  let segments = normalized.split("/");
  if (/^[A-Za-z]:\//.test(normalized)) {
    root = normalized.slice(0, 3);
    displayRoot = root;
    segments = segments.slice(1);
  } else if (normalized.startsWith("/")) {
    root = "/";
    displayRoot = "/";
    segments.shift();
  }

  let candidates = [{ path: root, display: displayRoot }];
  for (const segment of segments) {
    if (segment === "") continue;
    if (segment === "**") {
      const recursive = [];
      for (const candidate of candidates) {
        recursive.push(candidate);
        for (const descendant of descendantDirectories(candidate.path)) {
          recursive.push({
            path: descendant.path,
            display: candidate.display ? `${candidate.display.replace(/\/$/, "")}/${descendant.suffix}` : descendant.suffix,
          });
        }
      }
      candidates = recursive;
      continue;
    }

    const magic = /[*?[\]]/.test(segment);
    const matcher = magic ? picomatch(segment, { dot: segment.startsWith(".") }) : null;
    const next = [];
    for (const candidate of candidates) {
      const names = magic
        ? (() => { try { return readdirSync(candidate.path).map(String).sort(); } catch { return []; } })()
        : [segment];
      for (const name of names) {
        if (matcher && !matcher(name)) continue;
        const path = join(candidate.path, name);
        try { lstatSync(path); } catch { continue; }
        const display = candidate.display
          ? `${candidate.display.replace(/\/$/, "")}/${name}`
          : name;
        next.push({ path, display });
      }
    }
    candidates = next;
  }
  return candidates.map(candidate => candidate.display || ".");
}

function parameterState(name, context) {
  if (name === "?") return { set: true, value: String(context.status ?? 0) };
  if (name === "#") return { set: true, value: String(Math.max(0, context.argv.length - 1)) };
  if (name === "@" || name === "*") return { set: true, value: context.argv.slice(1).join(" ") };
  if (name === "$" ) return { set: true, value: String(context.pid ?? "") };
  if (name === "!" || name === "-") return { set: false, value: "" };
  if (/^\d+$/.test(name)) {
    const value = context.argv[Number(name)];
    return { set: value !== undefined, value: value ?? "" };
  }
  return { set: Object.prototype.hasOwnProperty.call(context.env, name), value: context.env[name] ?? "" };
}

function parameterValue(name, context) {
  const state = parameterState(name, context);
  return typeof state === "string" ? state : state.value;
}

function closingParameterBrace(text, start) {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "\\") { index += 1; continue; }
    if (text.startsWith("${", index)) { depth += 1; index += 1; continue; }
    if (text[index] === "}" && --depth === 0) return index;
  }
  return -1;
}

async function expandParameter(expression, context, execute, quoted) {
  if (expression.startsWith("#") && /^[A-Za-z_][A-Za-z0-9_]*$/.test(expression.slice(1))) {
    return String(parameterValue(expression.slice(1), context).length);
  }
  const match = /^([A-Za-z_][A-Za-z0-9_]*|[?*@#$!\-]|\d+)(:?[-+=?])?([\s\S]*)$/.exec(expression);
  if (!match) return parameterValue(expression, context);
  const [, name, operator = "", operand = ""] = match;
  const stateValue = parameterState(name, context);
  const state = typeof stateValue === "string" ? { set: true, value: stateValue } : stateValue;
  if (!operator) return state.value;

  const colon = operator.startsWith(":");
  const kind = operator.at(-1);
  const missing = !state.set || (colon && state.value === "");
  if (kind === "-") return missing ? expandText(operand, context, execute, quoted) : state.value;
  if (kind === "+") return missing ? "" : expandText(operand, context, execute, quoted);
  if (kind === "=") {
    if (!missing) return state.value;
    const value = await expandText(operand, context, execute, quoted);
    if (/^[A-Za-z_]/.test(name)) context.env[name] = value;
    return value;
  }
  if (kind === "?" && missing) {
    const detail = operand || "parameter is not set";
    const error = new Error(`bun: ${name}: ${detail}`);
    error.code = "BUN_SHELL_PARAMETER";
    throw error;
  }
  return state.value;
}

async function expandText(text, context, execute, quoted) {
  let output = "";
  for (let index = 0; index < text.length;) {
    if (text.startsWith("$(", index)) {
      let cursor = index + 2;
      let depth = 1;
      let quote = null;
      let escaped = false;
      while (cursor < text.length) {
        const char = text[cursor];
        if (escaped) escaped = false;
        else if (char === "\\" && quote !== "'") escaped = true;
        else if (quote) { if (char === quote) quote = null; }
        else if (char === "'" || char === '"' || char === "`") quote = char;
        else if (char === "(") depth += 1;
        else if (char === ")" && --depth === 0) break;
        cursor += 1;
      }
      const script = text.slice(index + 2, cursor);
      const substitution = await execute(parseShell(script), cloneContext(context), bytes());
      output += decoder.decode(substitution.stdout).replace(/\n+$/, "");
      if (substitution.stderr.byteLength) context.expansionStderr?.push(substitution.stderr);
      context.status = substitution.exitCode;
      index = cursor + 1;
      continue;
    }
    if (text[index] === "`") {
      let cursor = index + 1;
      let escaped = false;
      while (cursor < text.length) {
        if (escaped) escaped = false;
        else if (text[cursor] === "\\") escaped = true;
        else if (text[cursor] === "`") break;
        cursor += 1;
      }
      const script = text.slice(index + 1, cursor).replace(/\\`/g, "`");
      const substitution = await execute(parseShell(script), cloneContext(context), bytes());
      output += decoder.decode(substitution.stdout).replace(/\n+$/, "");
      if (substitution.stderr.byteLength) context.expansionStderr?.push(substitution.stderr);
      context.status = substitution.exitCode;
      index = cursor + 1;
      continue;
    }
    if (text[index] !== "$") {
      output += text[index++];
      continue;
    }
    if (text[index + 1] === "{") {
      const close = closingParameterBrace(text, index + 2);
      if (close < 0) { output += "$"; index += 1; continue; }
      const expression = text.slice(index + 2, close);
      output += await expandParameter(expression, context, execute, quoted);
      index = close + 1;
      continue;
    }
    const match = /^(?:[A-Za-z_][A-Za-z0-9_]*|[?*@#$!\-]|\d+)/.exec(text.slice(index + 1));
    if (!match) { output += "$"; index += 1; continue; }
    output += parameterValue(match[0], context);
    index += match[0].length + 1;
  }
  return output;
}

function hasGlobSyntax(value) {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

function appendExpandedSegment(fields, text, split, globEligible, preserveEmpty) {
  const append = value => {
    let field = fields.at(-1);
    if (!field || field.closed) {
      field = { value: "", globEligible: false, present: false, closed: false };
      fields.push(field);
    }
    field.value += value;
    field.globEligible ||= globEligible && hasGlobSyntax(value);
    field.present ||= value.length > 0 || preserveEmpty;
  };

  if (!split) {
    append(text);
    return;
  }
  let cursor = 0;
  for (const match of text.matchAll(/[ \t\n]+/g)) {
    append(text.slice(cursor, match.index));
    const current = fields.at(-1);
    if (current?.present || current?.value) current.closed = true;
    cursor = match.index + match[0].length;
  }
  append(text.slice(cursor));
}

async function expandWord(word, context, execute, { assignment = false, redirect = false } = {}) {
  const quoted = word.parts.some(part => part.quote !== "unquoted");
  const tildeEligible = word.parts[0]?.quote === "unquoted" && word.parts[0].text.startsWith("~");
  const expandedFromValue = word.parts.some(part => part.expand && (/\$(?:\(|\{|[A-Za-z_?*@#0-9])/.test(part.text) || part.text.includes("`")));
  const expandedParts = [];
  for (const part of word.parts) {
    expandedParts.push({
      ...part,
      value: part.expand ? await expandText(part.text, context, execute, part.quote !== "unquoted") : part.text,
    });
  }
  const fields = [];
  if (!quoted) {
    for (const value of expandBraces(expandedParts.map(part => part.value).join(""))) {
      appendExpandedSegment(fields, value, !assignment && !redirect, true, assignment || redirect);
      if (fields.length) fields.at(-1).closed = true;
    }
  } else {
    for (const part of expandedParts) {
      const dynamic = part.expand && (/\$(?:\(|\{|[A-Za-z_?*@#$!0-9\-])/.test(part.text) || part.text.includes("`"));
      appendExpandedSegment(
        fields,
        part.value,
        part.quote === "unquoted" && dynamic && !assignment && !redirect,
        part.quote === "unquoted",
        part.quote !== "unquoted" || assignment || redirect,
      );
    }
  }

  const values = [];
  for (const field of fields) {
    if (!field.present && field.value === "" && !assignment && !redirect) continue;
    let value = field.value;
    if (tildeEligible && value.startsWith("~") && (value.length === 1 || value[1] === "/")) {
      value = `${context.env.HOME ?? context.env.USERPROFILE ?? "~"}${value.slice(1)}`;
    }
    if (!assignment && !redirect && field.globEligible && hasGlobSyntax(value)) {
      const matches = globCandidates(value, context.cwd);
      if (matches.length === 0) {
        if (expandedFromValue) {
          values.push(value);
          continue;
        }
        const error = new Error(`bun: no matches found: ${value}`);
        error.code = "BUN_SHELL_NO_MATCH";
        throw error;
      }
      values.push(...matches);
    } else if (value !== "" || field.present || assignment || redirect) values.push(value);
  }
  return values;
}

function assignmentParts(value) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(value);
  return match ? { name: match[1], value: match[2] } : null;
}

function fileReason(error, path) {
  const message = String(error?.message ?? error);
  if (error?.code === "ENOENT" || /no such file or directory/i.test(message)) return `bun: No such file or directory: ${path}\n`;
  if (error?.code === "ENOTDIR" || /not a directory/i.test(message)) return `bun: Not a directory: ${path}\n`;
  if (error?.code === "EACCES" || error?.code === "EPERM" || /permission denied/i.test(message)) return `bun: Permission denied: ${path}\n`;
  return `bun: ${message}\n`;
}

async function prepareRedirects(redirects, context, execute) {
  const prepared = [];
  for (const redirect of redirects ?? []) {
    if (redirect.target == null) {
      prepared.push(redirect);
      continue;
    }
    const targets = await expandWord(redirect.target, context, execute);
    if (targets.length !== 1 || targets[0] === "") {
      prepared.push({ ...redirect, ambiguous: true });
      continue;
    }
    const target = targets[0];
    prepared.push({
      ...redirect,
      targetValue: target,
      path: isAbsolute(target) ? target : resolve(context.cwd, target),
      outputTarget: context.outputTargets?.get(target),
    });
  }
  return prepared;
}

async function redirectedInput(redirects, context, input, commandName) {
  for (const redirect of redirects) {
    if (!["<", "<<", "0<", "0<<"].includes(redirect.operator)) continue;
    if (redirect.ambiguous) {
      return { error: result(1, "", `bun: ambiguous redirect: at \`${commandName}\`\n`), input };
    }
    try { input = bytes(readFileSync(redirect.path)); }
    catch (error) { return { error: result(1, "", fileReason(error, redirect.targetValue)), input }; }
  }
  return { input, error: null };
}

function ambiguousRedirect(redirects, commandName) {
  return redirects.some(redirect => redirect.ambiguous)
    ? result(1, "", `bun: ambiguous redirect: at \`${commandName}\`\n`)
    : null;
}

async function applyRedirects(commandResult, redirects) {
  const stdoutCapture = { kind: "capture", chunks: [] };
  const stderrCapture = { kind: "capture", chunks: [] };
  const routes = { 1: stdoutCapture, 2: stderrCapture };
  const destinations = [];
  let exitCode = commandResult.exitCode;
  const replaceRoute = (fd, destination) => {
    const previous = routes[fd];
    // Bun merges duplicate_out with a following file/buffer redirect, so
    // descriptors which alias each other remain linked to the new target.
    for (const key of [1, 2]) {
      if (routes[key] === previous) routes[key] = destination;
    }
  };

  for (const redirect of redirects) {
    if (["<", "<<", "0<", "0<<"].includes(redirect.operator)) continue;
    if (redirect.operator === "2>&1") {
      routes[2] = routes[1];
      continue;
    }
    if (redirect.operator === "1>&2" || redirect.operator === ">&2") {
      routes[1] = routes[2];
      continue;
    }
    if (redirect.operator === ">&1") continue;
    const append = redirect.operator.endsWith(">>");
    const both = redirect.operator.startsWith("&");
    const redirectsStderr = redirect.operator.startsWith("2");
    const destination = { kind: "redirect", redirect, append, chunks: [] };
    destinations.push(destination);
    if (both) routes[1] = routes[2] = destination;
    else replaceRoute(redirectsStderr ? 2 : 1, destination);
  }

  routes[1].chunks.push(bytes(commandResult.stdout));
  routes[2].chunks.push(bytes(commandResult.stderr));
  for (const destination of destinations) {
    const stream = concat(destination.chunks);
    const { redirect, append } = destination;
    try {
      const outputTarget = redirect.outputTarget;
      if (outputTarget != null) {
        const view = outputTarget instanceof ArrayBuffer
          ? new Uint8Array(outputTarget)
          : new Uint8Array(outputTarget.buffer, outputTarget.byteOffset, outputTarget.byteLength);
        view.set(stream.subarray(0, view.byteLength));
      } else if (append) appendFileSync(redirect.path, stream);
      else writeFileSync(redirect.path, stream);
    } catch (error) {
      stderrCapture.chunks.push(bytes(fileReason(error, redirect.targetValue)));
      exitCode = 1;
    }
  }
  return {
    ...commandResult,
    exitCode,
    stdout: concat(stdoutCapture.chunks),
    stderr: concat(stderrCapture.chunks),
  };
}

async function collectProcess(child) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout?.bytes?.() ?? Promise.resolve(bytes()),
    child.stderr?.bytes?.() ?? Promise.resolve(bytes()),
  ]);
  return result(exitCode == null ? 1 : Number(exitCode), stdout, stderr);
}

function conditionalStat(value, context, symbolic = false) {
  if (value === "") return null;
  const path = isAbsolute(value) ? value : resolve(context.cwd, value);
  try { return (symbolic ? lstatSync : statSync)(path); } catch { return null; }
}

const CONDITIONAL_UNARY = new Set([
  "-a", "-b", "-c", "-d", "-e", "-f", "-g", "-h", "-k", "-p", "-r", "-s", "-t", "-u", "-w", "-x",
  "-G", "-L", "-N", "-O", "-R", "-S", "-v", "-z", "-n", "-o",
]);
const CONDITIONAL_BINARY = new Set(["=", "==", "!=", "<", ">", "-eq", "-ne", "-lt", "-le", "-gt", "-ge", "-ef", "-nt", "-ot"]);

function evaluateConditionalUnary(operator, operand, context) {
  if (operator === "-z") return operand.length === 0;
  if (operator === "-n") return operand.length > 0;
  if (operator === "-v") return Object.prototype.hasOwnProperty.call(context.env, operand);
  if (operator === "-R" || operator === "-o" || operator === "-t") return false;
  const symbolic = operator === "-h" || operator === "-L";
  const stat = conditionalStat(operand, context, symbolic);
  if (!stat) return false;
  if (operator === "-a" || operator === "-e") return true;
  if (operator === "-b") return stat.isBlockDevice?.() === true;
  if (operator === "-c") return stat.isCharacterDevice();
  if (operator === "-d") return stat.isDirectory();
  if (operator === "-f") return stat.isFile();
  if (operator === "-h" || operator === "-L") return stat.isSymbolicLink();
  if (operator === "-p") return stat.isFIFO?.() === true;
  if (operator === "-S") return stat.isSocket?.() === true;
  if (operator === "-s") return Number(stat.size) > 0;
  const mode = Number(stat.mode ?? 0);
  if (operator === "-g") return (mode & 0o2000) !== 0;
  if (operator === "-k") return (mode & 0o1000) !== 0;
  if (operator === "-u") return (mode & 0o4000) !== 0;
  if (operator === "-r") return (mode & 0o444) !== 0;
  if (operator === "-w") return (mode & 0o222) !== 0;
  if (operator === "-x") return (mode & 0o111) !== 0;
  if (operator === "-O") return typeof process?.getuid !== "function" || Number(stat.uid) === process.getuid();
  if (operator === "-G") return typeof process?.getgid !== "function" || Number(stat.gid) === process.getgid();
  if (operator === "-N") return Number(stat.mtimeMs ?? 0) > Number(stat.atimeMs ?? 0);
  return false;
}

function evaluateConditionalBinary(left, operator, right, context) {
  if (operator === "==" || operator === "=") return right === "" ? left === "" : picomatch.isMatch(left, right);
  if (operator === "!=") return right === "" ? left !== "" : !picomatch.isMatch(left, right);
  if (operator === "<") return left < right;
  if (operator === ">") return left > right;
  if (operator === "-eq") return Number(left) === Number(right);
  if (operator === "-ne") return Number(left) !== Number(right);
  if (operator === "-lt") return Number(left) < Number(right);
  if (operator === "-le") return Number(left) <= Number(right);
  if (operator === "-gt") return Number(left) > Number(right);
  if (operator === "-ge") return Number(left) >= Number(right);
  const leftStat = conditionalStat(left, context);
  const rightStat = conditionalStat(right, context);
  if (operator === "-ef") return !!leftStat && !!rightStat && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  if (operator === "-nt") return !!leftStat && (!rightStat || Number(leftStat.mtimeMs) > Number(rightStat.mtimeMs));
  if (operator === "-ot") return !!rightStat && (!leftStat || Number(leftStat.mtimeMs) < Number(rightStat.mtimeMs));
  return false;
}

function evaluateConditional(values, context) {
  let index = 0;
  const parsePrimary = () => {
    if (values[index] === "(") {
      index += 1;
      const value = parseOr();
      if (values[index] === ")") index += 1;
      return value;
    }
    const first = values[index++] ?? "";
    if (CONDITIONAL_UNARY.has(first)) return evaluateConditionalUnary(first, values[index++] ?? "", context);
    const operator = values[index];
    if (CONDITIONAL_BINARY.has(operator)) {
      index += 1;
      return evaluateConditionalBinary(first, operator, values[index++] ?? "", context);
    }
    return first.length > 0;
  };
  const parseNot = () => values[index] === "!" ? (index += 1, !parseNot()) : parsePrimary();
  const parseAnd = () => {
    let value = parseNot();
    while (values[index] === "&&") { index += 1; value = parseNot() && value; }
    return value;
  };
  const parseOr = () => {
    let value = parseAnd();
    while (values[index] === "||") { index += 1; value = parseAnd() || value; }
    return value;
  };
  return parseOr();
}

export function createBunShellRuntime(host) {
  const runBuiltin = createShellBuiltins({
    which(command, env, cwd) {
      if (command === "bun") return host.execPath;
      return host.which(command, { ...env, cwd });
    },
  });

  async function executeCompound(node, context, input, name, callback) {
    const redirects = await prepareRedirects(node.redirects, context, execute);
    const redirectFailure = ambiguousRedirect(redirects, name);
    if (redirectFailure) return redirectFailure;
    const redirected = await redirectedInput(redirects, context, input, name);
    if (redirected.error) return redirected.error;
    const commandResult = await callback(redirected.input);
    return applyRedirects(commandResult, redirects);
  }

  async function execute(node, context, input = bytes()) {
    if (node.type === "script") {
      const stdout = [];
      const stderr = [];
      let current = result();
      for (const item of node.items) {
        current = await execute(item, context, input);
        context.status = current.exitCode;
        stdout.push(current.stdout);
        stderr.push(current.stderr);
        if (current.shellExit) break;
        input = bytes();
      }
      return { ...current, exitCode: current.exitCode, stdout: concat(stdout), stderr: concat(stderr) };
    }

    if (node.type === "binary") {
      const left = await execute(node.left, context, input);
      context.status = left.exitCode;
      if (left.shellExit) return left;
      if ((node.operator === "&&" && left.exitCode !== 0) || (node.operator === "||" && left.exitCode === 0)) return left;
      const right = await execute(node.right, context, bytes());
      return { ...right, exitCode: right.exitCode, stdout: concat([left.stdout, right.stdout]), stderr: concat([left.stderr, right.stderr]) };
    }

    if (node.type === "pipeline") {
      let pipeInput = input;
      let current = result();
      const stderr = [];
      for (const item of node.items) {
        current = await execute(item, cloneContext(context), pipeInput);
        pipeInput = current.stdout;
        stderr.push(current.stderr);
      }
      return { exitCode: current.exitCode, stdout: current.stdout, stderr: concat(stderr) };
    }

    if (node.type === "negate") {
      const commandResult = await execute(node.command, context, input);
      if (commandResult.shellExit) return commandResult;
      return { ...commandResult, exitCode: commandResult.exitCode === 0 ? 1 : 0 };
    }

    if (node.type === "async") {
      const commandContext = cloneContext(context);
      const promise = Promise.resolve()
        .then(() => execute(node.command, commandContext, input))
        .then(output => ({ ...output, shellExit: false }));
      context.background.push(promise);
      return result();
    }

    if (node.type === "subshell") {
      return executeCompound(node, context, input, "subshell", async redirectedInputBytes => {
        const output = await execute(node.script, cloneContext(context), redirectedInputBytes);
        return { ...output, shellExit: false };
      });
    }

    if (node.type === "group") {
      return executeCompound(node, context, input, "group", redirectedInputBytes => execute(node.script, context, redirectedInputBytes));
    }

    if (node.type === "if") {
      return executeCompound(node, context, input, "if", async redirectedInputBytes => {
        const output = [];
        const errors = [];
        for (const branch of node.branches) {
          const condition = await execute(branch.condition, context, redirectedInputBytes);
          output.push(condition.stdout);
          errors.push(condition.stderr);
          if (condition.shellExit) return { ...condition, stdout: concat(output), stderr: concat(errors) };
          if (condition.exitCode === 0) {
            const consequent = await execute(branch.consequent, context, bytes());
            return { ...consequent, stdout: concat([...output, consequent.stdout]), stderr: concat([...errors, consequent.stderr]) };
          }
        }
        if (node.alternate) {
          const alternate = await execute(node.alternate, context, bytes());
          return { ...alternate, stdout: concat([...output, alternate.stdout]), stderr: concat([...errors, alternate.stderr]) };
        }
        return { exitCode: 0, stdout: concat(output), stderr: concat(errors) };
      });
    }

    if (node.type === "conditional") {
      return executeCompound(node, context, input, "[[", async () => {
        const values = [];
        for (const word of node.words) {
          if (word.type === "op") values.push(word.value);
          else values.push(...await expandWord(word, context, execute, { assignment: true }));
        }
        return result(evaluateConditional(values, context) ? 0 : 1);
      });
    }

    if (node.type === "assignmentPrefix") {
      const commandContext = cloneContext(context);
      for (const word of node.assignments) {
        const [expanded = ""] = await expandWord(word, commandContext, execute, { assignment: true });
        const assignment = assignmentParts(expanded);
        if (!assignment) continue;
        commandContext.env[assignment.name] = assignment.value;
        commandContext.exported[assignment.name] = true;
        commandContext.externalEnv[assignment.name] = assignment.value;
      }
      return execute(node.command, commandContext, input);
    }

    const commandName = node.words[0]?.raw ?? "";
    const redirects = await prepareRedirects(node.redirects, context, execute);
    const redirectFailure = ambiguousRedirect(redirects, commandName);
    if (redirectFailure) return redirectFailure;
    const redirected = await redirectedInput(redirects, context, input, commandName);
    if (redirected.error) return redirected.error;
    input = redirected.input;

    const expansionHadCommandSubstitution = node.words.some(word => word.parts.some(part => part.expand && (part.text.includes("$(") || part.text.includes("`"))));
    const expansionErrors = [];
    const previousExpansionStderr = context.expansionStderr;
    context.expansionStderr = expansionErrors;
    const expanded = [];
    let acceptsAssignments = true;
    try {
      for (const word of node.words) {
        const assignment = acceptsAssignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.raw);
        if (!assignment) acceptsAssignments = false;
        expanded.push(...await expandWord(word, context, execute, { assignment }));
      }
    } finally {
      context.expansionStderr = previousExpansionStderr;
    }
    const expansionStderr = concat(expansionErrors);
    const assignments = [];
    while (expanded.length) {
      const assignment = assignmentParts(expanded[0]);
      if (!assignment) break;
      assignments.push(assignment);
      expanded.shift();
    }
    if (expanded.length === 0) {
      for (const assignment of assignments) context.env[assignment.name] = assignment.value;
      const passthrough = input.byteLength ? input : bytes();
      return applyRedirects(result(expansionHadCommandSubstitution ? context.status : 0, passthrough, expansionStderr), redirects);
    }

    const commandContext = assignments.length ? cloneContext(context) : context;
    for (const assignment of assignments) {
      commandContext.env[assignment.name] = assignment.value;
      commandContext.exported[assignment.name] = true;
      commandContext.externalEnv[assignment.name] = assignment.value;
      context.externalEnv[assignment.name] = assignment.value;
    }
    let [name, ...args] = expanded;
    let commandResult = await runBuiltin(name, args, commandContext, input);

    const resolvedRuntimePath = resolve(host.execPath);
    const invokesRuntime = name === "bun"
      || name === "cottontail"
      || resolve(commandContext.cwd, name) === resolvedRuntimePath
      || basename(name) === basename(resolvedRuntimePath);
    if (commandResult == null && invokesRuntime && args[0] === "run" && /\.bun\.sh$/i.test(args[1] ?? "")) {
      const scriptPath = isAbsolute(args[1]) ? args[1] : resolve(commandContext.cwd, args[1]);
      try {
        const scriptContext = cloneContext(commandContext);
        scriptContext.env = exportedEnvironment(commandContext);
        scriptContext.exported = Object.fromEntries(Object.keys(scriptContext.env).map(key => [key, true]));
        scriptContext.externalEnv = {};
        scriptContext.argv = [scriptPath, ...args.slice(2)];
        commandResult = await execute(parseShell(decoder.decode(bytes(readFileSync(scriptPath)))), scriptContext, input);
        commandResult.shellExit = false;
      } catch (error) {
        commandResult = result(1, "", fileReason(error, args[1]));
      }
    }

    if (commandResult == null && (name === "exec" || (invokesRuntime && args[0] === "exec"))) {
      if (name !== "exec") args = args.slice(1);
      if (args.length === 0) {
        commandResult = result(0, 'Usage: bun exec <script>\n\nExecute a shell script directly from Bun.\n\nNote: If executing this from a shell, make sure to escape the string!\n\nExamples:\n  bun exec "echo hi"\n  bun exec "echo \\"hey friends\\"!"\n');
      } else {
        commandResult = await execute(parseShell(args.join(" ")), commandContext, input);
      }
    }

    if (commandResult == null) {
      if (name === "bun") name = host.execPath;
      try {
        const child = host.spawn([name, ...args], {
          cwd: commandContext.cwd,
          env: exportedEnvironment(commandContext),
          stdin: input.byteLength ? input : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        commandResult = await collectProcess(child);
      } catch (error) {
        commandResult = result(1, "", `bun: command not found: ${expanded[0]}\n`);
      }
    }
    commandResult.stderr = concat([expansionStderr, commandResult.stderr]);
    return applyRedirects(commandResult, redirects);
  }

  return async function runShell(source, options = {}) {
    const env = { ...host.env(), ...(options.env ?? {}) };
    const cwd = resolve(String(options.cwd ?? host.cwd()));
    env.PWD = cwd;
    const context = {
      cwd,
      env,
      exported: Object.fromEntries(Object.keys(env).map(key => [key, true])),
      externalEnv: {},
      status: 0,
      argv: [...host.argv()],
      outputTargets: options.outputTargets,
      background: [],
      pid: globalThis.process?.pid,
      concat,
    };
    try {
      const output = await execute(parseShell(source), context, bytes(options.input ?? ""));
      const background = context.background.splice(0);
      if (background.length === 0) return { status: output.exitCode, stdout: output.stdout, stderr: output.stderr };
      const completed = await Promise.all(background);
      return {
        status: output.exitCode,
        stdout: concat([output.stdout, ...completed.map(item => item.stdout)]),
        stderr: concat([output.stderr, ...completed.map(item => item.stderr)]),
      };
    } catch (error) {
      if (error?.code === "BUN_SHELL_NO_MATCH") return { status: 1, stdout: bytes(), stderr: bytes(`${error.message}\n`) };
      if (error?.code === "BUN_SHELL_PARAMETER") return { status: 1, stdout: bytes(), stderr: bytes(`${error.message}\n`) };
      throw error;
    }
  };
}
