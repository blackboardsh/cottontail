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

function globCandidates(pattern, cwd) {
  const normalized = pattern.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  const directoryPart = slash >= 0 ? normalized.slice(0, slash) || "/" : ".";
  const filePattern = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  const directory = isAbsolute(directoryPart) ? directoryPart : resolve(cwd, directoryPart);
  let names;
  try { names = readdirSync(directory).map(String); } catch { return []; }
  const matcher = picomatch(filePattern, { dot: filePattern.startsWith(".") });
  return names.filter(name => matcher(name)).sort().map(name => slash >= 0 ? join(directoryPart, name) : name);
}

function parameterValue(name, context) {
  if (name === "?") return String(context.status ?? 0);
  if (name === "#") return String(Math.max(0, context.argv.length - 1));
  if (name === "@" || name === "*") return context.argv.slice(1).join(" ");
  if (/^\d+$/.test(name)) return context.argv[Number(name)] ?? "";
  return context.env[name] ?? "";
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
      const close = text.indexOf("}", index + 2);
      if (close < 0) { output += "$"; index += 1; continue; }
      const expression = text.slice(index + 2, close);
      const fallback = /^([A-Za-z_][A-Za-z0-9_]*):-([\s\S]*)$/.exec(expression);
      const name = fallback?.[1] ?? expression;
      const value = parameterValue(name, context);
      output += value === "" && fallback ? fallback[2] : value;
      index = close + 1;
      continue;
    }
    const match = /^(?:[A-Za-z_][A-Za-z0-9_]*|[?*@#]|\d+)/.exec(text.slice(index + 1));
    if (!match) { output += "$"; index += 1; continue; }
    output += parameterValue(match[0], context);
    index += match[0].length + 1;
  }
  return output;
}

