import picomatch from "../vendor/picomatch.js";
import { join as pathJoin, resolve as nodePathResolve } from "../node/path.js";
const cottontail = globalThis.cottontail;
const lazyPicomatch = (...args) => picomatch(...args);

export class Glob {
  constructor(pattern) {
    this.pattern = String(pattern);
    const compiledPattern = normalizeGlobCharacterClasses(normalizeGlobSeparators(this.pattern));
    installGlobJsMatchers(this, compiledPattern);
  }
  match(value) {
    if (typeof value !== "string") throw new TypeError("Glob.match expects a string");
    const text = normalizeGlobSeparators(value);
    if (text === "" && this._matchesEmpty) return true;
    for (const { matcher, trailingGlobstarBase } of this._matchers) {
      if (trailingGlobstarBase !== null && text === trailingGlobstarBase && trailingGlobstarBase !== "") continue;
      if (matcher(text)) return true;
      if (trailingGlobstarBase !== null && !hasGlobMeta(trailingGlobstarBase)) {
        const prefix = `${trailingGlobstarBase}/`;
        if (text === prefix || text.startsWith(prefix)) return true;
      }
    }
    return false;
  }
  scanSync(options = {}) {
    options = normalizeGlobScanOptions(options);
    const cwd = nodePathResolve(String(options.cwd ?? options.root ?? cottontail.cwd()));
    const normalizedPattern = normalizeGlobSeparators(this.pattern);
    const patternIsAbsolute = isAbsoluteGlobPath(normalizedPattern);
    const compiledPattern = normalizedPattern;
    // Detect leading dot-segments in the pattern (e.g. "./", "../", "../../")
    // Bun preserves these in relative scan results and resolves them for the scan root.
    let dotPrefix = "";
    let scanRoot = cwd;
    if (!patternIsAbsolute) {
      const dotPrefixMatch = compiledPattern.match(/^((?:\.\.?\/)+)/);
      if (dotPrefixMatch) {
        dotPrefix = dotPrefixMatch[1];
        // Resolve the scan root by applying the dot-segments to cwd
        const prefixWithoutTrailingSlash = dotPrefix.endsWith("/") ? dotPrefix.slice(0, -1) : dotPrefix;
        scanRoot = nodePathResolve(cwd, prefixWithoutTrailingSlash);
      }
    }
    const root = patternIsAbsolute ? absoluteGlobScanRoot(compiledPattern, cwd) : scanRoot;
    if (patternIsAbsolute && root === "/" && absoluteRootGlobShouldNotScan(compiledPattern)) return [];
    const absolute = Boolean(options.absolute);
    const onlyFiles = options.onlyFiles !== false;
    const dot = Boolean(options.dot);
    const followSymlinks = Object.prototype.hasOwnProperty.call(options, "followSymlinks") && Boolean(options.followSymlinks);
    // When the pattern has a dot-prefix, walkFiles generates paths relative to the
    // resolved root (without the prefix). We need a matcher for the stripped pattern.
    let strippedMatcher = null;
    if (dotPrefix) {
      const strippedPattern = compiledPattern.slice(dotPrefix.length);
      if (strippedPattern) {
        strippedMatcher = lazyPicomatch(strippedPattern, { dot: true });
      }
    }
    const results = [];
    for (const entry of walkFiles(root, { dot, onlyFiles, followSymlinks, throwErrorOnBrokenSymlink: Boolean(options.throwErrorOnBrokenSymlink) })) {
      const matchTarget = patternIsAbsolute ? entry.absolute : entry.relative;
      let matches;
      if (strippedMatcher) {
        // Use the stripped pattern for matching against walkFiles' relative paths
        matches = strippedMatcher(matchTarget) || (entry.isDirectory && strippedMatcher(`${matchTarget}/`));
      } else {
        matches = this.match(matchTarget) || (entry.isDirectory && this.match(`${matchTarget}/`));
      }
      if (!matches) continue;
      if (absolute || patternIsAbsolute) {
        results.push(entry.absolute);
      } else if (dotPrefix) {
        // Prepend the dot-prefix from the pattern to the relative path
        const prefix = dotPrefix.endsWith("/") ? dotPrefix.slice(0, -1) : dotPrefix;
        results.push(entry.relative ? `${prefix}/${entry.relative}` : prefix);
      } else {
        results.push(entry.relative);
      }
    }
    return results;
  }
  scan(options = {}) {
    const entries = this.scanSync(options);
    return (async function*() {
      yield* entries;
    })();
  }
}

function installGlobJsMatchers(glob, compiledPattern) {
  const patterns = expandBunGlobBraces(compiledPattern);
  glob._matchesEmpty = patterns.some((expanded) => expanded === "*" || expanded === "**");
  glob._matchers = patterns.map((expanded) => ({
    pattern: expanded,
    matcher: expanded === "" ? (text) => text === "" : lazyPicomatch(expanded, { dot: true }),
    trailingGlobstarBase: trailingGlobstarBase(expanded),
  }));
}

