// Lazy source-map remapper for the cottontail esbuild bundle.
//
// Every entrypoint is bundled to <run-dir>/script.bundle.mjs with an external
// source map (script.bundle.mjs.map); the entry wrapper points
// globalThis.__cottontailBundleSourceMap at the map's absolute path. Error
// stacks therefore reference bundle positions. This module decodes the map's
// VLQ `mappings` on first use and rewrites `<bundlePath>:line:column`
// occurrences back to original source positions.
//
// Exports (1-based lines/columns in and out, matching stack trace text):
//   remapPosition(line, column) -> { source, line, column } | null
//   remapStackString(stack) -> stack (unchanged when no map / no match)

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < BASE64_CHARS.length; i += 1) BASE64_VALUES[BASE64_CHARS.charCodeAt(i)] = i;

let cachedMapPath;
let cachedState; // undefined = never attempted for cachedMapPath, null = load failed

function normalizePath(path) {
  const isAbsolute = path.startsWith("/");
  const parts = String(path).split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!isAbsolute) out.push("..");
    } else {
      out.push(part);
    }
  }
  return (isAbsolute ? "/" : "") + out.join("/");
}

function resolveSource(mapDir, sourceRoot, source) {
  let text = String(source);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
    if (text.startsWith("file://")) text = text.slice("file://".length);
    else return text;
  }
  if (sourceRoot) {
    const root = String(sourceRoot);
    text = root.endsWith("/") ? root + text : `${root}/${text}`;
  }
  if (text.startsWith("/")) return normalizePath(text);
  return normalizePath(`${mapDir}/${text}`);
}

// Decodes the `mappings` string into one array per generated line; each entry
// is [generatedColumn, sourceIndex, sourceLine, sourceColumn] (all 0-based),
// sorted by generatedColumn. Segments without source info are dropped.
function decodeMappings(mappings) {
  const lines = [];
  let line = [];
  let genColumn = 0;
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  const fields = [0, 0, 0, 0, 0];
  let fieldCount = 0;
  let value = 0;
  let shift = 0;

  const flushSegment = () => {
    if (fieldCount === 0) return;
    genColumn += fields[0];
    if (fieldCount >= 4) {
      sourceIndex += fields[1];
      sourceLine += fields[2];
      sourceColumn += fields[3];
      line.push([genColumn, sourceIndex, sourceLine, sourceColumn]);
    }
    fieldCount = 0;
  };

  for (let i = 0; i < mappings.length; i += 1) {
    const code = mappings.charCodeAt(i);
    if (code === 59) { // ';'
      flushSegment();
      lines.push(line);
      line = [];
      genColumn = 0;
    } else if (code === 44) { // ','
      flushSegment();
    } else {
      const digit = code < 128 ? BASE64_VALUES[code] : -1;
      if (digit === -1) throw new Error(`Invalid VLQ character at index ${i}`);
      value += (digit & 31) << shift;
      if (digit & 32) {
        shift += 5;
      } else {
        const negative = value & 1;
        value >>>= 1;
        if (fieldCount < 5) fields[fieldCount] = negative ? -value : value;
        fieldCount += 1;
        value = 0;
        shift = 0;
      }
    }
  }
  flushSegment();
  lines.push(line);
  return lines;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readMapText(mapPath) {
  const host = globalThis.cottontail;
  if (host && typeof host.readFile === "function") return host.readFile(mapPath);
  if (host && typeof host.readFileSync === "function") return host.readFileSync(mapPath);
  return null;
}

function buildState(mapPath) {
  try {
    const text = readMapText(mapPath);
    if (typeof text !== "string" || text === "") return null;
    const map = JSON.parse(text);
    if (!map || typeof map !== "object" || typeof map.mappings !== "string" || !Array.isArray(map.sources)) return null;
    const slash = mapPath.lastIndexOf("/");
    const mapDir = slash > 0 ? mapPath.slice(0, slash) : "/";
    const sources = map.sources.map((source) => resolveSource(mapDir, map.sourceRoot, source));
    const bundlePath = mapPath.endsWith(".map") ? mapPath.slice(0, -".map".length) : null;
    return {
      sources,
      lines: decodeMappings(map.mappings),
      bundlePath,
      bundleRegExp: bundlePath ? new RegExp(`${escapeRegExp(bundlePath)}:(\\d+):(\\d+)`, "g") : null,
    };
  } catch {
    return null;
  }
}

function getState() {
  const mapPath = globalThis.__cottontailBundleSourceMap;
  if (typeof mapPath !== "string" || mapPath === "") return null;
  if (cachedState !== undefined && cachedMapPath === mapPath) return cachedState;
  cachedMapPath = mapPath;
  cachedState = buildState(mapPath);
  return cachedState;
}

function lookup(state, line, column) {
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) return null;
  const segments = state.lines[line - 1];
  if (!segments || segments.length === 0) return null;
  const target = column - 1;
  let low = 0;
  let high = segments.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid][0] <= target) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (found === -1) return null;
  const [, sourceIndex, sourceLine, sourceColumn] = segments[found];
  const source = state.sources[sourceIndex];
  if (source == null) return null;
  return { source, line: sourceLine + 1, column: sourceColumn + 1 };
}

export function remapPosition(line, column) {
  const state = getState();
  if (!state) return null;
  return lookup(state, Number(line), Number(column));
}

export function remapStackString(stack) {
  if (typeof stack !== "string" || stack === "") return stack;
  // Cheap pre-check before getState(): the bundle path is the map path minus
  // ".map", so stacks that never mention the bundle can skip the expensive
  // one-time decode of the multi-megabyte source map entirely.
  const mapPath = globalThis.__cottontailBundleSourceMap;
  if (typeof mapPath !== "string" || mapPath === "") return stack;
  if (mapPath.endsWith(".map") && !stack.includes(mapPath.slice(0, -4))) return stack;
  const state = getState();
  if (!state || !state.bundleRegExp || !stack.includes(state.bundlePath)) return stack;
  state.bundleRegExp.lastIndex = 0;
  return stack.replace(state.bundleRegExp, (match, lineText, columnText) => {
    const mapped = lookup(state, Number(lineText), Number(columnText));
    return mapped ? `${mapped.source}:${mapped.line}:${mapped.column}` : match;
  });
}

export default { remapPosition, remapStackString };
