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

function buildState(mapPath, mapData, configuredBundlePath, configuredSourceRoot = undefined) {
  try {
    const text = typeof mapData === "string" ? mapData : readMapText(mapPath);
    if (typeof text !== "string" || text === "") return null;
    const map = JSON.parse(text);
    if (!map || typeof map !== "object" || typeof map.mappings !== "string" || !Array.isArray(map.sources)) return null;
    const effectiveMapPath = typeof mapPath === "string" && mapPath !== ""
      ? mapPath
      : `${configuredBundlePath || "/$bunfs/root/index.js"}.map`;
    const slash = effectiveMapPath.lastIndexOf("/");
    const mapDir = slash > 0 ? effectiveMapPath.slice(0, slash) : "/";
    const configuredRoot = configuredSourceRoot === undefined
      ? globalThis.__cottontailBundleSourceRoot
      : configuredSourceRoot;
    const sourceBase = typeof configuredRoot === "string" && configuredRoot !== "" ? configuredRoot : mapDir;
    const sources = map.sources.map((source) => resolveSource(sourceBase, map.sourceRoot, source));
    const generatedSources = map.sources.map((source) => resolveSource(mapDir, map.sourceRoot, source));
    const sourceLines = map.sources.map((_, index) => {
      const contents = Array.isArray(map.sourcesContent) ? map.sourcesContent[index] : null;
      return typeof contents === "string" ? contents.split(/\r?\n/) : null;
    });
    const bundlePath = typeof configuredBundlePath === "string" && configuredBundlePath !== ""
      ? configuredBundlePath
      : effectiveMapPath.endsWith(".map")
        ? effectiveMapPath.slice(0, -".map".length)
        : null;
    const lines = decodeMappings(map.mappings);
    const firstGeneratedLines = new Int32Array(sources.length);
    const firstExecutableGeneratedLines = new Int32Array(sources.length);
    firstGeneratedLines.fill(-1);
    firstExecutableGeneratedLines.fill(-1);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const positionsBySource = new Map();
      for (const segment of lines[lineIndex]) {
        const sourceIndex = segment[1];
        if (firstGeneratedLines[sourceIndex] === -1) firstGeneratedLines[sourceIndex] = lineIndex;
        let positions = positionsBySource.get(sourceIndex);
        if (!positions) positionsBySource.set(sourceIndex, positions = new Set());
        positions.add(`${segment[2]}:${segment[3]}`);
      }
      for (const [sourceIndex, positions] of positionsBySource) {
        // Bundler declarations and module wrappers usually carry one coarse
        // mapping. A line with multiple source positions is the first emitted
        // user statement and is the origin for Bun's originalLine metadata.
        if (positions.size > 1 && firstExecutableGeneratedLines[sourceIndex] === -1) {
          firstExecutableGeneratedLines[sourceIndex] = lineIndex;
        }
      }
    }
    return {
      sources,
      generatedSources,
      sourceLines,
      sourceLineAttempts: new Set(),
      nestedStates: new Map(),
      lines,
      firstGeneratedLines,
      firstExecutableGeneratedLines,
      bundlePath,
      bundleRegExp: bundlePath ? new RegExp(`${escapeRegExp(bundlePath)}:(\\d+):(\\d+)`, "g") : null,
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
  const sourceIndex = state.sources.findIndex(candidate => {
    const normalized = normalizePath(candidate);
    return normalized === relativeSource || normalized.endsWith(`/${relativeSource}`);
  });
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
      const lines = virtual?.originalLines ?? state.sourceLines[mapped.sourceIndex];
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
  let sourceIndex = state.sources.findIndex(candidate => normalizePath(candidate) === normalized);
  const entrySource = typeof globalThis.__filename === "string"
    ? normalizePath(globalThis.__filename)
    : null;
  if (sourceIndex < 0 && normalized === entrySource) {
    const entryParts = normalized.split("/");
    let bestIndex = -1;
    let bestSuffix = 1;
    for (let index = 0; index < state.sources.length; index += 1) {
      const candidateParts = normalizePath(state.sources[index]).split("/");
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
      const segments = state.lines[candidateLine - 1] ?? [];
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
      const segments = state.lines[line - 1] ?? [];
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

export function remapStackString(stack) {
  if (typeof stack !== "string" || stack === "") return stack;
  const mapPath = globalThis.__cottontailBundleSourceMap;
  const mapData = globalThis.__cottontailBundleSourceMapData;
  const hasMapPath = typeof mapPath === "string" && mapPath !== "";
  const hasMapData = typeof mapData === "string" && mapData !== "";
  if (!hasMapPath && !hasMapData) return remapAdjacentBundleFrames(stack);
  const state = getState();
  if (!state) return remapAdjacentBundleFrames(stack);
  let remapped = stack;
  if (state?.bundleRegExp && stack.includes(state.bundlePath)) {
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
  for (let index = 0; index < state.generatedSources.length; index += 1) {
    const generated = state.generatedSources[index];
    const original = state.sources[index];
    if (generated === original || !remapped.includes(generated)) continue;
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
      remapped = remapped.replaceAll(generated, original);
    }
  }
  remapped = remapAdjacentBundleFrames(remapped);
  const activeBundlePath = state?.bundlePath;
  return remapped
    .split("\n")
    .filter((line) => {
      if (!activeBundlePath) return true;
      const isFrame = /^\s*at\b/.test(line) || line.includes(`@${activeBundlePath}:`);
      return !(isFrame && line.includes(activeBundlePath));
    })
    .join("\n");
}

function remapAdjacentBundleFrames(stack) {
  return String(stack).replace(/((?:file:\/\/)?(?:[A-Za-z]:)?\/[^@\s()]*\/script\.bundle\.mjs):(\d+):(\d+)/g, (match, file, lineText, columnText) => {
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

export function formatUncaughtBundleError(error) {
  try {
    const stack = remapStackString(String(error?.stack ?? ""));
    if (globalThis.process?.execArgv?.includes?.("--hot")) {
      for (const frameLine of stack.split(/\r?\n/)) {
        const frame = /@(.+):(\d+):(\d+)$/.exec(frameLine) ??
          /^\s*at\s+.*?\s+\((.+):(\d+):(\d+)\)$/.exec(frameLine) ??
          /^\s*at\s+(.+):(\d+):(\d+)$/.exec(frameLine);
        if (!frame) continue;
        const header = Error.prototype.toString.call(error);
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
      const line = Number(context.line);
      const column = Number(context.column);
      if (!Number.isFinite(line) || !Number.isFinite(column)) continue;
      const start = Math.max(1, line - 5);
      const codeFrame = [];
      for (let sourceLine = start; sourceLine <= line && sourceLine <= context.lines.length; sourceLine += 1) {
        codeFrame.push(`${sourceLine} | ${context.lines[sourceLine - 1]}`);
      }
      codeFrame.push(`${" ".repeat(String(line).length + 3 + Math.max(0, column - 1))}^`);
      const label = String(error?.name ?? "Error") === "Error" ? "error" : String(error.name);
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
