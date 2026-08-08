// Lazy source-map remapper for the Cottontail compiler bundle.
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
let cachedMapData;
let cachedBundlePath;
let cachedSourceRoot;
let cachedState; // undefined = never attempted for cachedMapPath, null = load failed
const adjacentBundleStates = new Map();
const virtualSourceMappings = new WeakMap();
const remapStackMemo = new WeakMap();

function isWindowsAbsolutePath(path) {
  return /^[A-Za-z]:[\\/]/.test(String(path)) || /^[\\/]{2}[^\\/]/.test(String(path));
}

function isAbsolutePath(path) {
  const text = String(path);
  return text.startsWith("/") || isWindowsAbsolutePath(text);
}

function normalizePath(path) {
  let text = String(path).replace(/\\/g, "/");
  let root = "";
  const drive = /^([A-Za-z]:)\//.exec(text);
  if (drive) {
    root = `${drive[1]}/`;
    text = text.slice(drive[0].length);
  } else if (text.startsWith("//")) {
    root = "//";
    text = text.slice(2);
  } else if (text.startsWith("/")) {
    root = "/";
    text = text.slice(1);
  }
  const parts = text.split("/");
  const out = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (root === "") out.push("..");
    } else {
      out.push(part);
    }
  }
  return root + out.join("/");
}

// `state.sources` never changes after buildState, but locating a frame's
// source used to re-normalize every entry on every lookup — O(sources) string
// work per stack frame, which dominates Error.prototype.stack.
const normalizedSourcesCache = new WeakMap();

function normalizedSources(state) {
  let entry = normalizedSourcesCache.get(state);
  if (entry === undefined) {
    const list = state.sources.map(candidate => normalizePath(candidate));
    const byPath = new Map();
    for (let index = 0; index < list.length; index += 1) {
      if (!byPath.has(list[index])) byPath.set(list[index], index);
    }
    entry = { list, byPath };
    normalizedSourcesCache.set(state, entry);
  }
  return entry;
}

function resolveSource(mapDir, sourceRoot, source) {
  let text = String(source);
  if (!isWindowsAbsolutePath(text) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) {
    if (text.startsWith("file://")) text = text.slice("file://".length);
    else return text;
  }
  if (sourceRoot && !isAbsolutePath(text)) {
    const root = String(sourceRoot);
    text = /[\\/]$/.test(root) ? root + text : `${root}/${text}`;
  }
  if (isAbsolutePath(text)) return normalizePath(text);
  return normalizePath(`${mapDir}/${text}`);
}

// Index cumulative VLQ state at each generated line. Materializing every
// segment as nested JavaScript arrays amplifies large bundle maps by orders of
// magnitude, while stack remapping usually reads only a handful of lines.
function indexMappings(mappings, sourceCount) {
  let lineCount = 1;
  for (let index = 0; index < mappings.length; index += 1) {
    if (mappings.charCodeAt(index) === 59) lineCount += 1;
  }

  const lineOffsets = new Uint32Array(lineCount + 1);
  const lineSourceIndices = new Int32Array(lineCount);
  const lineSourceLines = new Int32Array(lineCount);
  const lineSourceColumns = new Int32Array(lineCount);
  const firstGeneratedLines = new Int32Array(sourceCount);
  const firstExecutableGeneratedLines = new Int32Array(sourceCount);
  const seenGeneratedLines = new Int32Array(sourceCount);
  const seenSourceLines = new Int32Array(sourceCount);
  const seenSourceColumns = new Int32Array(sourceCount);
  firstGeneratedLines.fill(-1);
  firstExecutableGeneratedLines.fill(-1);
  seenGeneratedLines.fill(-1);

  let lineIndex = 0;
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
      if (sourceIndex >= 0 && sourceIndex < sourceCount) {
        if (firstGeneratedLines[sourceIndex] === -1) firstGeneratedLines[sourceIndex] = lineIndex;
        if (seenGeneratedLines[sourceIndex] !== lineIndex) {
          seenGeneratedLines[sourceIndex] = lineIndex;
          seenSourceLines[sourceIndex] = sourceLine;
          seenSourceColumns[sourceIndex] = sourceColumn;
        } else if (firstExecutableGeneratedLines[sourceIndex] === -1 &&
            (seenSourceLines[sourceIndex] !== sourceLine || seenSourceColumns[sourceIndex] !== sourceColumn)) {
          // Bundler declarations and module wrappers usually carry one coarse
          // mapping. Multiple source positions mark the first emitted statement.
          firstExecutableGeneratedLines[sourceIndex] = lineIndex;
        }
      }
    }
    fieldCount = 0;
  };

  for (let i = 0; i < mappings.length; i += 1) {
    const code = mappings.charCodeAt(i);
    if (code === 59) { // ';'
      flushSegment();
      genColumn = 0;
      lineIndex += 1;
      lineOffsets[lineIndex] = i + 1;
      if (lineIndex < lineCount) {
        lineSourceIndices[lineIndex] = sourceIndex;
        lineSourceLines[lineIndex] = sourceLine;
        lineSourceColumns[lineIndex] = sourceColumn;
      }
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
  lineOffsets[lineCount] = mappings.length;
  return {
    lineOffsets,
    lineSourceIndices,
    lineSourceLines,
    lineSourceColumns,
    firstGeneratedLines,
    firstExecutableGeneratedLines,
  };
}

function decodeLineSegments(state, lineIndex) {
  if (lineIndex < 0 || lineIndex >= state.mappingIndex.lineSourceIndices.length) return [];
  const start = state.mappingIndex.lineOffsets[lineIndex];
  const end = state.mappingIndex.lineOffsets[lineIndex + 1];
  let genColumn = 0;
  let sourceIndex = state.mappingIndex.lineSourceIndices[lineIndex];
  let sourceLine = state.mappingIndex.lineSourceLines[lineIndex];
  let sourceColumn = state.mappingIndex.lineSourceColumns[lineIndex];
  const fields = [0, 0, 0, 0, 0];
  const segments = [];
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
      segments.push([genColumn, sourceIndex, sourceLine, sourceColumn]);
    }
    fieldCount = 0;
  };

  for (let index = start; index < end; index += 1) {
    const code = state.mappings.charCodeAt(index);
    if (code === 59) {
      flushSegment();
      break;
    }
    if (code === 44) {
      flushSegment();
      continue;
    }
    const digit = code < 128 ? BASE64_VALUES[code] : -1;
    if (digit === -1) throw new Error(`Invalid VLQ character at index ${index}`);
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
  flushSegment();
  return segments;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathRegExpSource(path) {
  return String(path)
    .split(/[\\/]/)
    .map(part => escapeRegExp(part))
    .join("[\\\\/]");
}

function bundleFrameRegExp(bundlePath) {
  const flags = isWindowsAbsolutePath(bundlePath) ? "gi" : "g";
  return new RegExp(`${pathRegExpSource(bundlePath)}:(\\d+):(\\d+)`, flags);
}

function readMapText(mapPath) {
  const host = globalThis.cottontail;
  if (host && typeof host.readFile === "function") return host.readFile(mapPath);
  if (host && typeof host.readFileSync === "function") return host.readFileSync(mapPath);
  return null;
}

function skipJsonWhitespace(text, index) {
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code !== 9 && code !== 10 && code !== 13 && code !== 32) break;
    index += 1;
  }
  return index;
}

