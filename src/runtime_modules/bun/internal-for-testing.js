import Module, { _resolveFilename } from "../node/module.js";

export const jscInternals = {
  isLatin1String(value) {
    return /^[\x00-\xff]*$/.test(String(value));
  },
  isUTF16String(value) {
    return !this.isLatin1String(value);
  },
};

function internalUnavailable(name) {
  return () => {
    throw new Error(`bun:internal-for-testing ${name} is unavailable in Cottontail`);
  };
}

export function escapeRegExp(value) {
  return String(value).replace(/[\\^$*+?.()|{}\[\]-]/g, (character) =>
    character === "-" ? "\\x2d" : `\\${character}`
  );
}

export function escapeRegExpForPackageNameMatching(value) {
  return String(value).replace(/[\\^$*+?.()|{}\[\]-]/g, (character) => {
    if (character === "*") return ".*";
    return character === "-" ? "\\x2d" : `\\${character}`;
  });
}

export const cssInternals = new Proxy({}, {
  get(_target, property) {
    return internalUnavailable(`cssInternals.${String(property)}`);
  },
});

export const shellInternals = {
  builtinDisabled() {
    return false;
  },
  lex: internalUnavailable("shellInternals.lex"),
  parse: internalUnavailable("shellInternals.parse"),
};

function bytesToText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return String(value);
}

function escapeStringRegexp(value) {
  return String(value).replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}

function trimSlashes(value) {
  return String(value).replace(/^\/|\/$/g, "");
}

function normalizePatchPath(path) {
  const value = String(path || "");
  if (value === "/dev/null") return null;
  return value.replace(/^[ab]\//, "");
}

function patchHeaderLine(line) {
  return String(line ?? "").replace(/\r$/, "");
}

function modeName(mode) {
  return String(mode) === "100755" ? "executable" : "non_executable";
}

function list(items = []) {
  return { items };
}

export async function makePatchDiff(aFolder, bFolder, cwd = undefined) {
  const args = [
    "-c", "core.safecrlf=false",
    "diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--ignore-cr-at-eol",
    "--irreversible-delete",
    "--full-index",
    "--no-index",
    String(aFolder),
    String(bFolder),
  ];
  const result = cottontail.spawnSync("git", args, {
    cwd,
    stdio: "pipe",
    env: {
      ...(globalThis.process?.env ?? {}),
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: "",
      XDG_CONFIG_HOME: "",
      USERPROFILE: "",
    },
  });
  const stderr = bytesToText(result.stderr);
  if (stderr.length > 0) throw new Error(stderr);
  let patch = bytesToText(result.stdout);
  const a = trimSlashes(aFolder);
  const b = trimSlashes(bFolder);
  patch = patch
    .replace(new RegExp(`(a|b)(${escapeStringRegexp(`/${a}/`)})`, "g"), "$1/")
    .replace(new RegExp(`(a|b)${escapeStringRegexp(`/${b}/`)}`, "g"), "$1/")
    .replace(new RegExp(escapeStringRegexp(`${aFolder}/`), "g"), "")
    .replace(new RegExp(escapeStringRegexp(`${bFolder}/`), "g"), "");
  return patch;
}

export async function applyPatchDiff(patch, destination) {
  let source = String(patch ?? "");
  if (source.length === 0) return;
  const sections = source.split(/(?=^diff --git )/m);
  const remaining = [];
  for (const section of sections) {
    if (!section.trim()) continue;
    const lines = section.split("\n");
    const first = patchHeaderLine(lines[0]);
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(first);
    const irreversibleDelete = lines.some((line) => patchHeaderLine(line).startsWith("deleted file mode ")) &&
      !lines.some((line) => patchHeaderLine(line).startsWith("--- "));
    if (match && irreversibleDelete) {
      try {
        cottontail.unlinkSync(`${String(destination).replace(/\/$/, "")}/${match[1]}`);
      } catch {}
      continue;
    }
    remaining.push(section);
  }
  source = remaining.join("");
  if (source.trim().length === 0) return;
  const result = cottontail.spawnSync("git", ["-c", "core.safecrlf=false", "apply", "--unsafe-paths", "--whitespace=nowarn", "-p1"], {
    cwd: String(destination),
    stdio: "pipe",
    input: new TextEncoder().encode(source),
  });
  if (Number(result.status ?? result.exitCode ?? 0) !== 0) {
    const reverse = cottontail.spawnSync("git", ["-c", "core.safecrlf=false", "apply", "--reverse", "--check", "--unsafe-paths", "--whitespace=nowarn", "-p1"], {
      cwd: String(destination),
      stdio: "pipe",
      input: new TextEncoder().encode(source),
    });
    if (Number(reverse.status ?? reverse.exitCode ?? 0) === 0) return;
    const message = bytesToText(result.stderr) || bytesToText(result.stdout) || "git apply failed";
    throw new Error(message);
  }
}

function parseHunkHeader(line) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(patchHeaderLine(line));
  if (!match) throw new Error("Invalid patch hunk header");
  const originalStart = Number(match[1]);
  const patchedStart = Number(match[3]);
  return {
    original: { start: originalStart === 0 ? 1 : originalStart, len: match[2] == null ? 1 : Number(match[2]) },
    patched: { start: patchedStart === 0 ? 1 : patchedStart, len: match[4] == null ? 1 : Number(match[4]) },
  };
}

