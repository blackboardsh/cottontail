import { closeSync, lstatSync, openSync, readFileSync, readdirSync, statSync, writeSync } from "../node/fs.js";
import { basename, dirname, isAbsolute, join, resolve } from "../node/path.js";
import picomatch from "../vendor/picomatch.js";
import { createShellBuiltins } from "./bun-shell-builtins.js";
import { lexShell, parseShell } from "./bun-shell-parser.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const INPUT_REDIRECTS = new Set(["<", "<<", "0<", "0<<", "0>", "0>>"]);
const SHELL_REDIRECTS = new Set(["<", "<<", "0<", "0<<", "0>", "0>>", ">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>", "2>&1", "1>&2", ">&2", ">&1"]);
const COMMAND_BOUNDARY_OPERATORS = new Set([";", "&&", "||", "|", "!", "(", "{"]);
const COMMAND_BOUNDARY_WORDS = new Set(["if", "then", "elif", "else"]);

function bytes(value = "") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return encoder.encode(String(value));
}

function concat(chunks) {
  const values = chunks.filter(Boolean).map(bytes);
  if (values.length === 0) return bytes();
  if (values.length === 1) return values[0];
  const length = values.reduce((total, value) => total + value.byteLength, 0);
  const output = new Uint8Array(length);
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

function quoteAt(source, stop) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < stop; index += 1) {
    const character = source[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
  }
  return quote;
}

function validateOutputReferences(source, outputTargets) {
  if (!(outputTargets instanceof Map) || outputTargets.size === 0) return;
  for (const marker of outputTargets.keys()) {
    let offset = 0;
    while ((offset = source.indexOf(marker, offset)) !== -1) {
      if (quoteAt(source, offset) === '"') {
        throw new SyntaxError("JS object reference not allowed in double quotes");
      }
      offset += marker.length;
    }
  }
}

function shellSyntax(message, position) {
  const error = new SyntaxError(message);
  error.position = position;
  return error;
}

function commandPosition(tokens, index) {
  if (index === 0) return true;
  const previous = tokens[index - 1];
  if (previous.type === "op") return COMMAND_BOUNDARY_OPERATORS.has(previous.value);
  return previous.type === "word" && COMMAND_BOUNDARY_WORDS.has(previous.raw);
}

function rewriteSubshellRedirects(source) {
  if (!source.includes("(")) return source;
  const tokens = lexShell(source);
  const stack = [];
  const ranges = [];
  let conditionalDepth = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "word" && token.raw === "[[") {
      conditionalDepth += 1;
      continue;
    }
    if (token.type === "word" && token.raw === "]]" && conditionalDepth > 0) {
      conditionalDepth -= 1;
      continue;
    }
    if (conditionalDepth > 0 || token.type !== "op") continue;
    if (token.value === "(") {
      stack.push({ position: token.position, command: commandPosition(tokens, index) });
      continue;
    }
    if (token.value !== ")" || stack.length === 0) continue;
    const open = stack.pop();
    const next = tokens[index + 1];
    if (open.command && next?.type === "op" && SHELL_REDIRECTS.has(next.value)) {
      ranges.push({ start: open.position, end: token.position + 1 });
    }
  }

  if (ranges.length === 0) return source;
  const edits = [];
  for (const range of ranges) {
    edits.push({ position: range.start, text: "{ " });
    edits.push({ position: range.end, text: "; }" });
  }
  edits.sort((left, right) => right.position - left.position || right.text.length - left.text.length);
  let rewritten = source;
  for (const edit of edits) {
    rewritten = `${rewritten.slice(0, edit.position)}${edit.text}${rewritten.slice(edit.position)}`;
  }
  return rewritten;
}

function markerCommand(node, markers) {
  return node?.type === "command"
    && (node.redirects?.length ?? 0) === 0
    && node.words?.length === 1
    && markers.has(node.words[0].raw);
}