function scanJsonStringEnd(text, start) {
  if (text.charCodeAt(start) !== 34) throw new Error("Expected JSON string");
  for (let index = start + 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 34) return index + 1;
    if (code === 92) index += 1;
  }
  throw new Error("Unterminated JSON string");
}

function scanJsonValueEnd(text, start) {
  const first = text.charCodeAt(start);
  if (first === 34) return scanJsonStringEnd(text, start);
  if (first !== 91 && first !== 123) {
    let index = start;
    while (index < text.length && text.charCodeAt(index) !== 44 && text.charCodeAt(index) !== 93 &&
        text.charCodeAt(index) !== 125) index += 1;
    return index;
  }

  const nesting = [first];
  for (let index = start + 1; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 34) {
      index = scanJsonStringEnd(text, index) - 1;
      continue;
    }
    if (code === 91 || code === 123) {
      nesting.push(code);
      continue;
    }
    if (code !== 93 && code !== 125) continue;
    const opening = nesting.pop();
    if ((opening === 91 && code !== 93) || (opening === 123 && code !== 125)) {
      throw new Error("Mismatched JSON container");
    }
    if (nesting.length === 0) return index + 1;
  }
  throw new Error("Unterminated JSON container");
}

function decodeJsonString(text, start, end) {
  if (text.charCodeAt(start) !== 34 || text.charCodeAt(end - 1) !== 34) {
    throw new Error("Expected JSON string");
  }
  const firstEscape = text.indexOf("\\", start + 1);
  if (firstEscape < 0 || firstEscape >= end - 1) return text.slice(start + 1, end - 1);

  const parts = [];
  let chunkStart = start + 1;
  for (let index = firstEscape; index < end - 1; index += 1) {
    if (text.charCodeAt(index) !== 92) continue;
    parts.push(text.slice(chunkStart, index));
    index += 1;
    const escaped = text[index];
    switch (escaped) {
      case '"': parts.push('"'); break;
      case "\\": parts.push("\\"); break;
      case "/": parts.push("/"); break;
      case "b": parts.push("\b"); break;
      case "f": parts.push("\f"); break;
      case "n": parts.push("\n"); break;
      case "r": parts.push("\r"); break;
      case "t": parts.push("\t"); break;
      case "u": {
        const hex = text.slice(index + 1, index + 5);
        if (!/^[0-9A-Fa-f]{4}$/.test(hex)) throw new Error("Invalid JSON Unicode escape");
        parts.push(String.fromCharCode(Number.parseInt(hex, 16)));
        index += 4;
        break;
      }
      default: throw new Error("Invalid JSON escape");
    }
    chunkStart = index + 1;
  }
  parts.push(text.slice(chunkStart, end - 1));
  return parts.join("");
}

function indexJsonArray(text, start, end) {
  let index = skipJsonWhitespace(text, start);
  if (text.startsWith("null", index)) return null;
  if (text.charCodeAt(index) !== 91) throw new Error("Expected JSON array");
  index = skipJsonWhitespace(text, index + 1);
  const spans = [];
  while (index < end && text.charCodeAt(index) !== 93) {
    const valueStart = index;
    const valueEnd = scanJsonValueEnd(text, valueStart);
    spans.push([valueStart, valueEnd]);
    index = skipJsonWhitespace(text, valueEnd);
    if (text.charCodeAt(index) === 44) index = skipJsonWhitespace(text, index + 1);
    else if (text.charCodeAt(index) !== 93) throw new Error("Expected JSON array separator");
  }
  return spans;
}

function decodeJsonStringValue(text, span) {
  if (!span) return null;
  const start = skipJsonWhitespace(text, span[0]);
  let end = span[1];
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (text.slice(start, end) === "null") return null;
  return decodeJsonString(text, start, end);
}

function parseSourceMap(text) {
  let index = skipJsonWhitespace(text, 0);
  if (text.charCodeAt(index) !== 123) throw new Error("Expected source map object");
  index = skipJsonWhitespace(text, index + 1);
  let mappings;
  let sourceRoot;
  let sources;
  let sourceContentSpans = null;

  while (index < text.length && text.charCodeAt(index) !== 125) {
    const keyStart = index;
    const keyEnd = scanJsonStringEnd(text, keyStart);
    const key = decodeJsonString(text, keyStart, keyEnd);
    index = skipJsonWhitespace(text, keyEnd);
    if (text.charCodeAt(index) !== 58) throw new Error("Expected JSON property separator");
    const valueStart = skipJsonWhitespace(text, index + 1);
    const valueEnd = scanJsonValueEnd(text, valueStart);
    const span = [valueStart, valueEnd];
    if (key === "mappings") mappings = decodeJsonStringValue(text, span);
    else if (key === "sourceRoot") sourceRoot = decodeJsonStringValue(text, span);
    else if (key === "sources") {
      sources = indexJsonArray(text, valueStart, valueEnd)?.map(item => decodeJsonStringValue(text, item));
    } else if (key === "sourcesContent") {
      sourceContentSpans = indexJsonArray(text, valueStart, valueEnd);
    }
    index = skipJsonWhitespace(text, valueEnd);
    if (text.charCodeAt(index) === 44) index = skipJsonWhitespace(text, index + 1);
    else if (text.charCodeAt(index) !== 125) throw new Error("Expected JSON object separator");
  }
  return { mappings, sourceRoot, sources, sourceContentSpans };
}

