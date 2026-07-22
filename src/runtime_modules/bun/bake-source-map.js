import path from "../node/path.js";
import { mkdirSync, statSync, writeFileSync } from "../node/fs.js";
import { fileURLToPath, pathToFileURL } from "../node/url.js";

// This module owns Bake map URLs and generated-code ranges. The native binding
// performs all source-map parsing and mapping emission with Bun's compiler.
const runtimeSource = Object.freeze({
  content: "// (Bun's internal HMR runtime is minified)",
  path: "bun://Bun/Bun HMR Runtime",
});

function isUrl(value) {
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function existingFile(candidates) {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return path.normalize(candidate);
    } catch {}
  }
  return null;
}

function sourceRootPath(sourceRoot) {
  if (!sourceRoot) return "";
  if (sourceRoot.startsWith("file:")) {
    try {
      return fileURLToPath(sourceRoot);
    } catch {
      return "";
    }
  }
  return isUrl(sourceRoot) ? "" : sourceRoot;
}

function resolveSourcePath(source, sourceRoot, projectRoot, mapPath) {
  const value = String(source ?? "");
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value);
    } catch {
      return value;
    }
  }
  if (isUrl(value)) return value;
  if (path.isAbsolute(value)) return path.normalize(value);
  const root = sourceRootPath(sourceRoot);
  const candidates = [
    path.resolve(projectRoot, root, value),
    path.resolve(path.dirname(mapPath || projectRoot), root, value),
  ];
  return existingFile(candidates) ?? candidates[0];
}

function nativePath(value) {
  if (!String(value).startsWith("file:")) return path.isAbsolute(value) ? path.normalize(value) : String(value);
  try {
    return path.normalize(fileURLToPath(value));
  } catch {
    return String(value);
  }
}

function displayPath(value, side) {
  return side === "client" && path.isAbsolute(value) ? pathToFileURL(value).href : value;
}

function positionAt(source, offset) {
  let line = 0;
  let lineStart = 0;
  for (let index = 0; index < offset; index += 1) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart };
}

function relocate(inputs, addRuntimeMapping) {
  const binding = globalThis.cottontail?.bakeSourceMapRelocate;
  if (typeof binding !== "function") {
    throw new Error("Cottontail runtime is missing the native Bake source-map binding");
  }
  return JSON.parse(binding(JSON.stringify({ inputs, addRuntimeMapping }))).mappings;
}

function outputMap(records, sources, inputs, side) {
  const payload = {
    version: 3,
    sources: sources.map(source => displayPath(source.path, side)),
    sourcesContent: sources.map(source => source.content),
    names: [],
    mappings: relocate(inputs, true),
  };
  const debugId = records.find(record => record?.debugId)?.debugId;
  if (debugId) payload.debugId = debugId;
  return payload;
}

function appendSource(sources, indexes, source) {
  let index = indexes.get(source.path);
  if (index !== undefined) return index;
  index = sources.length;
  indexes.set(source.path, index);
  sources.push(source);
  return index;
}

export function createBakeSourceMapRecord(generatedSource, mapData, options = {}) {
  const payload = typeof mapData === "string" ? JSON.parse(mapData) : mapData;
  const projectRoot = path.resolve(options.projectRoot ?? globalThis.process?.cwd?.() ?? ".");
  const mapPath = path.resolve(options.mapPath ?? projectRoot);
  const rawSources = Array.isArray(payload.sources) ? payload.sources : [];
  const rawContents = Array.isArray(payload.sourcesContent) ? payload.sourcesContent : [];
  return {
    debugId: payload.debugId,
    generatedSource: String(generatedSource),
    mappings: String(payload.mappings ?? ""),
    projectRoot,
    sources: rawSources.map((source, index) => ({
      content: typeof rawContents[index] === "string" ? rawContents[index] : "",
      path: resolveSourcePath(source, String(payload.sourceRoot ?? ""), projectRoot, mapPath),
    })),
  };
}

export function normalizeBakeClientSourceMap(record, options = {}) {
  const sources = [runtimeSource];
  const indexes = new Map([[runtimeSource.path, 0]]);
  for (const value of options.leadingSources ?? []) {
    appendSource(sources, indexes, { content: "", path: path.resolve(record.projectRoot, value) });
  }
  for (const value of options.preferredSources ?? []) {
    const target = nativePath(path.resolve(record.projectRoot, value));
    const source = record.sources.find(candidate => nativePath(candidate.path) === target);
    if (source) appendSource(sources, indexes, source);
  }
  for (const source of record.sources) appendSource(sources, indexes, source);
  const sourceRemap = record.sources.map(source => indexes.get(source.path) ?? -1);
  return outputMap([record], sources, [{
    mappings: record.mappings,
    sourceCount: record.sources.length,
    sourceRemap,
  }], "client");
}