function markRightmostAsync(node) {
  if (node?.type === "binary") return { ...node, right: markRightmostAsync(node.right) };
  return { type: "async", command: node };
}

function transformBackgroundMarkers(node, markers) {
  if (node == null || typeof node !== "object") return node;
  if (node.type === "script") {
    const items = node.items.map(item => transformBackgroundMarkers(item, markers));
    for (let index = 0; index < items.length;) {
      if (!markerCommand(items[index], markers)) {
        index += 1;
        continue;
      }
      if (index === 0) throw shellSyntax('Unexpected "&"', 0);
      items[index - 1] = markRightmostAsync(items[index - 1]);
      items.splice(index, 1);
    }
    return { ...node, items };
  }
  if (node.type === "binary") {
    return {
      ...node,
      left: transformBackgroundMarkers(node.left, markers),
      right: transformBackgroundMarkers(node.right, markers),
    };
  }
  if (node.type === "pipeline") {
    return { ...node, items: node.items.map(item => transformBackgroundMarkers(item, markers)) };
  }
  if (node.type === "negate") return { ...node, command: transformBackgroundMarkers(node.command, markers) };
  if (node.type === "async") return { ...node, command: transformBackgroundMarkers(node.command, markers) };
  if (node.type === "subshell" || node.type === "group") {
    return { ...node, script: transformBackgroundMarkers(node.script, markers) };
  }
  if (node.type === "if") {
    return {
      ...node,
      branches: node.branches.map(branch => ({
        condition: transformBackgroundMarkers(branch.condition, markers),
        consequent: transformBackgroundMarkers(branch.consequent, markers),
      })),
      alternate: transformBackgroundMarkers(node.alternate, markers),
    };
  }
  if (node.type === "assignmentPrefix") {
    return { ...node, command: transformBackgroundMarkers(node.command, markers) };
  }
  return node;
}

function rewriteBackgroundLists(source) {
  if (!source.includes("&")) return { source, markers: new Set() };
  const tokens = lexShell(source);
  const background = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "op" || token.value !== "&") continue;
    const next = tokens[index + 1];
    if (next?.type === "op" && ["&&", "||", "|", "&"].includes(next.value)) {
      throw shellSyntax(`"&" is not allowed on the left-hand side of "${next.value}"`, token.position);
    }
    background.push(token);
  }
  if (background.length === 0) return { source, markers: new Set() };

  let markerPrefix = "__cottontail_shell_async__";
  while (source.includes(markerPrefix)) markerPrefix += "_";
  const markers = new Set();
  let rewritten = source;
  for (let index = background.length - 1; index >= 0; index -= 1) {
    const token = background[index];
    const marker = `${markerPrefix}${index}`;
    markers.add(marker);
    rewritten = `${rewritten.slice(0, token.position)}; ${marker};${rewritten.slice(token.position + 1)}`;
  }
  return { source: rewritten, markers };
}

const shellParseCache = new Map();
const shellParseCacheEntryLimit = 32;
const shellParseCacheSourceLimit = 8 * 1024 * 1024;
let shellParseCacheSourceLength = 0;

function cacheShellParse(source, entry) {
  if (source.length > shellParseCacheSourceLimit) return;
  const existing = shellParseCache.get(source);
  if (existing) {
    shellParseCacheSourceLength -= source.length;
    shellParseCache.delete(source);
  }
  shellParseCache.set(source, entry);
  shellParseCacheSourceLength += source.length;
  while (shellParseCache.size > shellParseCacheEntryLimit || shellParseCacheSourceLength > shellParseCacheSourceLimit) {
    const oldestSource = shellParseCache.keys().next().value;
    if (oldestSource === undefined) break;
    shellParseCache.delete(oldestSource);
    shellParseCacheSourceLength -= oldestSource.length;
  }
}

function cachedShellParseError(error) {
  return {
    name: String(error?.name ?? "Error"),
    message: String(error?.message ?? error),
    position: error?.position,
    code: error?.code,
  };
}