function normalizeGlobScanOptions(options) {
  if (options === undefined) return {};
  if (typeof options === "string") return { cwd: options };
  if (options === null || typeof options !== "object") throw new TypeError("Glob.scan options must be an object or string");
  if (options.cwd !== undefined && typeof options.cwd !== "string") throw new TypeError("Glob.scan cwd must be a string");
  if (options.root !== undefined && typeof options.root !== "string") throw new TypeError("Glob.scan root must be a string");
  return options;
}

function normalizeGlobSeparators(value) {
  const text = String(value);
  return globalThis.process?.platform === "win32" ? text.replace(/\\/g, "/") : text;
}

function normalizeGlobCharacterClasses(pattern) {
  let output = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      output += char + pattern[index + 1];
      index += 1;
      continue;
    }
    if (char === "[" && pattern[index + 1] === "!") {
      output += "[^";
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function trailingGlobstarBase(pattern) {
  let base = pattern;
  let matched = false;
  while (base.endsWith("/**")) {
    base = base.slice(0, -3);
    matched = true;
  }
  return matched ? base : null;
}

function isAbsoluteGlobPath(pattern) {
  return pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern);
}

function absoluteGlobScanRoot(pattern, cwd) {
  const prefix = literalGlobPrefix(pattern);
  if (prefix === "" || prefix === "/") return "/";
  if (prefix.endsWith("/") && prefix.length > 1) return nodePathResolve(cwd, prefix.slice(0, -1));
  const trimmed = prefix;
  if (trimmed === "") return "/";
  const slash = trimmed.lastIndexOf("/");
  if (slash <= 0) return "/";
  return nodePathResolve(cwd, trimmed.slice(0, slash));
}

function absoluteRootGlobShouldNotScan(pattern) {
  const rest = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const slash = rest.indexOf("/");
  const first = slash === -1 ? rest : rest.slice(0, slash);
  if (first === "" || first === "*" || first === "**") return false;
  return /[*?[\]{}]/.test(first);
}

function literalGlobPrefix(pattern) {
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "\\" && index + 1 < pattern.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      return pattern.slice(0, index);
    }
    if (char === "{" || char === "*" || char === "?") return pattern.slice(0, index);
  }
  return pattern;
}

function hasGlobMeta(pattern) {
  return /[*?[\]()!+@]/.test(pattern);
}

function expandBunGlobBraces(pattern) {
  const results = [];
  const limit = 4096;
  const visit = (text) => {
    if (results.length >= limit) {
      results.push(text);
      return;
    }
    const open = findGlobBraceOpen(text);
    if (open === -1) {
      results.push(text);
      return;
    }
    const close = findGlobBraceClose(text, open);
    if (close === -1) {
      results.push(text);
      return;
    }
    const prefix = text.slice(0, open);
    const suffix = text.slice(close + 1);
    for (const alternative of splitGlobBraceAlternatives(text.slice(open + 1, close))) {
      visit(`${prefix}${alternative}${suffix}`);
    }
  };
  visit(pattern);
  return results.length === 0 ? [pattern] : results;
}

function findGlobBraceOpen(text) {
  let inClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (char === "{" && !inClass) return index;
  }
  return -1;
}

function findGlobBraceClose(text, open) {
  let depth = 0;
  let inClass = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function splitGlobBraceAlternatives(text) {
  const alternatives = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) {
      index += 1;
      continue;
    }
    if (char === "[" && !inClass) {
      inClass = true;
      continue;
    }
    if (char === "]" && inClass) {
      inClass = false;
      continue;
    }
    if (inClass) continue;
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      continue;
    }
    if (char === "," && depth === 0) {
      alternatives.push(text.slice(start, index));
      start = index + 1;
    }
  }
  alternatives.push(text.slice(start));
  return alternatives;
}

export function walkFiles(root, options = {}, prefix = "", seen = new Set()) {
  const entries = [];
  for (const entry of cottontail.readDirSync(root)) {
    if (!options.dot && entry.name.startsWith(".")) continue;
    const absolute = pathJoin(root, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    let stat = entry;
    const entryMode = Number(entry.mode) || 0;
    const isSymbolicLink =
      entry.isSymbolicLink === true ||
      entry.kind === "symlink" ||
      entry.type === "symlink" ||
      (entryMode & 0o170000) === 0o120000;
    if (isSymbolicLink && options.followSymlinks) {
      try {
        stat = cottontail.statSync(absolute, true);
        if (!stat) throw new Error(`Broken symbolic link: ${absolute}`);
      } catch (error) {
        if (options.throwErrorOnBrokenSymlink) throw error;
        stat = entry;
      }
    }
    const statMode = Number(stat.mode) || 0;
    const isDirectory =
      stat.kind === "directory" ||
      stat.type === "directory" ||
      stat.isDirectory === true ||
      (statMode & 0o170000) === 0o040000;
    if (isDirectory) {
      if (options.onlyFiles === false) entries.push({ absolute, relative, isDirectory: true });
      const key = stat.dev != null && stat.ino != null ? `${stat.dev}:${stat.ino}` : absolute;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(...walkFiles(absolute, options, relative, seen));
    } else if (options.onlyFiles !== false) {
      entries.push({ absolute, relative, isDirectory: false });
    } else {
      entries.push({ absolute, relative, isDirectory: false });
    }
  }
  return entries;
}