function pushHunkPart(parts, type, line) {
  let part = parts[parts.length - 1];
  if (!part || part.type !== type || part.no_newline_at_end_of_file) {
    part = { type, lines: list([]), no_newline_at_end_of_file: false };
    parts.push(part);
  }
  part.lines.items.push(line);
}

function parseHunk(lines, index) {
  const header = parseHunkHeader(lines[index++]);
  const parts = [];
  let originalCount = 0;
  let patchedCount = 0;
  while (index < lines.length) {
    const line = lines[index];
    const headerLine = patchHeaderLine(line);
    if (headerLine.startsWith("diff --git ") || headerLine.startsWith("--- ") || headerLine.startsWith("@@ ")) break;
    index += 1;
    if (line === "\\ No newline at end of file") {
      if (parts.length > 0) parts[parts.length - 1].no_newline_at_end_of_file = true;
      continue;
    }
    const marker = line[0];
    if (marker === "+") {
      pushHunkPart(parts, "insertion", line.slice(1));
      patchedCount += 1;
    } else if (marker === "-") {
      pushHunkPart(parts, "deletion", line.slice(1));
      originalCount += 1;
    } else {
      const value = marker === " " ? line.slice(1) : line;
      pushHunkPart(parts, "context", value);
      originalCount += 1;
      patchedCount += 1;
    }
  }
  if (originalCount !== header.original.len || patchedCount !== header.patched.len) {
    throw new Error("Patch hunk line counts do not match header");
  }
  return [{ header, parts: list(parts) }, index];
}

function parseFilePatch(lines, index, metadata = {}) {
  let oldPath = metadata.oldPath ?? null;
  let newPath = metadata.newPath ?? null;
  let beforeHash = metadata.beforeHash ?? null;
  let afterHash = metadata.afterHash ?? null;
  let newMode = metadata.newMode ?? null;
  const hunks = [];

  while (index < lines.length) {
    const line = lines[index];
    const headerLine = patchHeaderLine(line);
    if (headerLine.startsWith("diff --git ") || (headerLine.startsWith("--- ") && (oldPath != null || newPath != null) && hunks.length > 0)) break;
    if (headerLine.startsWith("index ")) {
      const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?:\s+(\d+))?/.exec(headerLine);
      if (match) {
        beforeHash = match[1] === "0000000" ? match[1] : match[1];
        afterHash = match[2];
        if (match[3] && !newMode) newMode = match[3];
      }
      index += 1;
      continue;
    }
    if (headerLine.startsWith("new file mode ")) {
      newMode = headerLine.slice("new file mode ".length).trim();
      index += 1;
      continue;
    }
    if (headerLine.startsWith("--- ")) {
      oldPath = normalizePatchPath(headerLine.slice(4).trim());
      index += 1;
      continue;
    }
    if (headerLine.startsWith("+++ ")) {
      newPath = normalizePatchPath(headerLine.slice(4).trim());
      index += 1;
      continue;
    }
    if (headerLine.startsWith("@@ ")) {
      const parsed = parseHunk(lines, index);
      hunks.push(parsed[0]);
      index = parsed[1];
      continue;
    }
    index += 1;
  }

  if (oldPath === null && newPath !== null) {
    return [{
      file_creation: {
        path: newPath,
        mode: modeName(newMode ?? "100644"),
        hunk: hunks[0] ?? { header: { original: { start: 0, len: 0 }, patched: { start: 0, len: 0 } }, parts: list([]) },
        hash: afterHash,
      },
    }, index];
  }

  return [{
    file_patch: {
      path: newPath ?? oldPath,
      hunks: list(hunks),
      before_hash: beforeHash === "0000000" ? null : beforeHash,
      after_hash: afterHash === "0000000" ? null : afterHash,
    },
  }, index];
}