function throwCachedShellParseError(cached) {
  const error = cached.name === "SyntaxError"
    ? new SyntaxError(cached.message)
    : new Error(cached.message);
  error.name = cached.name;
  if (cached.position !== undefined) error.position = cached.position;
  if (cached.code !== undefined) error.code = cached.code;
  throw error;
}

export function parseBunShellSource(source) {
  // Public Bun.$ execution accepts async lists and redirected subshells while
  // the testing serializer keeps Bun v1.3.10's parser diagnostics unchanged.
  source = String(source);
  const cached = shellParseCache.get(source);
  if (cached) {
    shellParseCache.delete(source);
    shellParseCache.set(source, cached);
    if (cached.error) throwCachedShellParseError(cached.error);
    return cached.value;
  }
  try {
    const redirected = rewriteSubshellRedirects(source);
    const rewritten = rewriteBackgroundLists(redirected);
    const value = transformBackgroundMarkers(parseShell(rewritten.source), rewritten.markers);
    cacheShellParse(source, { value });
    return value;
  } catch (error) {
    cacheShellParse(source, { error: cachedShellParseError(error) });
    throw error;
  }
}

function cloneContext(context, { preserveCommandEnv = false, isolateBackground = false } = {}) {
  return {
    cwd: context.cwd,
    env: { ...context.env },
    exported: { ...context.exported },
    // Bun's dupeForSubshell always starts with an empty cmd_local_env. Prefix
    // assignments belong to one command and must not leak into substitutions,
    // pipelines, asynchronous commands, or subshells.
    externalEnv: preserveCommandEnv ? { ...context.externalEnv } : {},
    status: context.status,
    argv: [...context.argv],
    outputTargets: context.outputTargets,
    background: isolateBackground ? [] : context.background,
    openRedirects: context.openRedirects,
    pid: context.pid,
    concat,
  };
}

async function joinBackground(context, output) {
  const pending = context.background.splice(0);
  if (pending.length === 0) return output;
  const completed = await Promise.all(pending);
  return {
    ...output,
    stdout: concat([output.stdout, ...completed.map(item => item.stdout)]),
    stderr: concat([output.stderr, ...completed.map(item => item.stderr)]),
  };
}

const PROTECTED = "\ue000";
const PROTECTED_SYNTAX = new Map([
  ["\\", "b"], ["{", "l"], ["}", "r"], [",", "c"],
  ["*", "s"], ["?", "q"], ["[", "o"], ["]", "e"],
]);
const PROTECTED_CODES = new Map([...PROTECTED_SYNTAX].map(([character, code]) => [code, character]));

function escapeProtectionMarker(value) {
  value = String(value);
  return value.includes(PROTECTED) ? value.replaceAll(PROTECTED, `${PROTECTED}0`) : value;
}

function protectShellSyntax(value) {
  value = String(value);
  const output = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const code = character === PROTECTED ? "0" : PROTECTED_SYNTAX.get(character);
    if (code == null) continue;
    if (start < index) output.push(value.slice(start, index));
    output.push(`${PROTECTED}${code}`);
    start = index + 1;
  }
  if (output.length === 0) return value;
  if (start < value.length) output.push(value.slice(start));
  return output.join("");
}

function restoreProtectedSyntax(value) {
  if (!value.includes(PROTECTED)) return value;
  const output = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== PROTECTED || index + 1 >= value.length) continue;
    if (start < index) output.push(value.slice(start, index));
    const code = value[++index];
    output.push(code === "0" ? PROTECTED : PROTECTED_CODES.get(code) ?? code);
    start = index + 1;
  }
  if (start < value.length) output.push(value.slice(start));
  return output.join("");
}

function globMatcherPattern(value) {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== PROTECTED || index + 1 >= value.length) {
      output += value[index];
      continue;
    }
    const code = value[++index];
    const character = code === "0" ? PROTECTED : PROTECTED_CODES.get(code) ?? code;
    output += `\\${character}`;
  }
  return output;
}