function locateFragment(fragment, cursor) {
  const record = fragment.record;
  const registryStart = record.generatedSource.indexOf("\n  // ", 8);
  const moduleAnchor = fragment.moduleId
    ? record.generatedSource.indexOf(JSON.stringify(fragment.moduleId), Math.max(0, registryStart))
    : -1;
  const searchFrom = Math.max(cursor, moduleAnchor, registryStart, 0);
  let start = record.generatedSource.indexOf(fragment.originalText, searchFrom);
  if (start < 0) start = record.generatedSource.indexOf(fragment.originalText);
  if (start < 0) return null;
  return {
    end: start + fragment.originalText.length,
    start: start + Number(fragment.originalOffset ?? 0),
  };
}

export function composeBakeClientHotUpdateSourceMap(outputSource, fragments) {
  const sources = [runtimeSource];
  const indexes = new Map([[runtimeSource.path, 0]]);
  const groups = new Map();
  for (const fragment of fragments) {
    if (!fragment.record) continue;
    let group = groups.get(fragment.record);
    if (!group) groups.set(fragment.record, group = { cursors: new Map(), fragments: [], modules: new Set() });
    const moduleId = String(fragment.moduleId ?? "");
    const located = locateFragment(fragment, group.cursors.get(moduleId) ?? 0);
    if (!located) continue;
    group.cursors.set(moduleId, located.end);
    group.modules.add(moduleId);
    const inputStart = positionAt(fragment.record.generatedSource, located.start);
    const inputEnd = positionAt(fragment.record.generatedSource, located.start + fragment.length);
    const outputStart = positionAt(outputSource, fragment.outputStart);
    group.fragments.push({
      inputStartLine: inputStart.line,
      inputStartColumn: inputStart.column,
      inputEndLine: inputEnd.line,
      inputEndColumn: inputEnd.column,
      outputStartLine: outputStart.line,
      outputStartColumn: outputStart.column,
    });
  }

  const inputs = [];
  for (const [record, group] of groups) {
    const modulePaths = [...group.modules]
      .filter(Boolean)
      .map(moduleId => nativePath(path.resolve(record.projectRoot, moduleId)));
    const selected = record.sources.map(source =>
      modulePaths.includes(nativePath(source.path)) ? appendSource(sources, indexes, source) : -1
    );
    inputs.push({
      mappings: record.mappings,
      sourceCount: record.sources.length,
      sourceRemap: selected,
      fragments: group.fragments,
    });
  }
  return outputMap([...groups.keys()], sources, inputs, "client");
}

export function registerBakeServerPatch(source, record, patchId) {
  const registryStart = source.indexOf("\n  // ", 8);
  if (registryStart < 0) throw new SyntaxError("Bake's HMR bundle is missing its module registry");
  const registrySource = source.slice(registryStart);
  const invocationEnd = registrySource.lastIndexOf(");");
  if (invocationEnd < 0) throw new SyntaxError("Bake's HMR bundle is missing its invocation trailer");

  const directory = path.join(record.projectRoot, ".cottontail-tmp", "bake-server-patches");
  const safeId = String(patchId).replace(/[^A-Za-z0-9_-]/g, "_");
  const filename = path.join(directory, `patch-${safeId}.cjs`);
  const mapName = `${path.basename(filename)}.map`;
  const prefix = "module.exports = ((Error) => [{";
  const errorConstructor = "globalThis.Error.__cottontailStackHeader" +
    " ? Object.getPrototypeOf(globalThis.Error) : globalThis.Error";
  const patchSource = `${prefix}${registrySource.slice(0, invocationEnd)}])(${errorConstructor});\n` +
    `//# sourceMappingURL=${mapName}\n`;
  const inputStart = positionAt(source, registryStart);
  const inputEnd = positionAt(source, registryStart + invocationEnd);
  const outputStart = positionAt(patchSource, prefix.length);
  const sources = [runtimeSource, ...record.sources];
  const sourceMap = outputMap([record], sources, [{
    mappings: record.mappings,
    sourceCount: record.sources.length,
    sourceRemap: record.sources.map((_, index) => index + 1),
    fragments: [{
      inputStartLine: inputStart.line,
      inputStartColumn: inputStart.column,
      inputEndLine: inputEnd.line,
      inputEndColumn: inputEnd.column,
      outputStartLine: outputStart.line,
      outputStartColumn: outputStart.column,
    }],
  }], "server");

  mkdirSync(directory, { recursive: true });
  writeFileSync(`${filename}.map`, JSON.stringify(sourceMap));
  writeFileSync(filename, patchSource);
  const value = globalThis.require(filename);
  if (!Array.isArray(value) || value.length < 2) {
    throw new TypeError("Bake's registered server patch did not export its module registry");
  }
  return { bundleConfig: value[1], filename, modules: value[0], sourceMap };
}
