import Module, { _resolveFilename } from "../node/module.js";
import { BlockList } from "../node/net.js";
import { readFileSync } from "../node/fs.js";
import { createHash } from "../node/crypto.js";
import { gunzipSync } from "../node/zlib.js";
import { serializeShellLex, serializeShellParse } from "../internal/bun-shell-parser.js";
import { frameworkRouterInternals } from "./bake-framework-router.js";
import { getDevServerDeinitCount as getBakeDevServerDeinitCount } from "./bake-dev-server.js";

export const jscInternals = {
  isLatin1String(value) {
    return /^[\x00-\xff]*$/.test(String(value));
  },
  isUTF16String(value) {
    return !this.isLatin1String(value);
  },
};

export function getCounters() {
  return cottontail.getCounters();
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

function runCssInternal(operation, source, _expected, options, minify = false) {
  if (typeof source !== "string") {
    throw new TypeError(`${operation}: expected source to be a string`);
  }
  const response = JSON.parse(cottontail.buildNative(JSON.stringify({
    __cottontailCssInternals: { operation, source, options, minify },
  }), cottontail.cwd()));
  if (!response.success) throw new Error(response.error || "CSS operation failed");
  return response.result;
}

export const cssInternals = {
  minifyTestWithOptions(source, expected, options) {
    return runCssInternal("minifyTestWithOptions", source, expected, options);
  },
  minifyErrorTestWithOptions(source, expected, options) {
    return runCssInternal("minifyErrorTestWithOptions", source, expected, options);
  },
  testWithOptions(source, expected, options) {
    return runCssInternal("testWithOptions", source, expected, options);
  },
  prefixTestWithOptions(source, expected, options) {
    return runCssInternal("prefixTestWithOptions", source, expected, options);
  },
  minifyTest(source, expected, browsers) {
    return runCssInternal("minifyTest", source, expected, browsers);
  },
  prefixTest(source, expected, browsers) {
    return runCssInternal("prefixTest", source, expected, browsers);
  },
  _test(source, expected, browsers) {
    return runCssInternal("_test", source, expected, browsers);
  },
  attrTest(source, expected, minify, browsers) {
    return runCssInternal("attrTest", source, expected, browsers, Boolean(minify));
  },
};

export const shellInternals = {
  builtinDisabled() {
    return false;
  },
  lex: serializeShellLex,
  parse: serializeShellParse,
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

function expandNpmrcEnvironment(value, providedEnvironment) {
  const environment = { ...(globalThis.process?.env ?? {}), ...(providedEnvironment ?? {}) };
  return String(value).replace(/\$\{([^{}]+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(environment, name) ? String(environment[name] ?? "") : match
  );
}

function npmrcRegistryOptionMatches(registryPart, registryUrl) {
  try {
    const parsed = new URL(registryUrl);
    const configuredPath = String(registryPart).replace(/^\/+|\/+$/g, "");
    const registryPath = `${parsed.host}${parsed.pathname}`.replace(/^\/+|\/+$/g, "");
    return configuredPath === registryPath;
  } catch {
    return false;
  }
}

function loadNpmrc(source, providedEnvironment) {
  const entries = [];
  for (const rawLine of String(source).replace(/^\ufeff/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const equals = line.indexOf("=");
    const key = (equals < 0 ? line : line.slice(0, equals)).trim();
    const rawValue = equals < 0 ? "true" : line.slice(equals + 1).trim();
    entries.push([key, expandNpmrcEnvironment(rawValue, providedEnvironment)]);
  }

  let defaultRegistryUrl = "https://registry.npmjs.org/";
  for (const [key, value] of entries) {
    if (key === "registry") defaultRegistryUrl = value.endsWith("/") ? value : `${value}/`;
  }

  const result = {
    default_registry_url: defaultRegistryUrl,
    default_registry_token: "",
    default_registry_username: "",
    default_registry_password: "",
    default_registry_email: "",
  };
  for (const [key, value] of entries) {
    const match = /^\/\/(.+):(_authToken|username|_password|_auth|email)$/.exec(key);
    if (!match || !npmrcRegistryOptionMatches(match[1], defaultRegistryUrl)) continue;
    switch (match[2]) {
      case "_authToken":
        result.default_registry_token = value;
        break;
      case "username":
        result.default_registry_username = value;
        break;
      case "_password":
        result.default_registry_password = Buffer.from(value, "base64").toString();
        break;
      case "_auth": {
        const decoded = Buffer.from(value, "base64").toString();
        const colon = decoded.indexOf(":");
        if (colon >= 0) {
          result.default_registry_username = decoded.slice(0, colon);
          result.default_registry_password = decoded.slice(colon + 1);
        }
        break;
      }
      case "email":
        result.default_registry_email = value;
        break;
    }
  }
  return result;
}

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
  loadNpmrc,
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
  if (typeof cottontail.socketPair !== "function") {
    throw new Error("socketpair is unavailable in this Cottontail build");
  }
  return cottontail.socketPair();
}

export function canonicalizeIP(value) {
  const text = String(value).trim();
  const v4 = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return "";
    return octets.join(".");
  }
  if (!text.includes(":")) return "";

  let head = text;
  let tail = null;
  const compression = text.indexOf("::");
  if (compression !== -1) {
    if (text.indexOf("::", compression + 1) !== -1) return "";
    head = text.slice(0, compression);
    tail = text.slice(compression + 2);
  }
  const parseSide = (part, allowV4AtEnd) => {
    if (part === "") return [];
    const out = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        out.push(parseInt(piece, 16));
        continue;
      }
      if (allowV4AtEnd && i === pieces.length - 1 && /^\d{1,3}(\.\d{1,3}){3}$/.test(piece)) {
        const octets = piece.split(".").map(Number);
        if (octets.some((octet) => octet > 255)) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
        continue;
      }
      return null;
    }
    return out;
  };
  const headGroups = parseSide(head, tail === null);
  const tailGroups = tail === null ? [] : parseSide(tail, true);
  if (headGroups === null || tailGroups === null) return "";
  let groups;
  if (tail === null) {
    groups = headGroups;
  } else {
    const missing = 8 - headGroups.length - tailGroups.length;
    if (missing < 1) return "";
    groups = headGroups.concat(new Array(missing).fill(0), tailGroups);
  }
  if (groups.length !== 8) return "";

  // IPv4-mapped addresses render with the dotted quad.
  if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
    return `::ffff:${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  }

  // RFC 5952: compress the longest run of two or more zero groups.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i < 8; i += 1) {
    if (groups[i] === 0) {
      if (runStart === -1) runStart = i;
      const length = i - runStart + 1;
      if (length > bestLength) {
        bestStart = runStart;
        bestLength = length;
      }
    } else {
      runStart = -1;
    }
  }
  const hex = groups.map((group) => group.toString(16));
  if (bestLength >= 2) {
    return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
  }
  return hex.join(":");
}

export function isArchitectureMatch(architectures) {
  const list = Array.isArray(architectures) ? architectures : [architectures];
  const current = cottontail.arch?.() ?? "arm64";
  let matched = list.length === 0;
  for (const entry of list.map(String)) {
    if (entry.startsWith("!")) {
      if (entry.slice(1) === current) return false;
      matched = true;
    } else if (entry === current || entry === "any") {
      matched = true;
    }
  }
  return matched;
}

export function isOperatingSystemMatch(platforms) {
  const list = Array.isArray(platforms) ? platforms : [platforms];
  const current = cottontail.platform?.() ?? "darwin";
  let matched = list.length === 0;
  for (const entry of list.map(String)) {
    if (entry.startsWith("!")) {
      if (entry.slice(1) === current) return false;
      matched = true;
    } else if (entry === current || entry === "any") {
      matched = true;
    }
  }
  return matched;
}

export function escapePowershell(value) {
  // Backtick is PowerShell's escape character: escape backticks first, then
  // double quotes (matches Bun's shell escapePowershell).
  return String(value).replace(/`/g, "``").replace(/"/g, '`"');
}

// Ring-buffer double-ended queue matching Bun's internal Dequeue (denque
// derived): power-of-two backing list starting at capacity 4, exposed via
// _list/_head/_tail/_capacityMask like the upstream implementation.
export class Dequeue {
  constructor() {
    this._head = 0;
    this._tail = 0;
    this._capacityMask = 3;
    this._list = new Array(4);
  }
  size() {
    if (this._head === this._tail) return 0;
    if (this._head < this._tail) return this._tail - this._head;
    return this._capacityMask + 1 - (this._head - this._tail);
  }
  isEmpty() { return this.size() === 0; }
  isNotEmpty() { return this.size() > 0; }
  push(item) {
    const tail = this._tail;
    this._list[tail] = item;
    this._tail = (tail + 1) & this._capacityMask;
    if (this._tail === this._head) this._growArray();
  }
  shift() {
    const head = this._head;
    if (head === this._tail) return undefined;
    const item = this._list[head];
    this._list[head] = undefined;
    this._head = (head + 1) & this._capacityMask;
    if (head < 2 && this._tail > 10000 && this._tail <= this._list.length >>> 2) this._shrinkArray();
    return item;
  }
  peek() {
    if (this._head === this._tail) return undefined;
    return this._list[this._head];
  }
  toArray(fullCopy) { return this._copyArray(fullCopy); }
  clear() {
    this._head = 0;
    this._tail = 0;
  }
  _copyArray(fullCopy) {
    const newArray = [];
    const list = this._list;
    const len = list.length;
    let i;
    if (fullCopy || this._head > this._tail) {
      for (i = this._head; i < len; i++) newArray.push(list[i]);
      for (i = 0; i < this._tail; i++) newArray.push(list[i]);
    } else {
      for (i = this._head; i < this._tail; i++) newArray.push(list[i]);
    }
    return newArray;
  }
  _growArray() {
    if (this._head) {
      this._list = this._copyArray(true);
      this._head = 0;
    }
    this._tail = this._list.length;
    this._list.length *= 2;
    this._capacityMask = (this._capacityMask << 1) | 1;
  }
  _shrinkArray() {
    this._list.length >>>= 1;
    this._capacityMask >>>= 1;
  }
}

export function getDevServerDeinitCount() {
  return getBakeDevServerDeinitCount();
}

export function memfd_create() {
  const error = new Error("memfd_create is only available on Linux");
  error.code = "ENOSYS";
  throw error;
}

export function setSyntheticAllocationLimitForTesting(limit) {
  const previous = globalThis.__cottontailSyntheticAllocationLimit ?? 0x7fffffff;
  globalThis.__cottontailSyntheticAllocationLimit = Number(limit) || 0x7fffffff;
  return previous;
}

// Calls `callback` through a builtin so that a "[native code]" frame sits
// between the callback and this function in captured stack traces, mirroring
// Bun's native nativeFrameForTesting helper (used by capture-stack-trace tests
// to assert CallSite.prototype.isNative()).
export function nativeFrameForTesting(callback) {
  // `callback` is invoked directly by Array.prototype.map so the frame right
  // above it in the stack is the builtin ("map@[native code]").
  return [void 0].map(callback)[0];
}

function isBunFile(value) {
  return value != null &&
    typeof globalThis.Blob === "function" &&
    value instanceof globalThis.Blob &&
    typeof value.exists === "function" &&
    typeof value.writer === "function";
}

function isCloneOnlyPlatformObject(value) {
  return isBunFile(value) || value instanceof BlockList;
}

function replaceCloneOnlyPlatformObjects(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (isCloneOnlyPlatformObject(value)) return {};
  if (seen.has(value)) return seen.get(value);
  seen.set(value, value);

  if (value instanceof Map) {
    const entries = [...value];
    value.clear();
    for (const [key, entryValue] of entries) {
      value.set(
        replaceCloneOnlyPlatformObjects(key, seen),
        replaceCloneOnlyPlatformObjects(entryValue, seen),
      );
    }
    return value;
  }

  if (value instanceof Set) {
    const entries = [...value];
    value.clear();
    for (const entry of entries) value.add(replaceCloneOnlyPlatformObjects(entry, seen));
    return value;
  }

  for (const key of Object.keys(value)) {
    value[key] = replaceCloneOnlyPlatformObjects(value[key], seen);
  }
  return value;
}

export function structuredCloneAdvanced(
  value,
  transferList = [],
  isForTransfer = false,
  isForStorage = false,
  _context = "default",
) {
  const transfers = transferList == null ? [] : [...transferList];
  if (transfers.some(isCloneOnlyPlatformObject)) {
    const DOMExceptionClass = globalThis.DOMException ?? Error;
    throw new DOMExceptionClass("The object can not be cloned.", "DataCloneError");
  }

  const cloned = globalThis.structuredClone(
    value,
    transfers.length > 0 ? { transfer: transfers } : undefined,
  );
  return isForTransfer || isForStorage
    ? replaceCloneOnlyPlatformObjects(cloned)
    : cloned;
}

export function getEventLoopStats() {
  const { activeTasks, concurrentRef, numPolls } = cottontail.runtimeDiagnostics().eventLoop;
  return { activeTasks, concurrentRef, numPolls };
}
export const install_test_helpers = {
  parseLockfile(cwd) {
    return JSON.parse(cottontail.packageManagerParseLockfile(String(cwd)));
  },
};
export const npm_manifest_test_helpers = {
  parseManifest(path, _registryUrl) {
    const manifest = JSON.parse(readFileSync(String(path), "utf8"));
    return {
      ...manifest,
      versions: Object.values(manifest.versions ?? {}),
    };
  },
};
export const upgrade_test_helpers = Object.freeze({
  openTempDirWithoutSharingDelete() {
    cottontail.upgradeOpenTempDirectory();
  },
  closeTempDirHandle() {
    cottontail.upgradeCloseTempDirectory();
  },
});

export const crash_handler = Object.freeze({
  getMachOImageZeroOffset() {
    return cottontail.machoImageZeroOffset();
  },
  segfault() {
    cottontail.internalCrash("segfault");
  },
  panic() {
    cottontail.internalCrash("panic");
  },
  rootError() {
    cottontail.internalCrash("rootError");
  },
  outOfMemory() {
    cottontail.internalCrash("outOfMemory");
  },
  raiseIgnoringPanicHandler() {
    cottontail.internalCrash("raiseIgnoringPanicHandler");
  },
});

function toWebIdlInt32(value) {
  const number = +value;
  if (!Number.isFinite(number) || number === 0) return 0;
  return Math.trunc(number) | 0;
}

function toWebIdlUint8(value) {
  const number = +value;
  if (!Number.isFinite(number) || number === 0) return 0;
  const integer = Math.trunc(number);
  return ((integer % 256) + 256) % 256;
}

function toWebIdlUsize(value) {
  const number = +value;
  if (!Number.isFinite(number) || number === 0) return 0n;
  return BigInt.asUintN(64, BigInt(Math.trunc(number)));
}

function enforceBindgenRange(value, minimum, maximum) {
  const number = +value;
  if (!Number.isFinite(number)) {
    throw new TypeError(`Value ${number} is outside the range [${minimum}, ${maximum}]`);
  }
  const integer = Math.trunc(number);
  if (integer < minimum || integer > maximum) {
    throw new TypeError(`Value ${integer} is outside the range [${minimum}, ${maximum}]`);
  }
  return integer;
}

export const bindgen = Object.freeze({
  add(a, b = -1) {
    const left = toWebIdlInt32(a);
    const right = toWebIdlInt32(b === null ? -1 : b);
    const sum = left + right;
    if (sum < -2147483648 || sum > 2147483647) {
      throw new Error("Integer overflow while adding");
    }
    return sum;
  },
  requiredAndOptionalArg(a, b = null, c = 42, d = null) {
    if (b === undefined) b = null;
    if (c === null || c === undefined) c = 42;
    if (d === undefined) d = null;
    const convertedC = enforceBindgenRange(c, 0, 100);
    const convertedD = d === null ? null : toWebIdlUint8(d);
    if (b === null) {
      return (123456 + convertedC + (convertedD ?? 0)) | 0;
    }

    const convertedB = toWebIdlUsize(b);
    const product = BigInt.asUintN(
      64,
      BigInt.asUintN(64, convertedB + BigInt(Math.abs(convertedC))) * BigInt(convertedD ?? 1),
    );
    let result = Number(BigInt.asIntN(32, BigInt.asUintN(53, product)));
    if (Boolean(a)) result = Number(BigInt.asIntN(32, -BigInt(result)));
    return result;
  },
});

export function noOpForTesting() {}

export const timerInternals = Object.freeze({
  timerClockMs() {
    return cottontail.timerClockMs();
  },
});
export { frameworkRouterInternals };
export const hostedGitInfo = {
  parseUrl(value) {
    if (arguments.length !== 1) {
      throw new Error("hostedGitInfo.prototype.parseUrl takes exactly 1 argument");
    }
    if (typeof value !== "string") {
      throw new Error("hostedGitInfo.prototype.parseUrl takes a string as its first argument");
    }
    return cottontail.hostedGitInfoParseUrl(value);
  },
  fromUrl(value) {
    if (arguments.length !== 1) {
      throw new Error("hostedGitInfo.prototype.fromUrl takes exactly 1 argument");
    }
    if (typeof value !== "string") {
      throw new Error("hostedGitInfo.prototype.fromUrl takes a string as its first argument");
    }
    const result = cottontail.hostedGitInfoFromUrl(value);
    return result === null ? null : JSON.parse(result);
  },
};
function tarString(bytes, start, length) {
  let end = start;
  const limit = Math.min(bytes.length, start + length);
  while (end < limit && bytes[end] !== 0) end++;
  return Buffer.from(bytes.subarray(start, end)).toString("utf8");
}

function tarNumber(bytes, start, length) {
  const field = bytes.subarray(start, start + length);
  if (field.length === 0) return 0;

  // POSIX tar numbers are octal. GNU tar uses base-256 for values that do not
  // fit in the fixed-width octal field.
  if ((field[0] & 0x80) !== 0) {
    let value = BigInt(field[0] & 0x7f);
    for (let i = 1; i < field.length; i++) value = (value << 8n) | BigInt(field[i]);
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError("tar entry number exceeds JavaScript's safe integer range");
    return number;
  }

  const text = Buffer.from(field).toString("ascii").replace(/\0.*$/, "").trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) throw new Error(`invalid tar numeric field: ${JSON.stringify(text)}`);
  return value;
}

