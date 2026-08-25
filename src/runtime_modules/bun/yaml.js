import {
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  parseAllDocuments as parseAllYAMLDocuments,
  Parser as YAMLParser,
} from "../vendor/yaml.js";

const decoder = new TextDecoder();
const parseOptions = {
  logLevel: "silent",
  merge: false,
  schema: "core",
  uniqueKeys: false,
};

class BoxedScalar {
  constructor(value) {
    this.value = value;
  }
}

function viewBytes(input) {
  if (input == null) return null;
  if (input._bytes instanceof Uint8Array) return input._bytes;
  if (typeof input._getBytes === "function") return input._getBytes();
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && input instanceof SharedArrayBuffer)) {
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return null;
}

function yamlTextInput(input) {
  if (typeof input === "string") return input;
  const bytes = viewBytes(input);
  if (bytes) {
    let end = bytes.byteLength;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    return decoder.decode(bytes.subarray(0, end));
  }
  return String(input ?? "");
}

function syntaxErrorFrom(error) {
  const original = String(error?.message ?? error);
  const message = original.startsWith("YAML Parse error") ? original : `YAML Parse error: ${original}`;
  const syntax = new SyntaxError(message);
  if (error?.stack) syntax.stack = error.stack;
  return syntax;
}

// Enforce YAML directive semantics the vendored parser accepts silently:
// - "It is an error to specify more than one YAML directive for the same
//   document" (YAML 1.2, section 6.8.1).
// - "It is an error to specify more than one TAG directive for the same
//   handle in the same document" (YAML 1.2, section 6.8.2).
// - Every directive group must be followed by a document ("---" directives
//   end marker); directives dangling at the end of the stream are an error.
function validateDirectives(source) {
  let sawYamlDirective = false;
  const tagHandles = new Set();
  let pendingDirectives = false;
  for (const token of new YAMLParser().parse(source)) {
    if (token.type === "directive") {
      const parts = String(token.source ?? "").trim().split(/[ \t]+/);
      const name = parts[0];
      if (name === "%YAML") {
        if (sawYamlDirective) {
          throw new SyntaxError("Duplicate %YAML directive in the same document");
        }
        sawYamlDirective = true;
      } else if (name === "%TAG") {
        const handle = parts[1];
        if (handle) {
          if (tagHandles.has(handle)) {
            throw new SyntaxError(`Duplicate %TAG directive for handle ${handle} in the same document`);
          }
          tagHandles.add(handle);
        }
      }
      pendingDirectives = true;
    } else if (token.type === "document") {
      sawYamlDirective = false;
      tagHandles.clear();
      pendingDirectives = false;
    }
  }
  if (pendingDirectives) {
    throw new SyntaxError("Missing document after directives; expected directives end marker '---'");
  }
}

// --- Memory-lean fast path -------------------------------------------------
// The vendored full YAML parser builds a CST token tree plus an AST document
// for every parse, which has a very large transient allocation footprint on
// big-but-simple documents (issue #26088 upstream). For strictly simple block
// YAML (plain ASCII scalars, block maps/seqs, no quotes/flow/anchors/tags/
// directives/comments/tabs/multi-line scalars) we can produce the identical
// core-schema result directly from the source lines with a tiny fraction of
// the allocations. Anything outside that strict subset bails out to the full
// parser, so semantics never diverge.
const FAST_BAIL = Symbol("yaml.fast.bail");
// Any character with special YAML meaning that the fast subset does not
// model triggers a bail-out for the whole document.
const FAST_UNSAFE = /[\t\r%&*!|>'"{}[\],#?~`@\\<]|^\s*-\s*$|^---|^\.\.\./m;
const FAST_KEY = /^([A-Za-z0-9_](?:[A-Za-z0-9_. /-]*[A-Za-z0-9_./-])?):(?: (\S(?:.*\S)?))?$/;

function fastResolveScalar(text) {
  if (text === "" || text === "null" || text === "Null" || text === "NULL") return null;
  if (text === "true" || text === "True" || text === "TRUE") return true;
  if (text === "false" || text === "False" || text === "FALSE") return false;
  if (/^[-+]?[0-9]+$/.test(text)) return Number(text);
  if (/^0o[0-7]+$/.test(text)) return Number.parseInt(text.slice(2), 8);
  if (/^0x[0-9a-fA-F]+$/.test(text)) return Number.parseInt(text.slice(2), 16);
  if (/^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)(?:[eE][-+]?[0-9]+)?$/.test(text)) return Number(text);
  if (/^[-+]?\.(?:inf|Inf|INF)$/.test(text)) return text[0] === "-" ? -Infinity : Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(text)) return Number.NaN;
  return text;
}