function exportedEnvironment(context) {
  const env = {};
  for (const [key, value] of Object.entries(context.env)) {
    if (context.exported[key]) env[key] = value;
  }
  Object.assign(env, context.externalEnv);
  return env;
}

function unwrapNestedBraceChoice(value) {
  if (value[0] !== "{") return value;
  let depth = 0;
  let comma = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    else if (value[index] === "}" && --depth === 0) {
      if (index !== value.length - 1 || comma) return value;
      return unwrapNestedBraceChoice(value.slice(1, -1));
    } else if (value[index] === "," && depth === 1) comma = true;
  }
  return value;
}

function expandBraces(value, output = [], depth = 0) {
  if (depth > 256 || output.length > 32768) throw new RangeError("Brace expansion is too large");
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
  for (const choice of choices) {
    expandBraces(prefix + unwrapNestedBraceChoice(choice) + suffix, output, depth + 1);
  }
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

    const magic = hasGlobSyntax(segment);
    const literalSegment = restoreProtectedSyntax(segment);
    const matcher = magic ? picomatch(globMatcherPattern(segment), { dot: literalSegment.startsWith(".") }) : null;
    const next = [];
    for (const candidate of candidates) {
      const names = magic
        ? (() => { try { return readdirSync(candidate.path).map(String).sort(); } catch { return []; } })()
        : [literalSegment];
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

function commandSubstitutionText(value, quoted) {
  if (quoted) return value.replace(/[ \n\t\r]+$/, "");
  return value
    .replace(/\n/g, " ")
    .trim()
    .replace(/[ \t\r]+/g, " ");
}

async function expandText(text, context, execute, quoted) {
  const output = [];
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
      const substitutionContext = cloneContext(context, { isolateBackground: true });
      const substitution = await joinBackground(
        substitutionContext,
        await execute(parseBunShellSource(script), substitutionContext, bytes()),
      );
      output.push(commandSubstitutionText(decoder.decode(substitution.stdout), quoted));
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
      const substitutionContext = cloneContext(context, { isolateBackground: true });
      const substitution = await joinBackground(
        substitutionContext,
        await execute(parseBunShellSource(script), substitutionContext, bytes()),
      );
      output.push(commandSubstitutionText(decoder.decode(substitution.stdout), quoted));
      if (substitution.stderr.byteLength) context.expansionStderr?.push(substitution.stderr);
      context.status = substitution.exitCode;
      index = cursor + 1;
      continue;
    }
    if (text[index] !== "$") {
      const dollar = text.indexOf("$", index);
      const backtick = text.indexOf("`", index);
      const next = dollar < 0 ? backtick : backtick < 0 ? dollar : Math.min(dollar, backtick);
      const end = next < 0 ? text.length : next;
      output.push(text.slice(index, end));
      index = end;
      continue;
    }
    if (text[index + 1] === "{") {
      const close = closingParameterBrace(text, index + 2);
      if (close < 0) { output.push("$"); index += 1; continue; }
      const expression = text.slice(index + 2, close);
      output.push(await expandParameter(expression, context, execute, quoted));
      index = close + 1;
      continue;
    }
    // Bun tokenizes unbraced positional parameters one digit at a time, so
    // `$10` expands as `$1` followed by the literal `0`.
    const match = /^(?:[A-Za-z_][A-Za-z0-9_]*|[?*@#$!\-]|\d)/.exec(text.slice(index + 1));
    if (!match) { output.push("$"); index += 1; continue; }
    output.push(parameterValue(match[0], context));
    index += match[0].length + 1;
  }
  return output.join("");
}

function hasGlobSyntax(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === PROTECTED) {
      index += 1;
      continue;
    }
    if (value[index] === "*" || value[index] === "?" || value[index] === "[") return true;
  }
  return false;
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
  for (const match of text.matchAll(/[ \t\n\r]+/g)) {
    append(text.slice(cursor, match.index));
    const current = fields.at(-1);
    if (current?.present || current?.value) current.closed = true;
    cursor = match.index + match[0].length;
  }
  append(text.slice(cursor));
}