function parsePaxRecords(bytes) {
  const records = Object.create(null);
  let offset = 0;
  while (offset < bytes.length) {
    const separator = bytes.indexOf(0x20, offset);
    if (separator < 0) break;
    const length = Number.parseInt(Buffer.from(bytes.subarray(offset, separator)).toString("ascii"), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > bytes.length) break;
    const record = Buffer.from(bytes.subarray(separator + 1, offset + length - 1)).toString("utf8");
    const equals = record.indexOf("=");
    if (equals >= 0) records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

function tarKind(type) {
  switch (type) {
    case 0:
    case 0x30:
    case 0x37:
      return "file";
    case 0x31:
      return "file";
    case 0x32:
      return "sym_link";
    case 0x33:
      return "character_device";
    case 0x34:
      return "block_device";
    case 0x35:
      return "directory";
    case 0x36:
      return "named_pipe";
    default:
      return "unknown";
  }
}

export function readTarball(tarballPath) {
  if (typeof tarballPath !== "string") throw new TypeError("expected tarball path string argument");

  const compressed = readFileSync(tarballPath);
  const archive = gunzipSync(compressed);
  const entries = [];
  let offset = 0;
  let globalPax = Object.create(null);
  let nextPax = null;
  let nextLongPath = null;

  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    offset += 512;

    let allZero = true;
    for (let i = 0; i < header.length; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) continue;

    const size = tarNumber(header, 124, 12);
    if (size < 0 || offset + size > archive.length) throw new Error("tar entry extends beyond the archive");
    const contents = archive.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    const type = header[156];
    if (type === 0x67 || type === 0x78) {
      const records = parsePaxRecords(contents);
      if (type === 0x67) globalPax = { ...globalPax, ...records };
      else nextPax = records;
      continue;
    }
    if (type === 0x4c) {
      nextLongPath = Buffer.from(contents).toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (type === 0x4b) continue;

    const pax = nextPax === null ? globalPax : { ...globalPax, ...nextPax };
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const pathname = pax.path ?? nextLongPath ?? (prefix ? `${prefix}/${name}` : name);
    const kind = tarKind(type);
    const entry = {
      pathname,
      kind,
      perm: tarNumber(header, 100, 8),
    };
    if (kind === "file") entry.contents = Buffer.from(contents).toString("utf8");
    entries.push(entry);
    nextPax = null;
    nextLongPath = null;
  }

  return {
    entries,
    size: compressed.length,
    shasum: createHash("sha1").update(compressed).digest("hex"),
    integrity: createHash("sha512").update(compressed).digest("base64"),
  };
}

export default {
  Dequeue,
  bindgen,
  getEventLoopStats,
  canonicalizeIP,
  crash_handler,
  createSocketPair,
  cssInternals,
  decodeURIComponentSIMD,
  escapePowershell,
  escapeRegExp,
  escapeRegExpForPackageNameMatching,
  frameworkRouterInternals,
  getDevServerDeinitCount,
  hasNonReifiedStatic,
  highlightJavaScript,
  hostedGitInfo,
  iniInternals,
  install_test_helpers,
  isArchitectureMatch,
  isModuleResolveFilenameSlowPathEnabled,
  isOperatingSystemMatch,
  jscInternals,
  nativeFrameForTesting,
  npm_manifest_test_helpers,
  noOpForTesting,
  patchInternals,
  readTarball,
  setSocketOptions,
  setSyntheticAllocationLimitForTesting,
  shellInternals,
  structuredCloneAdvanced,
  timerInternals,
  upgrade_test_helpers,
};
