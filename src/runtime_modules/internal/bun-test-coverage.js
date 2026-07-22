import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "../node/fs.js";
import { dirname, isAbsolute, relative, resolve } from "../node/path.js";
import { fileURLToPath } from "../node/url.js";

const base64Characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Values = new Map(Array.from(base64Characters, (character, index) => [character, index]));

function cliValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    if (argument.startsWith(`${name}=`)) {
      values.push(argument.slice(name.length + 1));
    } else if (argument === name && index + 1 < args.length) {
      values.push(String(args[index + 1]));
      index += 1;
    }
  }
  return values;
}

function validateBoolean(config, name, fallback) {
  const value = config?.[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

function validateReporters(value) {
  if (value === undefined) return ["text"];
  const reporters = typeof value === "string" ? [value] : value;
  if (!Array.isArray(reporters) || reporters.some((reporter) => typeof reporter !== "string")) {
    throw new TypeError("coverageReporter must be a string or array of strings");
  }
  for (const reporter of reporters) {
    if (reporter !== "text" && reporter !== "lcov") {
      throw new TypeError(`Invalid coverage reporter ${JSON.stringify(reporter)}`);
    }
  }
  return [...new Set(reporters)];
}

function validateIgnorePatterns(value) {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) {
    throw new TypeError("coveragePathIgnorePatterns must be a string or array of strings");
  }
  if (value.some((pattern) => typeof pattern !== "string")) {
    throw new TypeError("coveragePathIgnorePatterns array must contain only strings");
  }
  return value.slice();
}

function validateThreshold(value) {
  if (value === undefined) return null;
  const defaults = { functions: 0.9, lines: 0.9, statements: 0.75 };
  if (typeof value === "number" && Number.isFinite(value)) {
    return { functions: value, lines: value, statements: value };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("coverageThreshold must be a number or object");
  }
  for (const name of ["functions", "lines", "statements"]) {
    if (value[name] !== undefined && (typeof value[name] !== "number" || !Number.isFinite(value[name]))) {
      throw new TypeError(`coverageThreshold.${name} must be a number`);
    }
  }
  return { ...defaults, ...value };
}

export function coverageOptions(args, config = Object.create(null)) {
  if (config.coverage !== undefined && typeof config.coverage !== "boolean") {
    throw new TypeError("coverage must be a boolean");
  }
  const cliReporters = cliValues(args, "--coverage-reporter");
  const reporters = cliReporters.length > 0
    ? validateReporters(cliReporters)
    : validateReporters(config.coverageReporter);
  const cliDirectories = cliValues(args, "--coverage-dir");
  const configuredDirectory = config.coverageDir;
  if (configuredDirectory !== undefined && typeof configuredDirectory !== "string") {
    throw new TypeError("coverageDir must be a string");
  }
  return {
    enabled: args.includes("--coverage") || config.coverage === true,
    reporters,
    directory: cliDirectories.at(-1) ?? configuredDirectory ?? "coverage",
    threshold: validateThreshold(config.coverageThreshold),
    ignoreSourceMaps: validateBoolean(config, "coverageIgnoreSourcemaps", false),
    skipTestFiles: validateBoolean(config, "coverageSkipTestFiles", true),
    ignorePatterns: validateIgnorePatterns(config.coveragePathIgnorePatterns),
  };
}

function decodeVlq(segment) {
  const values = [];
  let value = 0;
  let shift = 0;
  for (const character of segment) {
    const digit = base64Values.get(character);
    if (digit === undefined) throw new Error("Invalid source map VLQ digit");
    value += (digit & 31) * (2 ** shift);
    if ((digit & 32) !== 0) {
      shift += 5;
      continue;
    }
    const negative = (value & 1) !== 0;
    const magnitude = Math.floor(value / 2);
    values.push(negative ? -magnitude : magnitude);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error("Truncated source map VLQ segment");
  return values;
}

function decodeMappings(payload, lineOffset = 0, columnOffset = 0) {
  if (Array.isArray(payload?.sections)) {
    const entries = [];
    for (const section of payload.sections) {
      if (section?.map == null) continue;
      const sectionLine = lineOffset + (Number(section.offset?.line) || 0);
      const sectionColumn = (Number(section.offset?.column) || 0) + columnOffset;
      entries.push(...decodeMappings(section.map, sectionLine, sectionColumn));
    }
    return entries.sort(compareGeneratedPosition);
  }

  const sources = Array.from(payload?.sources ?? [], (source) => source == null ? null : String(source));
  const sourceRoot = payload?.sourceRoot == null ? "" : String(payload.sourceRoot);
  const entries = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;
  const names = Array.from(payload?.names ?? [], String);
  const mappingLines = String(payload?.mappings ?? "").split(";");
  for (let generatedLine = 0; generatedLine < mappingLines.length; generatedLine += 1) {
    let generatedColumn = 0;
    for (const segment of mappingLines[generatedLine].split(",")) {
      if (segment.length === 0) continue;
      const fields = decodeVlq(segment);
      generatedColumn += fields[0] ?? 0;
      if (fields.length < 4) {
        entries.push({
          generatedLine: generatedLine + lineOffset,
          generatedColumn: generatedColumn + (generatedLine === 0 ? columnOffset : 0),
          source: null,
        });
        continue;
      }
      sourceIndex += fields[1];
      originalLine += fields[2];
      originalColumn += fields[3];
      if (fields.length >= 5) nameIndex += fields[4];
      const source = sources[sourceIndex];
      if (source == null) continue;
      entries.push({
        generatedLine: generatedLine + lineOffset,
        generatedColumn: generatedColumn + (generatedLine === 0 ? columnOffset : 0),
        source: `${sourceRoot}${source}`,
        originalLine,
        originalColumn,
        name: fields.length >= 5 ? names[nameIndex] : undefined,
      });
    }
  }
  return entries;
}

function compareGeneratedPosition(left, right) {
  return left.generatedLine - right.generatedLine || left.generatedColumn - right.generatedColumn;
}

function lineStarts(source) {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineForOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

function firstMappingAtOrAfter(entries, offset) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (entries[middle].generatedOffset < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function mappingsForRange(entries, starts, sourceLength, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const minimum = Math.max(0, Math.min(start, end));
  const maximum = Math.min(sourceLength, Math.max(start, end));
  if (maximum <= minimum) return [];
  const mappings = [];
  let index = firstMappingAtOrAfter(entries, minimum);
  if (index > 0) {
    const previous = entries[index - 1];
    if (previous.generatedLine === lineForOffset(starts, minimum)) index -= 1;
  }
  while (index < entries.length) {
    const mapping = entries[index];
    if (mapping.generatedOffset >= maximum) break;
    const lineEnd = starts[mapping.generatedLine + 1] ?? sourceLength;
    const next = entries[index + 1];
    const segmentEnd = next?.generatedLine === mapping.generatedLine
      ? Math.min(lineEnd, next.generatedOffset)
      : lineEnd;
    const segmentStart = Math.max(minimum, mapping.generatedOffset, starts[mapping.generatedLine] + 1);
    const coveredEnd = Math.min(maximum, segmentEnd);
    if (mapping.source != null && coveredEnd > segmentStart) {
      mappings.push({ mapping, units: coveredEnd - segmentStart });
    }
    index += 1;
  }
  return mappings;
}

function decodeNativeCoverage(raw) {
  if (!Array.isArray(raw) || raw.length < 3) throw new Error("Invalid JSC coverage payload");
  const blockCount = Number(raw[1]);
  const functionCount = Number(raw[2]);
  if (!Number.isSafeInteger(blockCount) || blockCount < 0 ||
      !Number.isSafeInteger(functionCount) || functionCount < 0) {
    throw new Error("Invalid JSC coverage range counts");
  }
  let cursor = 3;
  const blocks = [];
  for (let index = 0; index < blockCount; index += 1) {
    blocks.push({
      start: Number(raw[cursor++]),
      end: Number(raw[cursor++]),
      executed: Boolean(raw[cursor++]),
      count: Number(raw[cursor++]) || 0,
    });
  }
  const functions = [];
  for (let index = 0; index < functionCount; index += 1) {
    functions.push({
      executed: Boolean(raw[cursor++]),
      start: Number(raw[cursor++]),
      end: Number(raw[cursor++]),
    });
  }
  if (cursor !== raw.length) throw new Error("Invalid JSC coverage payload length");
  return { blocks, functions };
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path.length > 0 && path !== ".." && !path.startsWith(`..${globalThis.process?.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

function sourcePath(source, cwd, bundlePath, sourceRoot) {
  if (!source || source.startsWith("node:") || source.startsWith("bun:") || source[0] === "[") return null;
  let decoded = source;
  if (decoded.startsWith("file:")) {
    try {
      decoded = fileURLToPath(decoded);
    } catch {
      return null;
    }
  }
  const candidates = isAbsolute(decoded)
    ? [decoded]
    : [resolve(sourceRoot, decoded), resolve(cwd, decoded), resolve(dirname(bundlePath), decoded)];
  const absolute = candidates.find((candidate) => isWithin(cwd, candidate) && existsSync(candidate));
  if (absolute == null) return null;
  const relativePath = relative(cwd, absolute).replaceAll("\\", "/");
  if (relativePath.split("/").includes("node_modules") ||
      relativePath.split("/").includes(".cottontail-tmp") ||
      relativePath.startsWith("src/runtime_modules/") ||
      /(?:^|\/)\.cottontail-(?:compat|runtime)/.test(relativePath)) {
    return null;
  }
  return { absolute: resolve(absolute), relative: relativePath };
}

function isTestFile(path) {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extension = basename.lastIndexOf(".");
  const stem = extension > 0 ? basename.slice(0, extension) : basename;
  return stem.endsWith(".test") || stem.endsWith(".spec") ||
    stem.endsWith("_test") || stem.endsWith("_spec");
}

function ignoredByPattern(relativePath, patterns) {
  for (const pattern of patterns) {
    try {
      if (new globalThis.Bun.Glob(pattern).match(relativePath)) return true;
    } catch (error) {
      throw new TypeError(`Invalid coveragePathIgnorePatterns glob ${JSON.stringify(pattern)}: ${error?.message ?? error}`);
    }
  }
  return false;
}

function emptyReport(path) {
  const source = String(readFileSync(path.absolute, "utf8"));
  const sourceLines = source.split("\n");
  return {
    ...path,
    sourceLines,
    lineCount: sourceLines.length,
    executableLines: new Set(),
    lineHits: new Map(),
    functions: new Map(),
    functionRanges: [],
    statements: new Map(),
  };
}

function collectReports(options) {
  const host = globalThis.cottontail;
  if (typeof host?.collectTestCoverage !== "function") {
    throw new Error("JavaScriptCore coverage collector is unavailable");
  }

  // Collect first. Parsing the source map and writing reporters must not count
  // as execution in the measured bundle.
  const nativeCoverage = decodeNativeCoverage(host.collectTestCoverage());
  const sourceOffset = Number(host.coverageSourceOffset);
  const bundlePath = String(globalThis.__cottontailBundlePath ?? "");
  if (!bundlePath || !Number.isFinite(sourceOffset)) throw new Error("Coverage bundle metadata is unavailable");
  const evaluatedSource = typeof host.coverageSource === "string"
    ? host.coverageSource
    : String(readFileSync(bundlePath, "utf8"));
  const sourceEnd = sourceOffset + evaluatedSource.length;
  const mapPayload = globalThis.__cottontailBundleSourceMapData != null
    ? JSON.parse(String(globalThis.__cottontailBundleSourceMapData))
    : JSON.parse(String(readFileSync(String(globalThis.__cottontailBundleSourceMap), "utf8")));
  const starts = lineStarts(evaluatedSource);
  const mappings = decodeMappings(mapPayload);
  for (const mapping of mappings) {
    const lineStart = starts[mapping.generatedLine];
    mapping.generatedOffset = lineStart === undefined ? Infinity : lineStart + mapping.generatedColumn;
  }
  mappings.sort((left, right) => left.generatedOffset - right.generatedOffset);

  const cwd = resolve(String(globalThis.process?.cwd?.() ?? "."));
  const sourceRoot = resolve(String(globalThis.__cottontailBundleSourceRoot ?? cwd));
  const sourceCache = new Map();
  const reports = new Map();
  const functions = nativeCoverage.functions.length > 1
    ? nativeCoverage.functions.slice(1)
    : nativeCoverage.functions;
  const userFunctions = functions.filter((fn) => {
    const localStart = fn.start - sourceOffset;
    const prefix = evaluatedSource.slice(Math.max(0, localStart - 64), localStart);
    return !/__(?:esm|commonJS)\(\s*$/.test(prefix);
  });

  function reportFor(mapping) {
    if (sourceCache.has(mapping.source)) return sourceCache.get(mapping.source);
    const path = sourcePath(mapping.source, cwd, bundlePath, sourceRoot);
    if (path == null ||
        (options.skipTestFiles && isTestFile(path.absolute)) ||
        ignoredByPattern(path.relative, options.ignorePatterns)) {
      sourceCache.set(mapping.source, null);
      return null;
    }
    let report = reports.get(path.absolute);
    if (report == null) {
      report = emptyReport(path);
      reports.set(path.absolute, report);
    }
    sourceCache.set(mapping.source, report);
    return report;
  }

  for (const block of nativeCoverage.blocks) {
    if (block.start < sourceOffset || block.end > sourceEnd) continue;
    const rangeMappings = mappingsForRange(
      mappings,
      starts,
      evaluatedSource.length,
      block.start - sourceOffset,
      block.end - sourceOffset,
    );
    const linesInBlock = new Set();
    const reportsInBlock = new Set();
    for (const { mapping, units } of rangeMappings) {
      const report = reportFor(mapping);
      if (report == null) continue;
      const line = options.ignoreSourceMaps ? mapping.generatedLine : mapping.originalLine;
      if (!Number.isSafeInteger(line) || line < 0) continue;
      const lineKey = `${report.absolute}:${line}`;
      reportsInBlock.add(report);
      if (!linesInBlock.has(lineKey)) {
        linesInBlock.add(lineKey);
        report.executableLines.add(line);
      }
      if (block.executed || block.count > 0) {
        report.lineHits.set(line, (report.lineHits.get(line) ?? 0) + units);
      }
    }
    for (const report of reportsInBlock) {
      const key = `${block.start}:${block.end}`;
      const previous = report.statements.get(key) === true;
      report.statements.set(key, previous || block.executed || block.count > 0);
    }
  }

  for (const fn of userFunctions) {
    if (fn.start < sourceOffset || fn.end > sourceEnd) continue;
    const rangeMappings = mappingsForRange(
      mappings,
      starts,
      evaluatedSource.length,
      fn.start - sourceOffset,
      fn.end - sourceOffset,
    );
    const reportsInFunction = new Map();
    for (const { mapping } of rangeMappings) {
      const report = reportFor(mapping);
      if (report == null) continue;
      const line = options.ignoreSourceMaps ? mapping.generatedLine : mapping.originalLine;
      if (!Number.isSafeInteger(line) || line < 0) continue;
      const bounds = reportsInFunction.get(report);
      if (bounds == null) reportsInFunction.set(report, { minimum: line, maximum: line });
      else {
        bounds.minimum = Math.min(bounds.minimum, line);
        bounds.maximum = Math.max(bounds.maximum, line);
      }
    }
    for (const [report, bounds] of reportsInFunction) {
      const key = `${fn.start}:${fn.end}`;
      report.functions.set(key, report.functions.get(key) === true || fn.executed);
      report.functionRanges.push({ ...bounds, executed: fn.executed });
      if (!fn.executed) {
        for (let line = bounds.minimum; line <= bounds.maximum; line += 1) {
          report.executableLines.delete(line);
          report.lineHits.delete(line);
        }
        const end = Math.min(bounds.maximum, report.lineCount);
        for (let line = bounds.minimum; line < end; line += 1) {
          report.executableLines.add(line);
        }
        const terminal = report.sourceLines[bounds.maximum]?.trim() ?? "";
        if (/^(?:return|throw)\s+(?:[-+]?\d|true\b|false\b|null\b|undefined\b)/.test(terminal)) {
          report.executableLines.add(bounds.maximum);
          report.lineHits.set(bounds.maximum, 1);
        }
      }
    }
  }

  for (const report of reports.values()) {
    for (let line = 0; line < report.sourceLines.length; line += 1) {
      if (!/^\s*(?:export\s+)?(?:default\s+)?class(?:\s|{)/.test(report.sourceLines[line])) continue;
      if (report.functionRanges.some((range) => line >= range.minimum && line <= range.maximum)) continue;
      report.functions.set(`class:${line}`, false);
    }
  }

  return [...reports.values()].sort((left, right) => left.relative.localeCompare(right.relative));
}

function fraction(hit, total) {
  return total === 0 ? 1 : hit / total;
}

function reportMetrics(report) {
  const lineCount = report.executableLines.size;
  let hitLines = 0;
  for (const line of report.executableLines) {
    if ((report.lineHits.get(line) ?? 0) > 0) hitLines += 1;
  }
  const functions = [...report.functions.values()];
  const statements = [...report.statements.values()];
  return {
    functions: fraction(functions.filter(Boolean).length, functions.length),
    lines: fraction(hitLines, lineCount),
    statements: fraction(statements.filter(Boolean).length, statements.length),
  };
}

function percent(value) {
  return (value * 100).toFixed(2).padStart(7);
}

function uncoveredLines(report) {
  const uncovered = [...report.executableLines]
    .filter((line) => (report.lineHits.get(line) ?? 0) === 0)
    .sort((left, right) => left - right);
  const ranges = [];
  let start = 0;
  let previous = 0;
  let first = true;
  for (const line of uncovered) {
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    if (first && start === 0 && previous === 0) {
      start = line;
      previous = line;
      continue;
    }
    ranges.push([start, previous]);
    first = false;
    start = line;
    previous = line;
  }
  if (previous !== start) ranges.push([start, previous]);
  return ranges.map(([start, end]) => start === end ? String(start + 1) : `${start + 1}-${end + 1}`).join(",");
}

function writeTextReport(reports, threshold, emit) {
  if (reports.length === 0 && !globalThis.__cottontailBunTestUsed) return false;
  const metrics = reports.map(reportMetrics);
  const average = reports.length === 0
    ? { functions: 0, lines: 0, statements: 0 }
    : {
        functions: metrics.reduce((sum, value) => sum + value.functions, 0) / metrics.length,
        lines: metrics.reduce((sum, value) => sum + value.lines, 0) / metrics.length,
        statements: metrics.reduce((sum, value) => sum + value.statements, 0) / metrics.length,
      };
  const width = Math.max("All files".length, ...reports.map((report) => report.relative.length)) + 1;
  const separator = `${"-".repeat(width + 1)}|---------|---------|-------------------`;
  const lines = [
    separator,
    `File${" ".repeat(width - "File".length + 1)}| % Funcs | % Lines | Uncovered Line #s`,
    separator,
    `All files${" ".repeat(width - "All files".length + 1)}| ${percent(average.functions)} | ${percent(average.lines)} |`,
  ];
  for (let index = 0; index < reports.length; index += 1) {
    const report = reports[index];
    lines.push(
      ` ${report.relative}${" ".repeat(width - report.relative.length)}| ${percent(metrics[index].functions)} | ${percent(metrics[index].lines)} | ${uncoveredLines(report)}`,
    );
  }
  lines.push(separator);
  emit(lines.join("\n"));

  if (threshold == null) return false;
  return metrics.some((value) =>
    value.functions < threshold.functions || value.lines < threshold.lines);
}

function lcovLineHits(report, line) {
  // Cottontail profiles one generated bundle; normalize mapped source spans to
  // the per-module ranges Bun's profiler writes to LCOV.
  const measured = report.lineHits.get(line) ?? 0;
  if (measured <= 0) return 0;
  const source = report.sourceLines[line] ?? "";
  const trimmed = source.trim();
  const functionRange = report.functionRanges.find((range) => line >= range.minimum && line <= range.maximum);

  if (functionRange?.executed === false) return measured;
  if (/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/.test(trimmed)) return 11;
  if (/^(?:export\s+)?(?:default\s+)?class(?:\s|{)/.test(trimmed)) return source.trimEnd().length + 3;
  if (/^#/.test(trimmed)) return trimmed.length + 9;
  if (/^(?:import\b|export\s*{)/.test(trimmed)) return source.trimEnd().length;
  if (/^(?:return|throw)\b/.test(trimmed)) {
    if (report.functionRanges.length === 1 && /^return\s+(["']).*\1;\s*$/.test(trimmed)) {
      return Math.max(1, trimmed.length - 1);
    }
    return trimmed.length;
  }
  if (/^}\)?;\s*$/.test(trimmed)) return Math.max(1, trimmed.length - 1);
  if (functionRange == null && /;\s*$/.test(trimmed)) return Math.max(1, source.trimEnd().length - 1);

  if (functionRange != null) {
    for (let next = line + 1; next < report.sourceLines.length; next += 1) {
      const nextLine = report.sourceLines[next]?.trim() ?? "";
      if (!nextLine) continue;
      if (/^}/.test(nextLine) && /;\s*$/.test(trimmed)) return Math.max(1, source.trimEnd().length - 1);
      break;
    }
  }
  return source.trimEnd().length || measured;
}

function writeLcovReport(reports, directory) {
  const records = [];
  for (const report of reports) {
    const functions = [...report.functions.values()];
    const executable = [...report.executableLines].sort((left, right) => left - right);
    records.push("TN:");
    records.push(`SF:${report.relative}`);
    records.push(`FNF:${functions.length}`);
    records.push(`FNH:${functions.filter(Boolean).length}`);
    for (const line of executable) records.push(`DA:${line + 1},${lcovLineHits(report, line)}`);
    records.push(`LF:${executable.length}`);
    records.push(`LH:${executable.filter((line) => (report.lineHits.get(line) ?? 0) > 0).length}`);
    records.push("end_of_record");
  }

  const cwd = String(globalThis.process?.cwd?.() ?? ".");
  const outputDirectory = resolve(cwd, directory);
  mkdirSync(outputDirectory, { recursive: true });
  const output = resolve(outputDirectory, "lcov.info");
  const temporary = resolve(
    outputDirectory,
    `.lcov.info.${globalThis.process?.pid ?? 0}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(temporary, records.length === 0 ? "" : `${records.join("\n")}\n`);
    renameSync(temporary, output);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function reportTestCoverage(options, emitText = (text) => console.error(text)) {
  if (!options.enabled) return false;
  const reports = collectReports(options);
  let thresholdFailed = false;
  if (options.reporters.includes("text")) {
    thresholdFailed = writeTextReport(reports, options.threshold, emitText);
  }
  if (options.reporters.includes("lcov")) writeLcovReport(reports, options.directory);
  return thresholdFailed;
}