export function parsePatchDiff(source) {
  const lines = String(source ?? "").replace(/\n$/, "").split("\n");
  const parts = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const headerLine = patchHeaderLine(line);
    if (!headerLine || headerLine === "patch-package") {
      index += 1;
      continue;
    }
    if (headerLine.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(headerLine);
      if (!match) throw new Error("Invalid patch file header");
      let oldPath = match[1];
      let newPath = match[2];
      let oldMode = null;
      let newMode = null;
      let beforeHash = null;
      let afterHash = null;
      index += 1;
      while (index < lines.length && !patchHeaderLine(lines[index]).startsWith("--- ") && !patchHeaderLine(lines[index]).startsWith("@@ ")) {
        const meta = patchHeaderLine(lines[index]);
        if (meta.startsWith("old mode ")) oldMode = meta.slice("old mode ".length).trim();
        else if (meta.startsWith("new mode ")) newMode = meta.slice("new mode ".length).trim();
        else if (meta.startsWith("rename from ")) oldPath = meta.slice("rename from ".length).trim();
        else if (meta.startsWith("rename to ")) newPath = meta.slice("rename to ".length).trim();
        else if (meta.startsWith("index ")) {
          const hash = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?:\s+(\d+))?/.exec(meta);
          if (hash) {
            beforeHash = hash[1];
            afterHash = hash[2];
            if (hash[3] && !newMode) newMode = hash[3];
          }
        }
        index += 1;
      }
      if (oldPath !== newPath) parts.push({ file_rename: { from_path: oldPath, to_path: newPath } });
      if (oldMode && newMode && oldMode !== newMode) {
        parts.push({ file_mode_change: { path: newPath, old_mode: modeName(oldMode), new_mode: modeName(newMode) } });
      }
      if (index < lines.length && (patchHeaderLine(lines[index]).startsWith("--- ") || patchHeaderLine(lines[index]).startsWith("@@ "))) {
        const parsed = parseFilePatch(lines, index, { oldPath, newPath, beforeHash, afterHash, newMode });
        parts.push(parsed[0]);
        index = parsed[1];
      }
      continue;
    }
    if (headerLine.startsWith("--- ")) {
      const parsed = parseFilePatch(lines, index);
      parts.push(parsed[0]);
      index = parsed[1];
      continue;
    }
    throw new Error("Invalid patch file header");
  }
  return JSON.stringify({ parts: list(parts) });
}

export const patchInternals = {
  apply: applyPatchDiff,
  makeDiff: makePatchDiff,
  parse: parsePatchDiff,
};

export const iniInternals = {
  parse(source) {
    const result = {};
    let section = result;
    let sectionValid = true;
    for (const line of String(source).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
      if (trimmed.startsWith("[") && trimmed.endsWith("]") && !trimmed.includes("\\]")) {
        const path = splitIniPath(trimmed.slice(1, -1));
        const next = iniSectionForPath(result, path);
        section = next ?? {};
        sectionValid = next !== null;
        continue;
      }
      if (!sectionValid) continue;

      const index = trimmed.indexOf("=");
      const rawKey = index < 0 ? trimmed : trimmed.slice(0, index).trim();
      const rawValue = index < 0 ? "true" : trimmed.slice(index + 1);
      const arrayKey = /^\s*.+\[\]\s*$/.test(rawKey) && !isQuotedIniScalar(rawKey.trim());
      const key = normalizeIniKey(arrayKey ? rawKey.trim().slice(0, -2) : rawKey);
      const value = parseIniValue(rawValue, index < 0);
      assignIniValue(section, key, value, arrayKey);
    }
    return result;
  },
};

function isQuotedIniScalar(value) {
  return (value.startsWith("'") && value.endsWith("'")) || (value.startsWith("\"") && value.endsWith("\""));
}

function decodeIniScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return { quoted: true, quote: "\"", value: JSON.parse(trimmed) };
    } catch {
      return { quoted: false, quote: "", value: trimmed };
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return { quoted: true, quote: "'", value: trimmed.slice(1, -1) };
  }
  return { quoted: false, quote: "", value: trimmed };
}

function normalizeIniKey(raw) {
  const decoded = decodeIniScalar(String(raw));
  if (decoded.quote !== "'") return decoded.value;
  try {
    const parsed = JSON.parse(decoded.value);
    if (Array.isArray(parsed)) return String(parsed);
    if (parsed && typeof parsed === "object") return "[Object object]";
    return String(parsed);
  } catch {
    return decoded.value;
  }
}