async function expandWord(word, context, execute, { assignment = false, redirect = false } = {}) {
  const quoted = word.parts.some(part => part.quote !== "unquoted");
  const tildeEligible = word.parts[0]?.quote === "unquoted" && word.parts[0].text.startsWith("~");
  const expandedFromValue = word.parts.some(part => part.expand && (/\$(?:\(|\{|[A-Za-z_?*@#0-9])/.test(part.text) || part.text.includes("`")));
  let combined = "";
  for (const part of word.parts) {
    combined += part.expand ? await expandText(part.text, context, execute, part.quote !== "unquoted") : part.text;
  }
  const braceValues = quoted ? [combined] : expandBraces(combined);
  const values = [];
  for (let value of braceValues) {
    if (tildeEligible && value.startsWith("~") && (value.length === 1 || value[1] === "/")) {
      value = `${context.env.HOME ?? context.env.USERPROFILE ?? "~"}${value.slice(1)}`;
    }
    const fields = !quoted && !assignment && !redirect ? value.split(/[ \t\n]+/).filter(Boolean) : [value];
    for (const field of fields) {
      if (!quoted && !assignment && /[*?[\]]/.test(field)) {
        const matches = globCandidates(field, context.cwd);
        if (matches.length === 0) {
          if (expandedFromValue) {
            values.push(field);
            continue;
          }
          const error = new Error(`bun: no matches found: ${field}`);
          error.code = "BUN_SHELL_NO_MATCH";
          throw error;
        }
        values.push(...matches);
      } else if (field !== "" || quoted || assignment || redirect) values.push(field);
    }
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

async function redirectedInput(redirects, context, execute, input, commandName) {
  for (const redirect of redirects ?? []) {
    if (redirect.operator !== "<") continue;
    const targets = await expandWord(redirect.target, context, execute);
    if (targets.length !== 1 || targets[0] === "") {
      return { error: result(1, "", `bun: ambiguous redirect: at \`${commandName}\`\n`), input };
    }
    const target = targets[0];
    try { input = bytes(readFileSync(isAbsolute(target) ? target : resolve(context.cwd, target))); }
    catch (error) { return { error: result(1, "", fileReason(error, target)), input }; }
  }
  return { input, error: null };
}

async function applyRedirects(commandResult, redirects, context, execute, commandName) {
  let stdout = bytes(commandResult.stdout);
  let stderr = bytes(commandResult.stderr);
  let exitCode = commandResult.exitCode;
  for (const redirect of redirects ?? []) {
    if (redirect.operator === "<") continue;
    if (redirect.operator === "2>&1") {
      stdout = concat([stdout, stderr]);
      stderr = bytes();
      continue;
    }
    if (redirect.operator === "1>&2") {
      stderr = concat([stdout, stderr]);
      stdout = bytes();
      continue;
    }
    const append = redirect.operator.endsWith(">>");
    const both = redirect.operator.startsWith("&");
    const redirectsStderr = redirect.operator.startsWith("2");
    const targets = await expandWord(redirect.target, context, execute);
    if (targets.length !== 1 || targets[0] === "") {
      if (both) { stdout = bytes(); stderr = bytes(); }
      else if (redirectsStderr) stderr = bytes();
      else stdout = bytes();
      stderr = concat([stderr, bytes(`bun: ambiguous redirect: at \`${commandName}\`\n`)]);
      exitCode = 1;
      continue;
    }
    const target = targets[0];
    const path = isAbsolute(target) ? target : resolve(context.cwd, target);
    const stream = redirectsStderr ? stderr : both ? concat([stdout, stderr]) : stdout;
    if (both) { stdout = bytes(); stderr = bytes(); }
    else if (redirectsStderr) stderr = bytes();
    else stdout = bytes();
    try {
      const outputTarget = context.outputTargets?.get(target);
      if (outputTarget != null) {
        const view = outputTarget instanceof ArrayBuffer
          ? new Uint8Array(outputTarget)
          : new Uint8Array(outputTarget.buffer, outputTarget.byteOffset, outputTarget.byteLength);
        view.set(stream.subarray(0, view.byteLength));
      } else if (append) appendFileSync(path, stream);
      else writeFileSync(path, stream);
    } catch (error) {
      stderr = concat([stderr, bytes(fileReason(error, target))]);
      exitCode = 1;
    }
  }
  return { exitCode, stdout, stderr };
}

async function collectProcess(child) {
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    child.stdout?.bytes?.() ?? Promise.resolve(bytes()),
    child.stderr?.bytes?.() ?? Promise.resolve(bytes()),
  ]);
  return result(exitCode == null ? 1 : Number(exitCode), stdout, stderr);
}

function evaluateConditional(values, context) {
  let invert = false;
  while (values[0] === "!") { invert = !invert; values.shift(); }
  let answer = false;
  if (values.length === 1) answer = values[0].length > 0;
  else if (values.length === 2) {
    const [operator, operand] = values;
    if (operator === "-z") answer = operand.length === 0;
    else if (operator === "-n") answer = operand.length > 0;
    else {
      const path = isAbsolute(operand) ? operand : resolve(context.cwd, operand);
      try {
        const stat = statSync(path);
        if (operator === "-f") answer = stat.isFile();
        else if (operator === "-d") answer = stat.isDirectory();
        else if (operator === "-c") answer = stat.isCharacterDevice();
        else if (operator === "-e") answer = true;
      } catch { answer = false; }
    }
  } else if (values.length >= 3) {
    const [left, operator, right] = values;
    if (operator === "==" || operator === "=") answer = right === "" ? left === "" : picomatch.isMatch(left, right);
    else if (operator === "!=") answer = right === "" ? left !== "" : !picomatch.isMatch(left, right);
    else if (operator === "-eq") answer = Number(left) === Number(right);
    else if (operator === "-ne") answer = Number(left) !== Number(right);
    else if (operator === "-lt") answer = Number(left) < Number(right);
    else if (operator === "-le") answer = Number(left) <= Number(right);
    else if (operator === "-gt") answer = Number(left) > Number(right);
    else if (operator === "-ge") answer = Number(left) >= Number(right);
    else if (operator === "-ef") {
      try {
        const a = statSync(isAbsolute(left) ? left : resolve(context.cwd, left));
        const b = statSync(isAbsolute(right) ? right : resolve(context.cwd, right));
        answer = a.dev === b.dev && a.ino === b.ino;
      } catch { answer = false; }
    }
  }
  return invert ? !answer : answer;
}

export function createBunShellRuntime(host) {
  const runBuiltin = createShellBuiltins({
    which(command, env, cwd) {
      if (command === "bun") return host.execPath;
      return host.which(command, { ...env, cwd });
    },
  });

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
        input = bytes();
      }
      return { exitCode: current.exitCode, stdout: concat(stdout), stderr: concat(stderr) };
    }

    if (node.type === "binary") {
      const left = await execute(node.left, context, input);
      context.status = left.exitCode;
      if ((node.operator === "&&" && left.exitCode !== 0) || (node.operator === "||" && left.exitCode === 0)) return left;
      const right = await execute(node.right, context, bytes());
      return { exitCode: right.exitCode, stdout: concat([left.stdout, right.stdout]), stderr: concat([left.stderr, right.stderr]) };
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

    if (node.type === "subshell") {
      if (node.redirects?.length) throw new Error("Subshells with redirections are currently not supported. Please open a GitHub issue.");
      return execute(node.script, cloneContext(context), input);
    }

    if (node.type === "if") {
      if (node.redirects?.length) throw new Error("Redirecting if-else not supported yet");
      const output = [];
      const errors = [];
      for (const branch of node.branches) {
        const condition = await execute(branch.condition, context, input);
        output.push(condition.stdout);
        errors.push(condition.stderr);
        if (condition.exitCode === 0) {
          const consequent = await execute(branch.consequent, context, bytes());
          return { exitCode: consequent.exitCode, stdout: concat([...output, consequent.stdout]), stderr: concat([...errors, consequent.stderr]) };
        }
      }
      if (node.alternate) {
        const alternate = await execute(node.alternate, context, bytes());
        return { exitCode: alternate.exitCode, stdout: concat([...output, alternate.stdout]), stderr: concat([...errors, alternate.stderr]) };
      }
      return { exitCode: 0, stdout: concat(output), stderr: concat(errors) };
    }

    if (node.type === "conditional") {
      const values = [];
      for (const word of node.words) {
        if (word.type === "op") values.push(word.value);
        else values.push(...await expandWord(word, context, execute, { assignment: true }));
      }
      return result(evaluateConditional(values, context) ? 0 : 1);
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
    const redirected = await redirectedInput(node.redirects, context, execute, input, commandName);
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
      return applyRedirects(result(expansionHadCommandSubstitution ? context.status : 0, passthrough, expansionStderr), node.redirects, context, execute, commandName);
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
    return applyRedirects(commandResult, node.redirects, commandContext, execute, expanded[0]);
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
      concat,
    };
    try {
      const output = await execute(parseShell(source), context, bytes(options.input ?? ""));
      return { status: output.exitCode, stdout: output.stdout, stderr: output.stderr };
    } catch (error) {
      if (error?.code === "BUN_SHELL_NO_MATCH") return { status: 1, stdout: bytes(), stderr: bytes(`${error.message}\n`) };
      throw error;
    }
  };
}