function buildState(mapPath, mapData, configuredBundlePath, configuredSourceRoot = undefined) {
  try {
    const text = typeof mapData === "string" ? mapData : readMapText(mapPath);
    if (typeof text !== "string" || text === "") return null;
    const map = parseSourceMap(text);
    if (!map || typeof map !== "object" || typeof map.mappings !== "string" || !Array.isArray(map.sources)) return null;
    const effectiveMapPath = typeof mapPath === "string" && mapPath !== ""
      ? mapPath
      : `${configuredBundlePath || "/$bunfs/root/index.js"}.map`;
    const normalizedMapPath = normalizePath(effectiveMapPath);
    const slash = normalizedMapPath.lastIndexOf("/");
    const mapDir = slash > 0 ? normalizedMapPath.slice(0, slash) : "/";
    const configuredRoot = configuredSourceRoot === undefined
      ? globalThis.__cottontailBundleSourceRoot
      : configuredSourceRoot;
    const sourceBase = typeof configuredRoot === "string" && configuredRoot !== "" ? configuredRoot : mapDir;
    const sources = map.sources.map((source) => resolveSource(sourceBase, map.sourceRoot, source));
    const generatedSources = map.sources.map((source) => resolveSource(mapDir, map.sourceRoot, source));
    // Only sources whose generated path differs from the resolved original
    // path need rewriting in stack strings; scanning the stack once per source
    // otherwise costs O(sources) substring searches per remap. Grouping those
    // by directory lets one search per directory rule out every file under it,
    // which is what happens for essentially every stack.
    const rewritableGroups = new Map();
    for (let index = 0; index < generatedSources.length; index += 1) {
      const generated = generatedSources[index];
      if (generated === sources[index]) continue;
      const prefix = generated.slice(0, generated.lastIndexOf("/") + 1);
      const basename = generated.slice(prefix.length);
      let group = rewritableGroups.get(prefix);
      if (group === undefined) {
        group = { indices: [], byBasename: new Map(), lengths: new Set() };
        rewritableGroups.set(prefix, group);
      }
      group.indices.push(index);
      group.lengths.add(basename.length);
      const bucket = group.byBasename.get(basename);
      if (bucket) bucket.push(index);
      else group.byBasename.set(basename, [index]);
    }
    for (const group of rewritableGroups.values()) {
      group.lengths = [...group.lengths].sort((left, right) => right - left);
    }
    const sourceLines = new Array(map.sources.length);
    const bundlePath = typeof configuredBundlePath === "string" && configuredBundlePath !== ""
      ? configuredBundlePath
      : effectiveMapPath.endsWith(".map")
        ? effectiveMapPath.slice(0, -".map".length)
        : null;
    const mappingIndex = indexMappings(map.mappings, sources.length);
    return {
      sources,
      generatedSources,
      rewritableGroups,
      sourceContentText: map.sourceContentSpans ? text : null,
      sourceContentSpans: map.sourceContentSpans,
      sourceLines,
      sourceLineAttempts: new Set(),
      nestedStates: new Map(),
      mappings: map.mappings,
      mappingIndex,
      firstGeneratedLines: mappingIndex.firstGeneratedLines,
      firstExecutableGeneratedLines: mappingIndex.firstExecutableGeneratedLines,
      bundlePath,
      bundleRegExp: bundlePath ? bundleFrameRegExp(bundlePath) : null,
    };
  } catch {
    return null;
  }
}

function getState() {
  const mapPath = globalThis.__cottontailBundleSourceMap;
  const mapData = globalThis.__cottontailBundleSourceMapData;
  const bundlePath = globalThis.__cottontailBundlePath;
  const sourceRoot = globalThis.__cottontailBundleSourceRoot;
  const hasMapPath = typeof mapPath === "string" && mapPath !== "";
  const hasMapData = typeof mapData === "string" && mapData !== "";
  if (!hasMapPath && !hasMapData) return null;
  if (cachedState !== undefined && cachedMapPath === mapPath && cachedMapData === mapData &&
      cachedBundlePath === bundlePath && cachedSourceRoot === sourceRoot) {
    return cachedState;
  }
  cachedMapPath = mapPath;
  cachedMapData = mapData;
  cachedBundlePath = bundlePath;
  cachedSourceRoot = sourceRoot;
  cachedState = buildState(hasMapPath ? mapPath : "", hasMapData ? mapData : null, bundlePath, sourceRoot);
  return cachedState;
}

function getAdjacentBundleState(bundlePath) {
  if (adjacentBundleStates.has(bundlePath)) return adjacentBundleStates.get(bundlePath);
  const state = buildState(`${bundlePath}.map`, null, bundlePath);
  adjacentBundleStates.set(bundlePath, state);
  return state;
}

