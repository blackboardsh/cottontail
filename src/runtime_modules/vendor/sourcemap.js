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

function buildState(mapPath, mapData, configuredBundlePath) {
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
    const configuredRoot = globalThis.__cottontailBundleSourceRoot;
    const sourceBase = typeof configuredRoot === "string" && configuredRoot !== "" ? configuredRoot : mapDir;
    const sources = map.sources.map((source) => resolveSource(sourceBase, map.sourceRoot, source));
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
      sourceLines,
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
  const hasMapPath = typeof mapPath === "string" && mapPath !== "";
  const hasMapData = typeof mapData === "string" && mapData !== "";
  if (!hasMapPath && !hasMapData) return null;
  if (cachedState !== undefined && cachedMapPath === mapPath && cachedMapData === mapData && cachedBundlePath === bundlePath) {
    return cachedState;
  }
  cachedMapPath = mapPath;
  cachedMapData = mapData;
  cachedBundlePath = bundlePath;
  cachedState = buildState(hasMapPath ? mapPath : "", hasMapData ? mapData : null, bundlePath);
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

function virtualSourceMapping(state, sourceIndex) {
  let mappings = virtualSourceMappings.get(state);
  if (!mappings) virtualSourceMappings.set(state, mappings = new Map());
  if (mappings.has(sourceIndex)) return mappings.get(sourceIndex);

  const transformedLines = state.sourceLines[sourceIndex];
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

export function remapPosition(line, column) {
  const state = getState();
  if (!state) return null;
  const mapped = lookup(state, Number(line), Number(column));
  return mapped && { source: mapped.source, line: mapped.line, column: mapped.column };
}

export function remapErrorPosition(line, column) {
  const state = getState();
  const generatedLine = Number(line);
  const generatedColumn = Number(column);
  if (!state) return null;
  const initial = lookup(state, generatedLine, generatedColumn);
  const mapped = initial ? preferConstructedErrorCallSite(state, generatedLine, generatedColumn, initial) : null;
  if (!mapped) return null;
  const firstExecutableGeneratedLine = state.firstExecutableGeneratedLines[mapped.sourceIndex];
  const firstGeneratedLine = state.firstGeneratedLines[mapped.sourceIndex];
  const mappedGeneratedLine = mapped.generatedLine ?? generatedLine;
  return {
    source: mapped.source,
    line: mapped.line,
    column: mapped.column,
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
  if (sourceIndex < 0 || !state.sourceLines[sourceIndex]) return null;
  return {
    source: state.sources[sourceIndex],
    line: Number(line),
    column: Number(column),
    lines: state.sourceLines[sourceIndex],
  };
}

function preferConstructedErrorCallSite(state, generatedLine, generatedColumn, mapped) {
  const sourceLines = state.sourceLines[mapped.sourceIndex];
  const currentSource = sourceLines?.[mapped.line - 1] ?? "";
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
  const previousSource = sourceLines?.[previous.line - 1] ?? "";
  return previousSource.trim() === "" ? mapped : previous;
}

export function remapStackString(stack) {
  if (typeof stack !== "string" || stack === "") return stack;
  // Cheap pre-check before getState(): the bundle path is the map path minus
  // ".map", so stacks that never mention the bundle can skip the expensive
  // one-time decode of the multi-megabyte source map entirely.
  const mapPath = globalThis.__cottontailBundleSourceMap;
  const mapData = globalThis.__cottontailBundleSourceMapData;
  const configuredBundlePath = globalThis.__cottontailBundlePath;
  const hasMapPath = typeof mapPath === "string" && mapPath !== "";
  const hasMapData = typeof mapData === "string" && mapData !== "";
  if (!hasMapPath && !hasMapData) return remapAdjacentBundleFrames(stack);
  const expectedBundlePath = typeof configuredBundlePath === "string" && configuredBundlePath !== ""
    ? configuredBundlePath
    : hasMapPath && mapPath.endsWith(".map")
      ? mapPath.slice(0, -4)
      : null;
  if (expectedBundlePath && !stack.includes(expectedBundlePath) &&
      !stack.includes("/cache/") && !stack.includes("/run/")) {
    return remapAdjacentBundleFrames(stack);
  }
  const state = getState();
  let remapped = stack;
  if (state?.bundleRegExp && stack.includes(state.bundlePath)) {
    state.bundleRegExp.lastIndex = 0;
    remapped = remapped.replace(state.bundleRegExp, (match, lineText, columnText) => {
      const line = Number(lineText);
      const column = Number(columnText);
      const initial = lookup(state, line, column);
      const mapped = initial ? preferConstructedErrorCallSite(state, line, column, initial) : null;
      return mapped ? `${mapped.source}:${mapped.line}:${mapped.column}` : match;
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
    return mapped ? `${mapped.source}:${mapped.line}:${mapped.column}` : match;
  });
}

export default { remapErrorPosition, remapPosition, remapStackString, sourceContextForLocation };