function parseIniValue(raw, implicitTrue = false) {
  if (implicitTrue) return true;
  const trimmed = String(raw).trim();
  let value;
  let hadQuotes = false;
  let expanded = false;
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    const inner = trimmed.slice(1, -1);
    const expandedInner = expandIniEnv(inner);
    expanded = true;
    try {
      value = JSON.parse(`"${expandedInner}"`);
      hadQuotes = true;
    } catch {
      if (expandedInner !== inner) {
        value = expandedInner;
        hadQuotes = true;
      } else {
        value = trimmed;
      }
    }
  } else {
    const decoded = decodeIniScalar(String(raw));
    value = decoded.value;
    hadQuotes = decoded.quoted;
    if (!hadQuotes) value = String(value).trim();
  }
  if (!expanded) value = expandIniEnv(value);
  value = value.replace(/\\([;#])/g, "$1");
  if (!hadQuotes) value = value.replace(/\\\\/g, "\\");
  if (!hadQuotes) {
    if (value === "true") return true;
    if (value === "false") return false;
    if (value === "null") return null;
  }
  return value;
}

function expandIniEnv(input) {
  let value = String(input);
  const env = globalThis.process?.env ?? {};
  const escapedOpen = "\u0000COTTONTAIL_INI_ENV_OPEN\u0000";
  for (let pass = 0; pass < 100; pass += 1) {
    let changed = false;
    value = value.replace(/(\\*)\$\{([^{}]+)\}/g, (match, slashes, name) => {
      const slashCount = slashes.length;
      const escaped = slashCount % 2 === 1;
      const prefix = "\\".repeat(Math.floor(slashCount / 2));
      if (escaped) {
        changed = true;
        return `${prefix}${escapedOpen}${name}}`;
      }
      const optional = name.endsWith("?");
      const envName = optional ? name.slice(0, -1) : name;
      if (Object.prototype.hasOwnProperty.call(env, envName)) {
        changed = true;
        return `${prefix}${env[envName]}`;
      }
      if (optional) {
        changed = true;
        return prefix;
      }
      if (slashCount > 0) {
        changed = true;
        return `${prefix}${escapedOpen}${name}}`;
      }
      return match;
    });
    if (!changed) break;
  }
  return value.replaceAll(escapedOpen, "${");
}

function splitIniPath(section) {
  const parts = [];
  let current = "";
  for (let index = 0; index < section.length; index += 1) {
    const char = section[index];
    const next = section[index + 1];
    if (char === "\\" && next === ".") {
      current += ".";
      index += 1;
    } else if (char === ".") {
      parts.push(normalizeIniKey(current));
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(normalizeIniKey(current));
  return parts;
}

function iniSectionForPath(root, path) {
  let cursor = root;
  for (const part of path) {
    if (Object.prototype.hasOwnProperty.call(cursor, part) && (cursor[part] === null || typeof cursor[part] !== "object" || Array.isArray(cursor[part]))) {
      return null;
    }
    cursor = cursor[part] ??= {};
  }
  return cursor;
}

function assignIniValue(target, key, value, arrayKey) {
  if (arrayKey || Array.isArray(target[key])) {
    if (!Array.isArray(target[key])) target[key] = target[key] === undefined ? [] : [target[key]];
    target[key].push(value);
    return;
  }
  target[key] = value;
}

export function decodeURIComponentSIMD(value) {
  const source = String(value);
  let output = "";
  let encodedRun = "";
  const flush = () => {
    if (!encodedRun) return;
    output += decodeURIComponent(encodedRun);
    encodedRun = "";
  };
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (char !== "%") {
      flush();
      output += char;
      index += 1;
      continue;
    }
    const hex = source.slice(index + 1, index + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      encodedRun += source.slice(index, index + 3);
      index += 3;
      continue;
    }
    flush();
    output += "\ufffd";
    index += Math.min(3, source.length - index);
  }
  flush();
  return output;
}

export function hasNonReifiedStatic(value = globalThis.Bun) {
  return globalThis.__cottontailBunHasNonReifiedStatic?.(value) ?? false;
}

export function isModuleResolveFilenameSlowPathEnabled() {
  return Module._resolveFilename !== _resolveFilename;
}

export function highlightJavaScript(source) {
  return String(source);
}

export function setSocketOptions(socket, buffer, size) {
  const fd = Number(socket?.fd);
  const option = Number(buffer);
  const value = Number(size);
  if (!Number.isInteger(fd) || fd < 0) throw new TypeError("Expected a connected Socket");
  if (option !== 1 && option !== 2) return undefined;
  if (!Number.isInteger(value) || value < 0) throw new RangeError("Socket buffer size must be a non-negative integer");
  cottontail.udpSocketSetBufferSize(fd, option === 1, value === 0 ? 0 : Math.max(128, value));
  return undefined;
}

export function createSocketPair() {
  throw new Error("bun:internal-for-testing createSocketPair is unavailable in Cottontail");
}

export function canonicalizeIP(value) {
  return String(value).toLowerCase();
}

export default {
  canonicalizeIP,
  createSocketPair,
  cssInternals,
  decodeURIComponentSIMD,
  escapeRegExp,
  escapeRegExpForPackageNameMatching,
  hasNonReifiedStatic,
  highlightJavaScript,
  iniInternals,
  isModuleResolveFilenameSlowPathEnabled,
  jscInternals,
  patchInternals,
  setSocketOptions,
  shellInternals,
};