function decodeOriginalPath(lines) {
  const marker = lines?.[0]?.match(/^\/\*@cottontail-original-path-base64:([A-Za-z0-9+/=]+)\*\//);
  if (!marker) return null;
  try {
    if (typeof globalThis.Buffer?.from === "function") {
      return globalThis.Buffer.from(marker[1], "base64").toString("utf8");
    }
    const binary = globalThis.atob(marker[1]);
    return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch {
    return null;
  }
}

function sourceLinesForIndex(state, sourceIndex) {
  const cached = state.sourceLines[sourceIndex];
  if (Array.isArray(cached)) return cached;
  if (state.sourceLineAttempts.has(sourceIndex)) return null;
  state.sourceLineAttempts.add(sourceIndex);
  const embeddedSpan = state.sourceContentSpans?.[sourceIndex];
  const embedded = decodeJsonStringValue(state.sourceContentText, embeddedSpan);
  if (typeof embedded === "string") {
    const lines = embedded.split(/\r?\n/);
    state.sourceLines[sourceIndex] = lines;
    state.sourceContentSpans[sourceIndex] = null;
    return lines;
  }
  const source = state.sources[sourceIndex];
  if (typeof source !== "string" || source === "") return null;
  try {
    const contents = readMapText(source);
    if (typeof contents === "string") {
      const lines = contents.split(/\r?\n/);
      state.sourceLines[sourceIndex] = lines;
      return lines;
    }
  } catch {}
  return null;
}

function decodeInlineSourceMap(lines) {
  if (!Array.isArray(lines)) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const marker = "sourceMappingURL=data:application/json";
    const markerIndex = line.indexOf(marker);
    if (markerIndex < 0) continue;
    const dataUri = line.slice(markerIndex + "sourceMappingURL=".length);
    const comma = dataUri.indexOf(",");
    if (comma < 0) return null;
    try {
      const metadata = dataUri.slice(0, comma);
      const payload = dataUri.slice(comma + 1);
      if (!metadata.includes(";base64")) return decodeURIComponent(payload);
      if (typeof globalThis.Buffer?.from === "function") {
        return globalThis.Buffer.from(payload, "base64").toString("utf8");
      }
      const binary = globalThis.atob(payload);
      return new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
    } catch {
      return null;
    }
  }
  return null;
}

function nestedSourceMapState(state, sourceIndex) {
  if (state.nestedStates.has(sourceIndex)) return state.nestedStates.get(sourceIndex);
  // COTTONTAIL-COMPAT: Bun composes an inline map from build --watch with the
  // runtime bundle map before reporting the original TypeScript location.
  const source = state.sources[sourceIndex];
  const mapData = decodeInlineSourceMap(sourceLinesForIndex(state, sourceIndex));
  const nested = typeof source === "string" && mapData
    ? buildState(`${source}.map`, mapData, source)
    : null;
  state.nestedStates.set(sourceIndex, nested);
  return nested;
}

function preferNestedConstructedErrorCallSite(state, mapped) {
  const source = sourceLinesForIndex(state, mapped.sourceIndex)?.[mapped.line - 1] ?? "";
  const constructor = /\bnew\s+(?:(?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error)\b/.exec(source);
  if (!constructor) return mapped;
  const constructorColumn = constructor.index + 1;
  return mapped.column > constructorColumn ? { ...mapped, column: constructorColumn } : mapped;
}

function virtualSourceMapping(state, sourceIndex) {
  let mappings = virtualSourceMappings.get(state);
  if (!mappings) virtualSourceMappings.set(state, mappings = new Map());
  if (mappings.has(sourceIndex)) return mappings.get(sourceIndex);

  const transformedLines = sourceLinesForIndex(state, sourceIndex);
  const source = decodeOriginalPath(transformedLines);
  if (!source || !Array.isArray(transformedLines)) {
    mappings.set(sourceIndex, null);
    return null;
  }
  let originalLines;
  try {
    const originalText = readMapText(source);
    if (typeof originalText === "string") originalLines = originalText.split(/\r?\n/);
  } catch {}
  if (!Array.isArray(originalLines)) {
    mappings.set(sourceIndex, null);
    return null;
  }

  const originalLocations = new Map();
  for (let index = 0; index < originalLines.length; index += 1) {
    const text = originalLines[index].trim();
    if (text.length < 8) continue;
    const locations = originalLocations.get(text) ?? [];
    locations.push(index);
    originalLocations.set(text, locations);
  }
  const transformedCounts = new Map();
  for (const line of transformedLines) {
    const text = line.trim();
    if (text.length >= 8) transformedCounts.set(text, (transformedCounts.get(text) ?? 0) + 1);
  }
  const anchors = [];
  let lastOriginal = -1;
  for (let index = 0; index < transformedLines.length; index += 1) {
    const text = transformedLines[index].trim();
    const locations = originalLocations.get(text);
    if (transformedCounts.get(text) !== 1 || locations?.length !== 1 || locations[0] <= lastOriginal) continue;
    lastOriginal = locations[0];
    anchors.push([index, lastOriginal]);
  }
  const mapping = { source, transformedLines, originalLines, anchors };
  mappings.set(sourceIndex, mapping);
  return mapping;
}

function remapVirtualSourcePosition(mapping, line, column) {
  if (!mapping || mapping.anchors.length === 0) return null;

  let target = Math.max(0, Number(line) - 1);
  let mappedColumn = Number(column);
  for (let index = target; index >= Math.max(0, target - 1); index -= 1) {
    const constructor = /\bnew\s+((?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error)\b/.exec(
      mapping.transformedLines[index] ?? "",
    );
    if (!constructor) continue;
    target = index;
    mappedColumn = constructor.index + constructor[0].lastIndexOf(constructor[1]) + 1;
    break;
  }
  for (let index = target; index >= Math.max(0, target - 2); index -= 1) {
    if (!/\brequire\s*\(/.test(mapping.transformedLines[index] ?? "")) continue;
    const tryIndex = index - 1;
    const tryLine = mapping.transformedLines[tryIndex] ?? "";
    const brace = /^\s*try\s*\{/.test(tryLine) ? tryLine.indexOf("{") : -1;
    if (brace >= 0) {
      target = tryIndex;
      mappedColumn = brace + 1;
    }
    break;
  }
  let best = mapping.anchors[0];
  let bestDistance = Math.abs(best[0] - target);
  for (const anchor of mapping.anchors) {
    const distance = Math.abs(anchor[0] - target);
    if (distance > bestDistance && anchor[0] > target) break;
    if (distance <= bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  const mappedLine = Math.max(0, Math.min(mapping.originalLines.length - 1, target + best[1] - best[0]));
  return { source: mapping.source, line: mappedLine + 1, column: mappedColumn };
}

function finalizeMappedPosition(state, mapped, visited = new Set()) {
  if (!mapped || mapped.sourceIndex == null) return mapped;
  const nested = nestedSourceMapState(state, mapped.sourceIndex);
  if (nested && !visited.has(nested)) {
    visited.add(state);
    const initial = lookup(nested, mapped.line, mapped.column);
    const preferred = initial
      ? preferConstructedErrorCallSite(nested, mapped.line, mapped.column, initial)
      : null;
    const nestedMapped = preferred ? preferNestedConstructedErrorCallSite(nested, preferred) : null;
    if (nestedMapped) return finalizeMappedPosition(nested, nestedMapped, visited);
  }

  const virtual = virtualSourceMapping(state, mapped.sourceIndex);
  return remapVirtualSourcePosition(virtual, mapped.line, mapped.column) ?? mapped;
}

function remapVirtualSourceFrame(state, file, line, column) {
  const cacheMarker = "/cache/";
  const cacheIndex = file.lastIndexOf(cacheMarker);
  const runMatch = /\/run\/[0-9a-f]+\/(.+)$/.exec(file);
  const relativeSource = cacheIndex >= 0
    ? normalizePath(file.slice(cacheIndex + cacheMarker.length))
    : runMatch ? normalizePath(runMatch[1]) : null;
  if (!relativeSource) return null;
  const entrySource = typeof globalThis.__filename === "string"
    ? normalizePath(globalThis.__filename)
    : null;
  const matchesEntry = entrySource &&
    (entrySource === relativeSource || entrySource.endsWith(`/${relativeSource}`));
  const sourceIndex = normalizedSources(state).list.findIndex(normalized =>
    normalized === relativeSource || normalized.endsWith(`/${relativeSource}`));
  const mapping = sourceIndex < 0 ? null : virtualSourceMapping(state, sourceIndex);
  if (!mapping || mapping.anchors.length === 0) {
    return matchesEntry
      ? { source: entrySource, line: Number(line), column: Number(column) }
      : null;
  }
  return remapVirtualSourcePosition(mapping, line, column);
}

function lookup(state, line, column) {
  if (!Number.isFinite(line) || !Number.isFinite(column) || line < 1 || column < 1) return null;
  const segments = decodeLineSegments(state, line - 1);
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
  return { source, line: sourceLine + 1, column: sourceColumn + 1, sourceIndex, generatedLine: line };
}

export function createSourceMapConsumer(mapData, options = {}) {
  const mapPath = typeof options.mapPath === "string" ? options.mapPath : "";
  const bundlePath = typeof options.bundlePath === "string" ? options.bundlePath : "";
  const sourceRoot = typeof options.sourceRoot === "string" ? options.sourceRoot : undefined;
  const state = buildState(mapPath, mapData, bundlePath, sourceRoot);
  if (!state) return null;

  return Object.freeze({
    originalPositionFor(line, column) {
      const mapped = lookup(state, Number(line), Number(column));
      if (!mapped) return null;
      const display = finalizeMappedPosition(state, mapped);
      if (!display) return null;
      const virtual = virtualSourceMapping(state, mapped.sourceIndex);
      const lines = virtual?.originalLines ?? sourceLinesForIndex(state, mapped.sourceIndex);
      return {
        source: display.source,
        line: display.line,
        column: display.column,
        lines: Array.isArray(lines) ? lines : null,
      };
    },
  });
}

export function remapPosition(line, column) {
  const state = getState();
  if (!state) return null;
  const mapped = lookup(state, Number(line), Number(column));
  const display = finalizeMappedPosition(state, mapped);
  return display && { source: display.source, line: display.line, column: display.column };
}

export function remapErrorPosition(line, column) {
  const state = getState();
  const generatedLine = Number(line);
  const generatedColumn = Number(column);
  if (!state) return null;
  const initial = lookup(state, generatedLine, generatedColumn);
  const mapped = initial ? preferConstructedErrorCallSite(state, generatedLine, generatedColumn, initial) : null;
  if (!mapped) return null;
  const display = finalizeMappedPosition(state, mapped);
  const firstExecutableGeneratedLine = state.firstExecutableGeneratedLines[mapped.sourceIndex];
  const firstGeneratedLine = state.firstGeneratedLines[mapped.sourceIndex];
  const mappedGeneratedLine = mapped.generatedLine ?? generatedLine;
  return {
    source: display.source,
    line: display.line,
    column: display.column,
    originalLine: firstExecutableGeneratedLine >= 0
      ? mappedGeneratedLine - firstExecutableGeneratedLine
      : firstGeneratedLine >= 0
        ? mappedGeneratedLine - firstGeneratedLine
        : mappedGeneratedLine,
    originalColumn: generatedColumn,
  };
}

export function sourceContextForLocation(source, line, column) {
  const state = getState();
  if (!state || typeof source !== "string") return null;
  const normalized = normalizePath(source.startsWith("file://") ? source.slice("file://".length) : source);
  const normalizedList = normalizedSources(state);
  let sourceIndex = normalizedList.byPath.get(normalized) ?? -1;
  const entrySource = typeof globalThis.__filename === "string"
    ? normalizePath(globalThis.__filename)
    : null;
  if (sourceIndex < 0 && normalized === entrySource) {
    const entryParts = normalized.split("/");
    let bestIndex = -1;
    let bestSuffix = 1;
    for (let index = 0; index < state.sources.length; index += 1) {
      const candidateParts = normalizedList.list[index].split("/");
      let suffix = 0;
      while (suffix < entryParts.length && suffix < candidateParts.length &&
          entryParts[entryParts.length - suffix - 1] === candidateParts[candidateParts.length - suffix - 1]) {
        suffix += 1;
      }
      if (suffix > bestSuffix) {
        bestSuffix = suffix;
        bestIndex = index;
      }
    }
    sourceIndex = bestIndex;
  }
  const sourceLines = sourceIndex < 0 ? null : sourceLinesForIndex(state, sourceIndex);
  if (sourceIndex < 0 || !sourceLines) return null;
  const virtual = virtualSourceMapping(state, sourceIndex);
  return {
    source: virtual?.source ?? state.sources[sourceIndex],
    line: Number(line),
    column: Number(column),
    lines: virtual?.originalLines ?? sourceLines,
  };
}

function preferConstructedErrorCallSite(state, generatedLine, generatedColumn, mapped) {
  const sourceLines = sourceLinesForIndex(state, mapped.sourceIndex);
  const currentSource = sourceLines?.[mapped.line - 1] ?? "";
  const currentConstructor = /\bnew\s+((?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error)\b/.exec(currentSource);
  if (currentConstructor) {
    const constructorColumn = currentConstructor.index + currentConstructor[0].lastIndexOf(currentConstructor[1]);
    if (mapped.column > constructorColumn + 1) {
      return { ...mapped, column: constructorColumn + 1 };
    }
  }
  const previousSource = sourceLines?.[mapped.line - 2] ?? "";
  if (/^\s*(?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error\s*\(/.test(currentSource) &&
      /\bnew\s*$/.test(previousSource)) {
    const target = generatedColumn - 1;
    for (let candidateLine = generatedLine; candidateLine >= Math.max(1, generatedLine - 1); candidateLine -= 1) {
      const segments = decodeLineSegments(state, candidateLine - 1);
      for (let index = segments.length - 1; index >= 0; index -= 1) {
        const [generatedSegmentColumn, sourceIndex, sourceLine, sourceColumn] = segments[index];
        if (candidateLine === generatedLine && generatedSegmentColumn > target) continue;
        if (sourceIndex !== mapped.sourceIndex || sourceLine !== mapped.line - 2) continue;
        if (!/^new\b/.test(previousSource.slice(sourceColumn))) continue;
        return {
          source: state.sources[sourceIndex],
          line: sourceLine + 1,
          column: sourceColumn + 1,
          sourceIndex,
          generatedLine: candidateLine,
        };
      }
    }
  }
  if (/\.stack\b/.test(currentSource)) {
    for (let line = generatedLine - 1; line >= Math.max(1, generatedLine - 8); line -= 1) {
      const segments = decodeLineSegments(state, line - 1);
      for (const segment of segments) {
        const [, sourceIndex, sourceLine, sourceColumn] = segment;
        if (sourceIndex !== mapped.sourceIndex) continue;
        const text = sourceLines?.[sourceLine] ?? "";
        const constructor = /\bnew\s+((?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error)\b/.exec(text);
        if (!constructor) continue;
        const constructorColumn = constructor.index + constructor[0].lastIndexOf(constructor[1]);
        if (sourceColumn !== constructorColumn) continue;
        return {
          source: state.sources[sourceIndex],
          line: sourceLine + 1,
          column: sourceColumn + 1,
          sourceIndex,
          generatedLine: line,
        };
      }
    }
  }
  if (!/^\s*[}\])]+(?:\s*,[^;]*)?;?\s*$/.test(currentSource)) return mapped;
  const previous = lookup(state, generatedLine - 1, generatedColumn);
  if (!previous || previous.sourceIndex !== mapped.sourceIndex || previous.line >= mapped.line) return mapped;
  const previousMappedSource = sourceLines?.[previous.line - 1] ?? "";
  return previousMappedSource.trim() === "" ? mapped : previous;
}

const EMPTY_INDICES = [];

// Indices of rewritable sources whose generated path could possibly occur in
// `text`, in ascending order (matching the order a full scan would visit).
function rewritableCandidates(state, text) {
  const groups = state.rewritableGroups;
  if (groups.size === 0) return EMPTY_INDICES;
  let candidates = null;
  const add = (indices) => {
    if (candidates === null) candidates = new Set();
    for (const index of indices) candidates.add(index);
  };
  for (const [prefix, group] of groups) {
    if (prefix === "") {
      add(group.indices);
      continue;
    }
    // Every occurrence of a generated path starts with an occurrence of its
    // directory prefix, so only the text right after each such occurrence can
    // name one of the group's files.
    for (let at = text.indexOf(prefix); at >= 0; at = text.indexOf(prefix, at + 1)) {
      const start = at + prefix.length;
      for (const length of group.lengths) {
        if (start + length > text.length) continue;
        const bucket = group.byBasename.get(text.slice(start, start + length));
        if (bucket) add(bucket);
      }
    }
  }
  if (candidates === null) return EMPTY_INDICES;
  return [...candidates].sort((left, right) => left - right);
}

export function remapStackString(stack) {
  if (typeof stack !== "string" || stack === "") return stack;
  const mapPath = globalThis.__cottontailBundleSourceMap;
  const mapData = globalThis.__cottontailBundleSourceMapData;
  const hasMapPath = typeof mapPath === "string" && mapPath !== "";
  const hasMapData = typeof mapData === "string" && mapData !== "";
  if (!hasMapPath && !hasMapData) return remapAdjacentBundleFrames(stack);
  const state = getState();
  if (!state) return remapAdjacentBundleFrames(stack);
  // Remapping is a pure function of the stack text, the (cached) map state and
  // the entry filename, and identical stacks recur constantly — loops, retried
  // assertions, repeated `new Error()` at one site.
  const entryFilename = typeof globalThis.__filename === "string" ? globalThis.__filename : null;
  let memo = remapStackMemo.get(state);
  if (memo === undefined) remapStackMemo.set(state, memo = { entryFilename, entries: new Map() });
  if (memo.entryFilename !== entryFilename) {
    memo.entryFilename = entryFilename;
    memo.entries.clear();
  }
  const memoized = memo.entries.get(stack);
  if (memoized !== undefined) return memoized;
  let remapped = stack;
  if (state?.bundleRegExp) {
    state.bundleRegExp.lastIndex = 0;
    remapped = remapped.replace(state.bundleRegExp, (match, lineText, columnText) => {
      const line = Number(lineText);
      const column = Number(columnText);
      const initial = lookup(state, line, column);
      const mapped = initial ? preferConstructedErrorCallSite(state, line, column, initial) : null;
      const display = finalizeMappedPosition(state, mapped);
      return display ? `${display.source}:${display.line}:${display.column}` : match;
    });
  }
  if (state && (remapped.includes("/cache/") || remapped.includes("/run/"))) {
    remapped = remapped.replace(
      /((?:file:\/\/)?(?:[A-Za-z]:)?\/[^@\s()]*(?:\/cache\/|\/run\/[0-9a-f]+\/)[^@\s()]*):(\d+):(\d+)/g,
      (match, file, lineText, columnText) => {
        const mapped = remapVirtualSourceFrame(state, file, Number(lineText), Number(columnText));
        return mapped ? `${mapped.source}:${mapped.line}:${mapped.column}` : match;
      },
    );
  }
  for (const index of rewritableCandidates(state, remapped)) {
    const generated = state.generatedSources[index];
    const original = state.sources[index];
    if (!remapped.includes(generated)) continue;
    const virtual = virtualSourceMapping(state, index);
    if (virtual) {
      const sourcePattern = escapeRegExp(generated);
      remapped = remapped.replace(
        new RegExp(`((?:file:\\/\\/)?)${sourcePattern}:(\\d+):(\\d+)`, "g"),
        (match, fileScheme, lineText, columnText) => {
          const mapped = remapVirtualSourcePosition(virtual, Number(lineText), Number(columnText));
          return mapped ? `${fileScheme}${mapped.source}:${mapped.line}:${mapped.column}` : match;
        },
      );
    } else {
      // A generated path is only a frame when it starts at a path boundary and
      // carries a position. Replacing it as a bare substring corrupts frames
      // that already name the original file: for sources outside the bundle
      // directory the generated path walks past the filesystem root, leaving a
      // suffix of the original path that then gets the original prefixed onto
      // it once per remap.
      remapped = remapped.replace(
        new RegExp(`(^|[\\s(@]|file:\\/\\/)${escapeRegExp(generated)}(?=:\\d+:\\d+)`, "gm"),
        (match, prefix) => `${prefix}${original}`,
      );
    }
  }
  remapped = remapAdjacentBundleFrames(remapped);
  const activeBundlePath = state?.bundlePath;
  const result = remapped
    .split("\n")
    .filter((line) => {
      if (!activeBundlePath) return true;
      const isFrame = /^\s*at\b/.test(line) || line.includes(`@${activeBundlePath}:`);
      return !(isFrame && line.includes(activeBundlePath));
    })
    .join("\n");
  if (memo.entries.size >= 512) memo.entries.clear();
  memo.entries.set(stack, result);
  return result;
}

function remapAdjacentBundleFrames(stack) {
  return String(stack).replace(/((?:file:\/\/)?(?:[A-Za-z]:)?[\\/][^@\s()]*[\\/]script\.bundle\.mjs):(\d+):(\d+)/gi, (match, file, lineText, columnText) => {
    const state = getAdjacentBundleState(file);
    if (!state) return match;
    const line = Number(lineText);
    const column = Number(columnText);
    const initial = lookup(state, line, column);
    const mapped = initial ? preferConstructedErrorCallSite(state, line, column, initial) : null;
    const display = finalizeMappedPosition(state, mapped);
    return display ? `${display.source}:${display.line}:${display.column}` : match;
  });
}

const FRAME_KEYWORDS = new Set([
  "abstract", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "debugger", "default", "delete", "do", "else", "enum", "export",
  "extends", "false", "finally", "for", "from", "function", "get", "if",
  "implements", "import", "in", "instanceof", "interface", "let", "new", "null",
  "of", "package", "private", "protected", "public", "return", "set", "static",
  "super", "switch", "this", "throw", "true", "try", "typeof", "undefined",
  "var", "void", "while", "with", "yield",
]);

// Colorize a single source line for the uncaught-error code frame, mirroring
// Bun's highlighted frame under FORCE_COLOR. This is best-effort: it never
// throws and falls back to the raw text. Beyond cosmetics, inserting escapes
// between tokens (e.g. `JSON` / `.stringify`) matches Bun's observable output,
// which tools depend on when scanning highlighted frames.
function highlightFrameLine(text) {
  const RESET = "\x1b[0m";
  const KEYWORD = "\x1b[35m";
  const STRING = "\x1b[32m";
  const NUMBER = "\x1b[33m";
  const COMMENT = "\x1b[2m";
  const PROPERTY = "\x1b[36m";
  const isIdentStart = (c) => c === "_" || c === "$" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
  const isIdentPart = (c) => isIdentStart(c) || (c >= "0" && c <= "9");
  const isDigit = (c) => c >= "0" && c <= "9";
  try {
    let out = "";
    let i = 0;
    let lastSignificant = "";
    const n = text.length;
    while (i < n) {
      const c = text[i];
      // Comments
      if (c === "/" && text[i + 1] === "/") {
        out += COMMENT + text.slice(i) + RESET;
        break;
      }
      if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        out += COMMENT + text.slice(i, stop) + RESET;
        i = stop;
        continue;
      }
      // Strings and template literals
      if (c === '"' || c === "'" || c === "`") {
        const quote = c;
        let j = i + 1;
        let segment = c;
        while (j < n) {
          const cj = text[j];
          if (cj === "\\") { segment += cj + (text[j + 1] ?? ""); j += 2; continue; }
          if (quote === "`" && cj === "$" && text[j + 1] === "{") {
            // Close the string run, highlight the interpolated expression,
            // then resume the template string after the matching brace.
            out += STRING + segment + RESET;
            let depth = 1;
            let k = j + 2;
            while (k < n && depth > 0) {
              if (text[k] === "{") depth += 1;
              else if (text[k] === "}") depth -= 1;
              if (depth === 0) break;
              k += 1;
            }
            out += "${" + highlightFrameLine(text.slice(j + 2, k)) + (k < n ? "}" : "");
            j = k + 1;
            segment = "";
            continue;
          }
          segment += cj;
          if (cj === quote) { j += 1; break; }
          j += 1;
        }
        out += STRING + segment + RESET;
        i = j;
        lastSignificant = quote;
        continue;
      }
      // Numbers
      if (isDigit(c) || (c === "." && isDigit(text[i + 1]) && lastSignificant !== ")" && !isIdentPart(lastSignificant))) {
        let j = i;
        while (j < n && (isIdentPart(text[j]) || text[j] === "." )) j += 1;
        out += NUMBER + text.slice(i, j) + RESET;
        i = j;
        lastSignificant = text[j - 1];
        continue;
      }
      // Identifiers / keywords / properties
      if (isIdentStart(c)) {
        let j = i;
        while (j < n && isIdentPart(text[j])) j += 1;
        const word = text.slice(i, j);
        if (FRAME_KEYWORDS.has(word)) {
          out += KEYWORD + word + RESET;
        } else if (lastSignificant === ".") {
          out += PROPERTY + word + RESET;
        } else {
          out += word;
        }
        i = j;
        lastSignificant = word[word.length - 1];
        continue;
      }
      out += c;
      if (c !== " " && c !== "\t") lastSignificant = c;
      i += 1;
    }
    return out;
  } catch {
    return text;
  }
}

function frameColorsEnabled() {
  const env = globalThis.process?.env;
  if (env?.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0";
  if (env?.NO_COLOR !== undefined || env?.NODE_DISABLE_COLORS !== undefined) return false;
  return Boolean(globalThis.process?.stderr?.isTTY);
}

export function formatUncaughtBundleError(error) {
  try {
    const stack = remapStackString(String(error?.stack ?? ""));
    if (globalThis.process?.execArgv?.includes?.("--hot")) {
      for (const frameLine of stack.split(/\r?\n/)) {
        const frame = /@(.+):(\d+):(\d+)$/.exec(frameLine) ??
          /^\s*at\s+.*?\s+\((.+):(\d+):(\d+)\)$/.exec(frameLine) ??
          /^\s*at\s+(.+):(\d+):(\d+)$/.exec(frameLine);
        if (!frame) continue;
        const header = error?.name === "AssertionError" && error?.code === "ERR_ASSERTION"
          ? `AssertionError [ERR_ASSERTION]: ${error.message}`
          : Error.prototype.toString.call(error);
        error.stack = `${header}\n    at ${frame[1]}:${frame[2]}:${frame[3]}`;
        Object.defineProperty(error, "__cottontailFormattedStack", { value: true, configurable: true });
        return true;
      }
    }
    for (const frameLine of stack.split(/\r?\n/)) {
      const frame = /@(.+):(\d+):(\d+)$/.exec(frameLine) ??
        /^\s*at\s+.*?\s+\((.+):(\d+):(\d+)\)$/.exec(frameLine) ??
        /^\s*at\s+(.+):(\d+):(\d+)$/.exec(frameLine);
      if (!frame) continue;
      const context = sourceContextForLocation(frame[1], Number(frame[2]), Number(frame[3]));
      if (!context || !Array.isArray(context.lines)) continue;
      let line = Number(context.line);
      let column = Number(context.column);
      if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
      // Anchor the code frame on the site where the Error was constructed, the
      // way Bun does (its `error.stack[0]` is the `new Error(...)` call). When a
      // multi-line construction spans several source lines, the frame position
      // cottontail records can land on a later line (e.g. the following `throw`
      // or a closing `)}`), producing a wide window that spills the tail of the
      // construction. If the anchored line does not already name the
      // construction but a nearby preceding line does, re-anchor to it.
      const anchoredLine = context.lines[line - 1] ?? "";
      const errorCtor = String(error?.name ?? "Error").replace(/[^A-Za-z0-9_$]/g, "");
      const ctorPattern = new RegExp(`\\bnew\\s+(${errorCtor}|(?:Aggregate|Eval|Range|Reference|Syntax|Type|URI)?Error)\\b`);
      if (errorCtor && !ctorPattern.test(anchoredLine)) {
        for (let candidate = line; candidate >= Math.max(1, line - 6); candidate -= 1) {
          const text = context.lines[candidate - 1] ?? "";
          const match = ctorPattern.exec(text);
          if (match) {
            line = candidate;
            column = match.index + match[0].lastIndexOf(match[1]) + 1;
            break;
          }
        }
      }
      const start = Math.max(1, line - 5);
      const codeFrame = [];
      const colorize = frameColorsEnabled();
      for (let sourceLine = start; sourceLine <= line && sourceLine <= context.lines.length; sourceLine += 1) {
        const raw = context.lines[sourceLine - 1] ?? "";
        codeFrame.push(`${sourceLine} | ${colorize ? highlightFrameLine(raw) : raw}`);
      }
      codeFrame.push(`${" ".repeat(String(line).length + 3 + Math.max(0, column - 1))}^`);
      const errorName = String(error?.name ?? "Error");
      const label = errorName === "Error"
        ? "error"
        : errorName === "AssertionError" && error?.code === "ERR_ASSERTION"
          ? "AssertionError [ERR_ASSERTION]"
          : errorName;
      codeFrame.push(`${label}: ${String(error?.message ?? "")}`);
      codeFrame.push(`    at ${context.source}:${line}:${column}`);
      error.stack = codeFrame.join("\n");
      Object.defineProperty(error, "__cottontailFormattedStack", { value: true, configurable: true });
      return true;
    }
  } catch {}
  return false;
}

globalThis.__cottontailFormatUncaughtBundleError ??= formatUncaughtBundleError;
globalThis.__cottontailFormatUncaughtModuleError ??= formatUncaughtBundleError;

export default {
  createSourceMapConsumer,
  formatUncaughtBundleError,
  remapErrorPosition,
  remapPosition,
  remapStackString,
  sourceContextForLocation,
};