async function expandWord(word, context, execute, { assignment = false, redirect = false } = {}) {
  if (word.parts.length === 1 && word.parts[0].quote === "unquoted") {
    const literal = word.parts[0].text;
    if (literal !== ""
      && literal[0] !== "~"
      && !literal.includes("$")
      && !literal.includes("`")
      && !literal.includes("{")
      && !literal.includes("*")
      && !literal.includes("?")
      && !literal.includes("[")
      && !literal.includes(PROTECTED)) {
      return [literal];
    }
  }
  const quoted = word.parts.some(part => part.quote !== "unquoted");
  const braceEligible = word.parts.some(part => part.quote === "unquoted" && part.text.includes("{") && part.text.includes(","));
  const tildeEligible = word.parts[0]?.quote === "unquoted" && word.parts[0].text.startsWith("~");
  const expandedFromValue = word.parts.some(part => part.expand && (/\$(?:\(|\{|[A-Za-z_?*@#0-9])/.test(part.text) || part.text.includes("`")));
  const expandedParts = [];
  for (const part of word.parts) {
    const value = part.expand ? await expandText(part.text, context, execute, part.quote !== "unquoted") : part.text;
    expandedParts.push({
      ...part,
      value: part.quote === "unquoted" ? escapeProtectionMarker(value) : protectShellSyntax(value),
    });
  }
  const fields = [];
  if (!quoted) {
    const joined = expandedParts.map(part => part.value).join("");
    for (const value of braceEligible ? expandBraces(joined) : [joined]) {
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

  const braceExpandedFields = [];
  for (const field of fields) {
    const expansions = braceEligible && field.value.includes("{") ? expandBraces(field.value) : [field.value];
    for (const value of expansions) {
      braceExpandedFields.push({
        ...field,
        value,
        globEligible: field.globEligible || hasGlobSyntax(value),
      });
    }
  }

  const values = [];
  for (const field of braceExpandedFields) {
    if (!field.present && field.value === "" && !assignment && !redirect) continue;
    let value = field.value;
    if (tildeEligible && value.startsWith("~") && (value.length === 1 || value[1] === "/")) {
      value = `${context.env.HOME ?? context.env.USERPROFILE ?? "~"}${value.slice(1)}`;
    }
    if (!assignment && !redirect && field.globEligible && hasGlobSyntax(value)) {
      const matches = globCandidates(value, context.cwd);
      if (matches.length === 0) {
        if (expandedFromValue) {
          values.push(restoreProtectedSyntax(value));
          continue;
        }
        const error = new Error(`bun: no matches found: ${restoreProtectedSyntax(value)}`);
        error.code = "BUN_SHELL_NO_MATCH";
        throw error;
      }
      values.push(...matches);
    } else if (value !== "" || field.present || assignment || redirect) values.push(restoreProtectedSyntax(value));
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

function closePreparedRedirects(redirects) {
  for (const redirect of redirects) {
    if (redirect.fd == null) continue;
    try { closeSync(redirect.fd); } catch {}
    redirect.openRedirects?.delete(redirect.fd);
    redirect.fd = null;
  }
}

function writeAllSync(fd, value) {
  let offset = 0;
  while (offset < value.byteLength) {
    const written = writeSync(fd, value, offset, value.byteLength - offset, null);
    if (written <= 0) throw new Error("Unable to write redirected output");
    offset += written;
  }
}

async function setupRedirects(redirects, context, input, commandName) {
  const inputPaths = new Set();
  for (const redirect of redirects) {
    if (redirect.ambiguous) {
      return { error: result(1, "", `bun: ambiguous redirect: at \`${commandName}\`\n`), input };
    }
    if (INPUT_REDIRECTS.has(redirect.operator)) {
      try {
        if (isStreamingInput(input)) cancelPipelineInput(input);
        input = bytes(readFileSync(redirect.path));
        inputPaths.clear();
        inputPaths.add(redirect.path);
      } catch (error) {
        closePreparedRedirects(redirects);
        return { error: result(1, "", fileReason(error, redirect.targetValue)), input };
      }
      continue;
    }
    if (redirect.target == null) continue;

    try {
      if (redirect.outputTarget != null) {
        if (redirect.outputTarget instanceof ArrayBuffer) new Uint8Array(redirect.outputTarget);
        else new Uint8Array(redirect.outputTarget.buffer, redirect.outputTarget.byteOffset, redirect.outputTarget.byteLength);
      } else {
        redirect.fd = openSync(redirect.path, redirect.operator.endsWith(">>") ? "a" : "w", 0o666);
        redirect.openRedirects = context.openRedirects;
        context.openRedirects.add(redirect.fd);
        if (!redirect.operator.endsWith(">>") && inputPaths.has(redirect.path)) input = bytes();
      }
    } catch (error) {
      closePreparedRedirects(redirects);
      return { error: result(1, "", fileReason(error, redirect.targetValue)), input };
    }
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
    if (INPUT_REDIRECTS.has(redirect.operator)) continue;
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
    const { redirect } = destination;
    try {
      const outputTarget = redirect.outputTarget;
      if (outputTarget != null) {
        const view = outputTarget instanceof ArrayBuffer
          ? new Uint8Array(outputTarget)
          : new Uint8Array(outputTarget.buffer, outputTarget.byteOffset, outputTarget.byteLength);
        view.set(stream.subarray(0, view.byteLength));
      } else if (stream.byteLength > 0) {
        writeAllSync(redirect.fd, stream);
      }
    } catch (error) {
      stderrCapture.chunks.push(bytes(fileReason(error, redirect.targetValue)));
      exitCode = 1;
    }
  }
  closePreparedRedirects(redirects);
  return {
    ...commandResult,
    exitCode,
    stdout: concat(stdoutCapture.chunks),
    stderr: concat(stderrCapture.chunks),
  };
}

const pipelineInputChannels = new WeakMap();
const PIPELINE_CHUNK_SIZE = 16 * 1024;

function yieldPipelineIO() {
  return new Promise(resolveReady => {
    if (typeof globalThis.setImmediate === "function") globalThis.setImmediate(resolveReady);
    else globalThis.setTimeout(resolveReady, 0);
  });
}

function createPipelineChannel() {
  let controller;
  let cancelled = false;
  let closed = false;
  const ready = [];
  const wake = () => {
    while (ready.length) ready.shift()();
  };
  const stream = new ReadableStream({
    start(value) { controller = value; },
    pull() { wake(); },
    cancel() {
      cancelled = true;
      closed = true;
      wake();
    },
  }, { highWaterMark: 1 });

  const channel = {
    stream,
    get cancelled() { return cancelled; },
    async waitForConsumer() {
      for (let attempt = 0; attempt < 64 && !cancelled && !stream.locked; attempt += 1) {
        await Promise.resolve();
      }
    },
    async write(value) {
      const chunk = bytes(value);
      if (chunk.byteLength === 0) return !cancelled;
      for (let offset = 0; offset < chunk.byteLength; offset += PIPELINE_CHUNK_SIZE) {
        while (!cancelled && !closed && controller.desiredSize != null && controller.desiredSize <= 0) {
          await new Promise(resolveReady => ready.push(resolveReady));
        }
        if (cancelled || closed) return false;
        try {
          controller.enqueue(chunk.subarray(offset, Math.min(offset + PIPELINE_CHUNK_SIZE, chunk.byteLength)));
        } catch {
          cancelled = true;
          closed = true;
          wake();
          return false;
        }
        if (offset + PIPELINE_CHUNK_SIZE < chunk.byteLength) await yieldPipelineIO();
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      try { controller.close(); } catch {}
      wake();
    },
    cancel() {
      if (closed) return;
      cancelled = true;
      closed = true;
      try { controller.close(); } catch {}
      wake();
    },
  };
  pipelineInputChannels.set(stream, channel);
  return channel;
}

function isStreamingInput(input) {
  return input != null && typeof input.getReader === "function";
}

function cancelPipelineInput(input) {
  pipelineInputChannels.get(input)?.cancel();
}

async function collectProcess(child, pipelineOutput = null) {
  if (pipelineOutput == null) {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      child.stdout?.bytes?.() ?? Promise.resolve(bytes()),
      child.stderr?.bytes?.() ?? Promise.resolve(bytes()),
    ]);
    return result(exitCode == null ? 1 : Number(exitCode), stdout, stderr);
  }

  const cancelledBeforeSpawn = pipelineOutput.cancelled;
  let pipeClosed = cancelledBeforeSpawn;
  let sentPipeSignal = false;
  const pumpStdout = async () => {
    if (child.stdout == null) return;
    for await (const chunk of child.stdout) {
      if (!pipeClosed && await pipelineOutput.write(chunk)) continue;
      pipeClosed = true;
      if (!sentPipeSignal) {
        sentPipeSignal = true;
        child.kill?.(globalThis.process?.platform === "win32" ? "SIGTERM" : "SIGPIPE");
      }
    }
  };
  const [exitCode, , stderr] = await Promise.all([
    child.exited,
    pumpStdout(),
    child.stderr?.bytes?.() ?? Promise.resolve(bytes()),
  ]);
  return {
    ...result(exitCode == null ? 1 : Number(exitCode), "", stderr),
    piped: true,
    pipeClosed,
  };
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
    const redirected = await setupRedirects(redirects, context, input, name);
    if (redirected.error) return redirected.error;
    const commandResult = await callback(redirected.input);
    return applyRedirects(commandResult, redirects);
  }

  function isAssignmentOnlyPipelineItem(node) {
    return node.type === "command"
      && (node.redirects?.length ?? 0) === 0
      && node.words.length > 0
      && node.words.every(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.raw));
  }

  async function executePipelineStage(node, context, input, output) {
    try {
      const stageResult = await execute(node, context, input, output);
      if (isStreamingInput(input)) cancelPipelineInput(input);
      if (output != null && !stageResult.piped) await output.write(stageResult.stdout);
      output?.close();
      return output == null ? stageResult : { ...stageResult, stdout: bytes() };
    } catch (error) {
      output?.cancel(error);
      throw error;
    }
  }

  async function execute(node, context, input = bytes(), pipelineOutput = null) {
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
      const items = node.items.filter(item => !isAssignmentOnlyPipelineItem(item));
      if (items.length === 0) {
        if (isStreamingInput(input)) cancelPipelineInput(input);
        return result();
      }
      const channels = Array.from({ length: Math.max(0, items.length - 1) }, createPipelineChannel);
      const stages = new Array(items.length);
      for (let index = items.length - 1; index >= 0; index -= 1) {
        const stageInput = index === 0 ? input : channels[index - 1].stream;
        const stageOutput = index === items.length - 1 ? null : channels[index];
        stages[index] = executePipelineStage(items[index], cloneContext(context), stageInput, stageOutput);
        // Start consumers before producers so an input-ignoring command can
        // close the upstream socket before the producer performs useful work.
        if (index > 0) await channels[index - 1].waitForConsumer();
      }
      const completed = await Promise.all(stages);
      const current = completed.at(-1) ?? result();
      return { ...current, exitCode: current.exitCode, stderr: concat(completed.map(item => item.stderr)), shellExit: false };
    }

    if (node.type === "negate") {
      const commandResult = await execute(node.command, context, input, pipelineOutput);
      if (commandResult.shellExit) return commandResult;
      return { ...commandResult, exitCode: commandResult.exitCode === 0 ? 1 : 0 };
    }

    if (node.type === "async") {
      const commandContext = cloneContext(context, { isolateBackground: true });
      const promise = new Promise(resolve => setTimeout(resolve, 0))
        .then(async () => joinBackground(commandContext, await execute(node.command, commandContext, input)))
        .then(output => ({ ...output, shellExit: false }));
      context.background.push(promise);
      return result();
    }

    if (node.type === "subshell") {
      return executeCompound(node, context, input, "subshell", async redirectedInputBytes => {
        const subshellContext = cloneContext(context, { isolateBackground: true });
        const output = await execute(node.script, subshellContext, redirectedInputBytes);
        context.background.push(...subshellContext.background.splice(0));
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
    const redirected = await setupRedirects(redirects, context, input, commandName);
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
      if (isStreamingInput(input)) cancelPipelineInput(input);
      return applyRedirects(result(expansionHadCommandSubstitution ? context.status : 0, "", expansionStderr), redirects);
    }

    const commandContext = assignments.length
      ? cloneContext(context, { preserveCommandEnv: true })
      : context;
    for (const assignment of assignments) {
      commandContext.env[assignment.name] = assignment.value;
      commandContext.exported[assignment.name] = true;
      commandContext.externalEnv[assignment.name] = assignment.value;
      context.externalEnv[assignment.name] = assignment.value;
    }
    let [name, ...args] = expanded;
    let commandResult = await runBuiltin(name, args, commandContext, input, pipelineOutput);
    if (commandResult != null && isStreamingInput(input) && commandResult.consumedInput !== true) {
      cancelPipelineInput(input);
    }

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
        commandResult = await execute(parseBunShellSource(decoder.decode(bytes(readFileSync(scriptPath)))), scriptContext, input);
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
        commandResult = await execute(parseBunShellSource(args.join(" ")), commandContext, input);
      }
    }

    if (commandResult == null) {
      if (name === "bun") name = host.execPath;
      try {
        const child = host.spawn([name, ...args], {
          cwd: commandContext.cwd,
          env: exportedEnvironment(commandContext),
          stdin: isStreamingInput(input) ? input : input.byteLength ? input : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        const streamsToPipeline = pipelineOutput != null
          && redirects.every(redirect => INPUT_REDIRECTS.has(redirect.operator));
        commandResult = await collectProcess(child, streamsToPipeline ? pipelineOutput : null);
      } catch (error) {
        if (isStreamingInput(input)) cancelPipelineInput(input);
        commandResult = result(1, "", `bun: command not found: ${expanded[0]}\n`);
      }
    }
    commandResult.stderr = concat([expansionStderr, commandResult.stderr]);
    return applyRedirects(commandResult, redirects);
  }

  return async function runShell(source, options = {}) {
    validateOutputReferences(source, options.outputTargets);
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
      openRedirects: new Set(),
      pid: globalThis.process?.pid,
      concat,
    };
    try {
      const output = await joinBackground(
        context,
        await execute(parseBunShellSource(source), context, bytes(options.input ?? "")),
      );
      return {
        status: output.exitCode,
        stdout: output.stdout,
        stderr: output.stderr,
      };
    } catch (error) {
      if (error?.code === "BUN_SHELL_NO_MATCH") return { status: 1, stdout: bytes(), stderr: bytes(`${error.message}\n`) };
      if (error?.code === "BUN_SHELL_PARAMETER") return { status: 1, stdout: bytes(), stderr: bytes(`${error.message}\n`) };
      throw error;
    } finally {
      for (const fd of context.openRedirects) {
        try { closeSync(fd); } catch {}
      }
      context.openRedirects.clear();
    }
  };
}