function fastScalarOrBail(text) {
  // Values containing ":" (e.g. URLs) or leading/odd spacing are legal YAML
  // but outside the audited subset; punt to the full parser.
  if (text.includes(":") || text.startsWith(" ") || text.endsWith(" ") || text === "-" || text.startsWith("- ")) throw FAST_BAIL;
  return fastResolveScalar(text);
}

function fastIsSeqItem(content) {
  return content === "-" || (content.charCodeAt(0) === 45 && content.charCodeAt(1) === 32);
}

// state: { indents: number[], contents: string[], count, i }
function fastParseNode(state) {
  const { indents, contents } = state;
  const indent = indents[state.i];
  if (fastIsSeqItem(contents[state.i])) {
    const out = [];
    while (state.i < state.count) {
      if (indents[state.i] !== indent) break;
      const content = contents[state.i];
      if (!fastIsSeqItem(content)) break;
      state.i += 1;
      if (content === "-") {
        if (state.i < state.count && indents[state.i] > indent) out.push(fastParseNode(state));
        else throw FAST_BAIL; // "-" with no inline value and no nested block
      } else {
        // Dedupe repeated item lines (very common in large documents) so a
        // 10k-item list allocates one value, not 10k slices.
        let value = state.cache.get(content);
        if (value === undefined && !state.cache.has(content)) {
          value = fastScalarOrBail(content.slice(2).trim());
          state.cache.set(content, value);
        }
        out.push(value);
        if (state.i < state.count && indents[state.i] > indent) throw FAST_BAIL; // continuation line
      }
    }
    if (state.i < state.count && indents[state.i] > indent) throw FAST_BAIL;
    return out;
  }

  if (!FAST_KEY.test(contents[state.i])) throw FAST_BAIL;
  const out = {};
  while (state.i < state.count) {
    if (indents[state.i] !== indent) break;
    const content = contents[state.i];
    if (fastIsSeqItem(content)) break;
    const match = FAST_KEY.exec(content);
    if (!match) throw FAST_BAIL;
    const key = match[1];
    const rest = match[2];
    state.i += 1;
    if (rest === undefined) {
      if (state.i < state.count && indents[state.i] > indent) {
        out[key] = fastParseNode(state);
      } else if (state.i < state.count && indents[state.i] === indent && fastIsSeqItem(contents[state.i])) {
        out[key] = fastParseNode(state);
      } else {
        out[key] = null;
      }
    } else {
      out[key] = fastScalarOrBail(rest);
      if (state.i < state.count && indents[state.i] > indent) throw FAST_BAIL; // continuation line
    }
  }
  if (state.i < state.count && indents[state.i] > indent) throw FAST_BAIL;
  return out;
}

// After heavy fast-path churn, nudge the collector so transient line/string
// garbage does not ratchet RSS upward (the full parser fix for #26088).
let fastChurnBytes = 0;
const FAST_CHURN_GC_THRESHOLD = 1024 * 1024;

function tryFastParse(source) {
  if (typeof source !== "string" || source.length === 0) return FAST_BAIL;
  if (FAST_UNSAFE.test(source)) return FAST_BAIL;
  const indents = [];
  const contents = [];
  const length = source.length;
  let offset = 0;
  while (offset < length) {
    let end = source.indexOf("\n", offset);
    if (end === -1) end = length;
    let start = offset;
    while (start < end && source.charCodeAt(start) === 32) start += 1;
    let stop = end;
    while (stop > start && source.charCodeAt(stop - 1) === 32) stop -= 1;
    if (stop > start) {
      indents.push(start - offset);
      contents.push(source.slice(start, stop));
    }
    offset = end + 1;
  }
  if (contents.length === 0) return FAST_BAIL;
  // Only handle top-level block maps/seqs; scalar documents fall back.
  if (!(fastIsSeqItem(contents[0]) || FAST_KEY.test(contents[0]))) return FAST_BAIL;
  try {
    const state = { indents, contents, count: contents.length, i: 0, cache: new Map() };
    const value = fastParseNode(state);
    if (state.i !== state.count) return FAST_BAIL;
    fastChurnBytes += length;
    if (fastChurnBytes >= FAST_CHURN_GC_THRESHOLD) {
      fastChurnBytes = 0;
      globalThis.cottontail?.gc?.();
    }
    return { value };
  } catch (error) {
    if (error === FAST_BAIL) return FAST_BAIL;
    throw error;
  }
}
// ---------------------------------------------------------------------------

