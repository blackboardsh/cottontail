export function normalize(path) {
  const text = String(path || "");
  const absolute = text.startsWith("/");
  const parts = [];
  for (const part of text.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else {
      parts.push(part);
    }
  }
  const normalized = (absolute ? "/" : "") + parts.join("/");
  return normalized || ".";
}

export function join(...parts) {
  return normalize(parts.filter((part) => part !== "").join("/"));
}

export function isAbsolute(path) {
  return String(path || "").startsWith("/") || /^[A-Za-z]:[\\/]/.test(String(path || ""));
}

export function resolve(...parts) {
  let path = "";
  for (const part of parts) {
    if (!part) continue;
    path = String(part).startsWith("/") ? String(part) : join(path || cottontail.cwd(), String(part));
  }
  return normalize(path || cottontail.cwd());
}

export function dirname(path) {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized.startsWith("/") ? "/" : ".";
  return normalized.slice(0, index);
}

export function basename(path, suffix = undefined) {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  const base = index >= 0 ? normalized.slice(index + 1) : normalized;
  const suffixText = suffix == null ? "" : String(suffix);
  return suffixText && base.endsWith(suffixText) ? base.slice(0, -suffixText.length) : base;
}

export function extname(path) {
  const base = basename(path);
  const index = base.lastIndexOf(".");
  if (index <= 0) return "";
  return base.slice(index);
}

export function parse(path) {
  const dir = dirname(path);
  const base = basename(path);
  const ext = extname(base);
  const name = ext ? base.slice(0, -ext.length) : base;
  const root = String(path || "").startsWith("/") ? "/" : "";
  return { root, dir, base, ext, name };
}

export function format(pathObject = {}) {
  const dir = pathObject.dir || pathObject.root || "";
  const base = pathObject.base || `${pathObject.name || ""}${pathObject.ext || ""}`;
  if (!dir) return base;
  return dir.endsWith("/") ? `${dir}${base}` : `${dir}/${base}`;
}

export function relative(from, to) {
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return [...fromParts.map(() => ".."), ...toParts].join("/") || ".";
}

function escapeRegex(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

export function matchesGlob(path, pattern) {
  const source = String(pattern)
    .split("**").map((part) => part.split("*").map(escapeRegex).join("[^/]*")).join(".*")
    .replace(/\\\?/g, "[^/]");
  return new RegExp(`^${source}$`).test(String(path));
}

export function toNamespacedPath(path) {
  return String(path);
}

export const _makeLong = toNamespacedPath;
export const sep = cottontail.platform() === "win32" ? "\\" : "/";
export const delimiter = cottontail.platform() === "win32" ? ";" : ":";

function normalizeWin32(path) {
  const text = String(path || "").replace(/\//g, "\\");
  const match = text.match(/^([A-Za-z]:)?(\\+)?(.*)$/);
  const drive = match?.[1] || "";
  const absolute = Boolean(match?.[2]);
  const rest = match?.[3] || text;
  const parts = [];
  for (const part of rest.split("\\")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else {
      parts.push(part);
    }
  }
  const root = `${drive}${absolute ? "\\" : ""}`;
  const normalized = `${root}${parts.join("\\")}`;
  return normalized || ".";
}

function joinWin32(...parts) {
  return normalizeWin32(parts.filter((part) => part !== "").join("\\"));
}

function isAbsoluteWin32(path) {
  return /^(?:[A-Za-z]:)?[\\/]/.test(String(path || ""));
}

function resolveWin32(...parts) {
  let path = "";
  for (const part of parts) {
    if (!part) continue;
    const text = String(part);
    path = isAbsoluteWin32(text) ? text : joinWin32(path || cottontail.cwd().replace(/\//g, "\\"), text);
  }
  return normalizeWin32(path || cottontail.cwd().replace(/\//g, "\\"));
}

function dirnameWin32(path) {
  const normalized = normalizeWin32(path);
  const index = normalized.lastIndexOf("\\");
  if (index <= 0) return /^[A-Za-z]:\\?$/.test(normalized) ? normalized : ".";
  return normalized.slice(0, index);
}

function basenameWin32(path, suffix = undefined) {
  const normalized = normalizeWin32(path);
  const index = normalized.lastIndexOf("\\");
  const base = index >= 0 ? normalized.slice(index + 1) : normalized;
  const suffixText = suffix == null ? "" : String(suffix);
  return suffixText && base.endsWith(suffixText) ? base.slice(0, -suffixText.length) : base;
}

function extnameWin32(path) {
  const base = basenameWin32(path);
  const index = base.lastIndexOf(".");
  if (index <= 0) return "";
  return base.slice(index);
}

function parseWin32(path) {
  const text = String(path || "");
  const rootMatch = text.match(/^([A-Za-z]:)?[\\/]?/);
  const root = rootMatch?.[0] || "";
  const dir = dirnameWin32(path);
  const base = basenameWin32(path);
  const ext = extnameWin32(base);
  const name = ext ? base.slice(0, -ext.length) : base;
  return { root, dir, base, ext, name };
}

function formatWin32(pathObject = {}) {
  const dir = pathObject.dir || pathObject.root || "";
  const base = pathObject.base || `${pathObject.name || ""}${pathObject.ext || ""}`;
  if (!dir) return base;
  return /[\\/]$/.test(dir) ? `${dir}${base}` : `${dir}\\${base}`;
}

function relativeWin32(from, to) {
  const fromParts = resolveWin32(from).toLowerCase().split("\\").filter(Boolean);
  const toResolved = resolveWin32(to);
  const toParts = toResolved.toLowerCase().split("\\").filter(Boolean);
  const outputParts = toResolved.split("\\").filter(Boolean);
  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
    outputParts.shift();
  }
  return [...fromParts.map(() => ".."), ...outputParts].join("\\") || ".";
}

function toNamespacedPathWin32(path) {
  const text = String(path);
  if (text.startsWith("\\\\?\\")) return text;
  if (/^[A-Za-z]:\\/.test(text)) return `\\\\?\\${text}`;
  return text;
}

export const posix = {
  _makeLong,
  basename,
  delimiter: ":",
  dirname,
  extname,
  format,
  isAbsolute: (path) => String(path || "").startsWith("/"),
  join,
  matchesGlob,
  normalize,
  parse,
  posix: null,
  relative,
  resolve,
  sep: "/",
  toNamespacedPath,
  win32: null,
};

export const win32 = {
  _makeLong: toNamespacedPathWin32,
  basename: basenameWin32,
  delimiter: ";",
  dirname: dirnameWin32,
  extname: extnameWin32,
  format: formatWin32,
  isAbsolute: isAbsoluteWin32,
  join: joinWin32,
  matchesGlob: (path, pattern) => matchesGlob(String(path).replace(/\\/g, "/"), String(pattern).replace(/\\/g, "/")),
  normalize: normalizeWin32,
  parse: parseWin32,
  posix,
  relative: relativeWin32,
  resolve: resolveWin32,
  sep: "\\",
  toNamespacedPath: toNamespacedPathWin32,
  win32: null,
};

posix.posix = posix;
posix.win32 = win32;
win32.win32 = win32;

const active = cottontail.platform() === "win32" ? win32 : posix;

export default active;