export function parse(input) {
  const source = yamlTextInput(input);
  const fast = tryFastParse(source);
  if (fast !== FAST_BAIL) return fast.value;
  try {
    if (source.includes("%")) validateDirectives(source);
    const documents = parseAllYAMLDocuments(source, parseOptions);
    if (documents.length === 0) return null;
    if (documents.length > 1) {
      return documents
        .filter((document) => !isEmptyBareDocument(document))
        .map((document) => documentToJS(document));
    }
    return documentToJS(documents[0]);
  } catch (error) {
    throw syntaxErrorFrom(error);
  }
}

function isEmptyBareDocument(document) {
  const node = document?.contents;
  return isScalar(node) && node.value === null &&
    node.range?.[0] === node.range?.[1] &&
    document.range?.[0] === document.range?.[1];
}

function propertyKeyFrom(value) {
  if (value == null) return "null";
  return String(value);
}

function mergeInto(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) target[key] = value;
  }
}

function applyMergeValue(target, value) {
  if (Array.isArray(value)) {
    for (const item of value) mergeInto(target, item);
  } else {
    mergeInto(target, value);
  }
}

function convertNode(node, anchors, cache) {
  if (node == null) return null;
  if (isAlias(node)) {
    return anchors.get(node.source) ?? null;
  }
  if (isPair(node)) {
    const out = {};
    const key = propertyKeyFrom(convertNode(node.key, anchors, cache));
    out[key] = convertNode(node.value, anchors, cache);
    return out;
  }
  if (isScalar(node)) {
    if ((node.tag === "tag:yaml.org,2002:int" || node.tag === "tag:yaml.org,2002:float") &&
      (node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE"))
    {
      const value = String(node.source ?? node.value);
      if (node.anchor) anchors.set(node.anchor, value);
      return value;
    }
    if (node.tag === "tag:yaml.org,2002:binary") {
      const value = String(node.source ?? node.value);
      if (node.anchor) anchors.set(node.anchor, value);
      return value;
    }
    if (node.anchor) anchors.set(node.anchor, node.value);
    return node.value;
  }

  if (isSeq(node)) {
    if (cache.has(node)) return cache.get(node);
    const out = [];
    cache.set(node, out);
    if (node.anchor) anchors.set(node.anchor, out);
    for (const item of node.items) out.push(convertNode(item, anchors, cache));
    return out;
  }

  if (isMap(node)) {
    if (cache.has(node)) return cache.get(node);
    const out = {};
    cache.set(node, out);
    if (node.anchor) anchors.set(node.anchor, out);
    for (const pair of node.items) {
      if (!isPair(pair)) continue;
      const key = propertyKeyFrom(convertNode(pair.key, anchors, cache));
      const value = convertNode(pair.value, anchors, cache);
      if (key === "<<") applyMergeValue(out, value);
      else out[key] = value;
    }
    return out;
  }

  return node.value ?? null;
}

function documentToJS(document) {
  if (!document) return null;
  if (document.errors?.length) throw document.errors[0];
  return convertNode(document.contents, new Map(), new WeakMap());
}

function normalizeIndent(space) {
  if (space instanceof Number) space = Number(space);
  if (space instanceof String) space = String(space);
  if (typeof space === "string") return space.slice(0, 10);
  if (typeof space === "number") {
    if (!Number.isFinite(space)) return space > 0 ? " ".repeat(10) : "";
    const width = Math.min(Math.max(Math.trunc(space), 0), 10);
    return " ".repeat(width);
  }
  return "  ";
}

function isNegativeZero(value) {
  return value === 0 && 1 / value === -Infinity;
}

function scalarNumber(value) {
  if (Number.isNaN(value)) return ".nan";
  if (value === Infinity) return ".inf";
  if (value === -Infinity) return "-.inf";
  if (isNegativeZero(value)) return "-0";
  return String(value);
}

function looksNumeric(text) {
  return /^-?(?:0|[1-9][0-9_]*)(?:\.[0-9_]+)?(?:e[-+]?[0-9_]+)?$/i.test(text) ||
    /^-?0[0-9_]+$/.test(text) ||
    /^-?\.[0-9_]+(?:e[-+]?[0-9_]+)?$/i.test(text) ||
    /^[-+]?\.inf$/i.test(text) ||
    /^\.nan$/i.test(text) ||
    /^0x[0-9a-f_]+$/i.test(text) ||
    /^0o[0-7_]+$/i.test(text);
}

function isKeyword(text) {
  return /^(?:true|false|null|Null|NULL|yes|no|on|off|y|n|~)$/i.test(text);
}

function quoteString(text) {
  let out = '"';
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const char = text[index];
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\0") out += "\\0";
    else if (char === "\x07") out += "\\a";
    else if (char === "\b") out += "\\b";
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\v") out += "\\v";
    else if (char === "\f") out += "\\f";
    else if (char === "\r") out += "\\r";
    else if (char === "\x1b") out += "\\e";
    else if (char === "\x85") out += "\\N";
    else if (char === "\xa0") out += "\\_";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

function shouldQuoteString(text, key = false) {
  if (text === "") return true;
  if (isKeyword(text) || looksNumeric(text)) return true;
  if (/^[\s]|[\s]$/.test(text)) return true;
  if (/[\0-\x1f\x7f\x85\xa0"]/.test(text)) return true;
  if (/^(?:---|\.\.\.|--|----)$/.test(text)) return true;
  if (/^[&*#?!|<>%@`-]/.test(text)) return true;
  if (/^[\[\]{}!,']/.test(text)) return true;
  if (/[,[\]{}]/.test(text)) return true;
  if (/:[ \t\r\n]/.test(text)) return true;
  if (text.endsWith(":")) return true;
  if (key && /^[?,-]$/.test(text)) return true;
  return false;
}

function scalarString(text, key = false) {
  return shouldQuoteString(text, key) ? quoteString(text) : text;
}

function cleanValue(value, seen = new WeakMap(), nested = false) {
  if (value instanceof String) return value.valueOf();
  if (value instanceof Number || value instanceof Boolean) {
    return nested ? new BoxedScalar(value.valueOf()) : value.valueOf();
  }
  if (typeof value === "bigint") throw new TypeError("YAML.stringify cannot serialize BigInt");
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined;
  if (value && typeof value === "object" && seen.has(value)) return seen.get(value);
  if (typeof URL === "function" && value instanceof URL) {
    const out = {};
    seen.set(value, out);
    return out;
  }
  if (typeof URLSearchParams === "function" && value instanceof URLSearchParams) {
    const out = {};
    seen.set(value, out);
    return out;
  }
  if (Array.isArray(value)) {
    const out = [];
    seen.set(value, out);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) continue;
      const cleaned = cleanValue(value[index], seen, true);
      if (cleaned !== undefined) out.push(cleaned);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    seen.set(value, out);
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      let item = value[key];
      if (descriptor?.get) item = value[key];
      const cleaned = cleanValue(item, seen, true);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    for (const symbol of Object.getOwnPropertySymbols(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, symbol);
      if (!descriptor?.enumerable) continue;
      const key = symbol.description ?? String(symbol).replace(/^Symbol\((.*)\)$/, "$1");
      let item = value[symbol];
      if (descriptor?.get) item = value[symbol];
      const cleaned = cleanValue(item, seen, true);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return value;
}

function isEmptyCollection(value) {
  return Array.isArray(value) ? value.length === 0 : value && typeof value === "object" && Object.keys(value).length === 0;
}

function isCollection(value) {
  return value && typeof value === "object" && !(value instanceof BoxedScalar);
}

function renderScalar(value, key = false) {
  if (value instanceof BoxedScalar) return renderScalar(value.value, key);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return scalarNumber(value);
  if (typeof value === "string") return scalarString(value, key);
  if (Array.isArray(value) && value.length === 0) return "[]";
  if (value && typeof value === "object" && Object.keys(value).length === 0) return "{}";
  return scalarString(String(value), key);
}

function countReferences(value, counts = new WeakMap(), visited = new WeakSet()) {
  if (!isCollection(value)) return counts;
  counts.set(value, (counts.get(value) ?? 0) + 1);
  if (visited.has(value)) return counts;
  visited.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  for (const child of children) countReferences(child, counts, visited);
  return counts;
}

function sanitizeAnchorBase(value) {
  const text = String(value || "value").replace(/[^A-Za-z0-9_-]/g, "");
  return text || "value";
}

function allocateAnchor(ctx, value, hint) {
  if (ctx.anchors.has(value)) return ctx.anchors.get(value);
  const numbered = String(hint).startsWith("#");
  const base = sanitizeAnchorBase(numbered ? String(hint).slice(1) : hint);
  const counterKey = numbered ? `#${base}` : base;
  let index = ctx.baseCounts.get(counterKey) ?? 0;
  let name = base;
  if (numbered || index > 0) name = `${base}${index}`;
  while (ctx.usedNames.has(name)) {
    index += 1;
    name = `${base}${index}`;
  }
  ctx.baseCounts.set(counterKey, index + 1);
  ctx.usedNames.add(name);
  ctx.anchors.set(value, name);
  return name;
}

function renderNode(value, level, indentUnit, ctx, hint = "value") {
  const indent = indentUnit.repeat(level);
  if (!isCollection(value)) return renderScalar(value);

  const needsAnchor = (ctx.counts.get(value) ?? 0) > 1;
  if (needsAnchor) {
    const anchor = allocateAnchor(ctx, value, hint);
    if (ctx.rendered.has(value)) return `${indent}*${anchor}`;
    ctx.rendered.add(value);
    const body = renderCollection(value, level, indentUnit, ctx);
    return `${indent}&${anchor}\n${body}`;
  }

  return renderCollection(value, level, indentUnit, ctx);
}

function renderCollection(value, level, indentUnit, ctx) {
  const indent = indentUnit.repeat(level);
  if (isEmptyCollection(value)) return `${indent}${renderScalar(value)}`;

  if (Array.isArray(value)) {
    const lines = [];
    for (const item of value) {
      if (isCollection(item)) {
        const child = renderNode(item, level + 1, indentUnit, ctx, "#item").split("\n");
        lines.push(`${indent}- ${child[0].trimStart()}`);
        for (const line of child.slice(1)) lines.push(line);
      } else {
        lines.push(`${indent}- ${renderScalar(item)}`);
      }
    }
    return lines.join("\n");
  }

  const lines = [];
  for (const [rawKey, item] of Object.entries(value)) {
    const key = renderScalar(rawKey, true);
    if (item instanceof BoxedScalar) {
      lines.push(`${indent}${key}: `);
      lines.push(`${indentUnit.repeat(level + 1)}${renderScalar(item)}`);
    } else if (isCollection(item)) {
      lines.push(`${indent}${key}: `);
      lines.push(renderNode(item, level + 1, indentUnit, ctx, rawKey || "#value"));
    } else {
      lines.push(`${indent}${key}: ${renderScalar(item)}`);
    }
  }
  return lines.join("\n");
}

function renderFlowNumericStringObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0) return null;
  if (!entries.every(([, item]) => typeof item === "string" && looksNumeric(item))) return null;
  return `{${entries.map(([key, item]) => `${renderScalar(key, true)}: ${renderScalar(item)}`).join(",")}}`;
}

export function stringify(value, replacer = null, space = undefined) {
  if (replacer != null) throw new TypeError("YAML.stringify does not support the replacer argument");
  const cleaned = cleanValue(value);
  if (cleaned === undefined) return undefined;
  if (space === undefined) {
    const flow = renderFlowNumericStringObject(cleaned);
    if (flow != null) return flow;
  }
  const ctx = {
    anchors: new WeakMap(),
    baseCounts: new Map(),
    counts: countReferences(cleaned),
    rendered: new WeakSet(),
    usedNames: new Set(),
  };
  if (isCollection(cleaned)) return renderNode(cleaned, 0, normalizeIndent(space), ctx, "root");
  return renderScalar(cleaned);
}

export default { parse, stringify };
