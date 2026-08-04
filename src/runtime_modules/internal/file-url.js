import { toASCII, toUnicode } from "../node/punycode.js";
import { URL, createFileURLFromPath } from "../vendor/whatwg-url.js";

const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_DOT = 46;
const CHAR_COLON = 58;
const CHAR_UPPERCASE_A = 65;
const CHAR_UPPERCASE_Z = 90;
const CHAR_LOWERCASE_A = 97;
const CHAR_LOWERCASE_Z = 122;

const backslashRegEx = /\\/g;
const hashRegEx = /#/g;
const questionMarkRegEx = /\?/g;
const tildeRegEx = /~/g;
const pathNeedsEscapingRegEx = /[\u0000-\u0020"#%<>?\[\\\]\^`{|}~\u007F-\uFFFF]/;

function validateString(value, name) {
  if (typeof value !== "string") {
    const received = value === null ? "null" : `type ${typeof value}`;
    const error = new TypeError(`The "${name}" argument must be of type string. Received ${received}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
}

function invalidArgTypeError(name, expected, actual) {
  const received = actual === null ? "null" : `type ${typeof actual}`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function isPathSeparator(code) {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

function isWindowsDeviceRoot(code) {
  return (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) ||
    (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z);
}

function normalizePath(path, allowAboveRoot, separator, isSeparator) {
  let result = "";
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let index = 0; index <= path.length; index += 1) {
    if (index < path.length) code = path.charCodeAt(index);
    else if (isSeparator(code)) break;
    else code = CHAR_FORWARD_SLASH;

    if (isSeparator(code)) {
      if (lastSlash === index - 1 || dots === 1) {
        // Repeated separators and single-dot segments are discarded.
      } else if (dots === 2) {
        if (
          result.length < 2 ||
          lastSegmentLength !== 2 ||
          result.charCodeAt(result.length - 1) !== CHAR_DOT ||
          result.charCodeAt(result.length - 2) !== CHAR_DOT
        ) {
          if (result.length > 2) {
            const lastSlashIndex = result.lastIndexOf(separator);
            if (lastSlashIndex === -1) {
              result = "";
              lastSegmentLength = 0;
            } else {
              result = result.slice(0, lastSlashIndex);
              lastSegmentLength = result.length - 1 - result.lastIndexOf(separator);
            }
            lastSlash = index;
            dots = 0;
            continue;
          }
          if (result.length !== 0) {
            result = "";
            lastSegmentLength = 0;
            lastSlash = index;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          result += result.length > 0 ? `${separator}..` : "..";
          lastSegmentLength = 2;
        }
      } else {
        const segment = path.slice(lastSlash + 1, index);
        result += result.length > 0 ? `${separator}${segment}` : segment;
        lastSegmentLength = index - lastSlash - 1;
      }
      lastSlash = index;
      dots = 0;
    } else if (code === CHAR_DOT && dots !== -1) {
      dots += 1;
    } else {
      dots = -1;
    }
  }
  return result;
}

function runtimeCwd() {
  return globalThis.process?.cwd?.() ?? globalThis.cottontail.cwd();
}

function resolvePosixPath(path) {
  let resolvedPath = "";
  let resolvedAbsolute = false;
  const inputs = [runtimeCwd(), path];
  for (let index = inputs.length - 1; index >= 0 && !resolvedAbsolute; index -= 1) {
    const input = inputs[index];
    if (input.length === 0) continue;
    resolvedPath = `${input}/${resolvedPath}`;
    resolvedAbsolute = input.charCodeAt(0) === CHAR_FORWARD_SLASH;
  }
  resolvedPath = normalizePath(
    resolvedPath,
    !resolvedAbsolute,
    "/",
    code => code === CHAR_FORWARD_SLASH,
  );
  if (resolvedAbsolute) return `/${resolvedPath}`;
  return resolvedPath.length > 0 ? resolvedPath : ".";
}

function windowsCwd() {
  return runtimeCwd().replace(/\//g, "\\");
}

function resolveWindowsPath(path) {
  let resolvedDevice = "";
  let resolvedTail = "";
  let resolvedAbsolute = false;

  for (let index = 0; index >= -1; index -= 1) {
    let input;
    if (index === 0) {
      input = path;
      if (input.length === 0) continue;
    } else if (resolvedDevice.length === 0) {
      input = windowsCwd();
    } else {
      input = windowsCwd();
      if (
        input.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
        input.charCodeAt(2) === CHAR_BACKWARD_SLASH
      ) {
        input = `${resolvedDevice}\\`;
      }
    }

    const length = input.length;
    let rootEnd = 0;
    let device = "";
    let absolute = false;
    const first = input.charCodeAt(0);

    if (length === 1) {
      if (isPathSeparator(first)) {
        rootEnd = 1;
        absolute = true;
      }
    } else if (isPathSeparator(first)) {
      absolute = true;
      if (isPathSeparator(input.charCodeAt(1))) {
        let cursor = 2;
        let last = cursor;
        while (cursor < length && !isPathSeparator(input.charCodeAt(cursor))) cursor += 1;
        if (cursor < length && cursor !== last) {
          const firstPart = input.slice(last, cursor);
          last = cursor;
          while (cursor < length && isPathSeparator(input.charCodeAt(cursor))) cursor += 1;
          if (cursor < length && cursor !== last) {
            last = cursor;
            while (cursor < length && !isPathSeparator(input.charCodeAt(cursor))) cursor += 1;
            if (cursor === length || cursor !== last) {
              if (firstPart !== "." && firstPart !== "?") {
                device = `\\\\${firstPart}\\${input.slice(last, cursor)}`;
                rootEnd = cursor;
              } else {
                device = `\\\\${firstPart}`;
                rootEnd = 4;
              }
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else if (isWindowsDeviceRoot(first) && input.charCodeAt(1) === CHAR_COLON) {
      device = input.slice(0, 2);
      rootEnd = 2;
      if (length > 2 && isPathSeparator(input.charCodeAt(2))) {
        absolute = true;
        rootEnd = 3;
      }
    }

    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
      } else {
        resolvedDevice = device;
      }
    }

    if (resolvedAbsolute) {
      if (resolvedDevice.length > 0) break;
    } else {
      resolvedTail = `${input.slice(rootEnd)}\\${resolvedTail}`;
      resolvedAbsolute = absolute;
      if (absolute && resolvedDevice.length > 0) break;
    }
  }

  resolvedTail = normalizePath(resolvedTail, !resolvedAbsolute, "\\", isPathSeparator);
  if (resolvedAbsolute) return `${resolvedDevice}\\${resolvedTail}`;
  return `${resolvedDevice}${resolvedTail}` || ".";
}

function encodePathChars(filepath) {
  if (!pathNeedsEscapingRegEx.test(filepath)) return filepath;
  const wellFormed = typeof filepath.toWellFormed === "function" ? filepath.toWellFormed() : filepath;
  return encodeURI(wellFormed)
    .replace(hashRegEx, "%23")
    .replace(questionMarkRegEx, "%3F")
    .replace(tildeRegEx, "%7E");
}

let lastFilePathInput;
let lastFilePathCwd;
let lastResolvedFilePath;

function resolvePathForFileURL(filepath) {
  if (filepath.length > 0 && filepath !== "." && filepath !== ".." && filepath.indexOf("/") === -1) {
    const cwd = runtimeCwd();
    if (filepath === lastFilePathInput && cwd === lastFilePathCwd) return lastResolvedFilePath;
    const resolved = cwd.endsWith("/") ? `${cwd}${filepath}` : `${cwd}/${filepath}`;
    lastFilePathInput = filepath;
    lastFilePathCwd = cwd;
    lastResolvedFilePath = resolved;
    return resolved;
  }
  return resolvePosixPath(filepath);
}

export function pathToFileURL(filepath, options = undefined) {
  validateString(filepath, "path");
  const windows = options?.windows ?? globalThis.process?.platform === "win32";
  let sourcePath = filepath;
  if (windows && /^\\\\\?\\[A-Za-z]:[\\/]/.test(sourcePath)) {
    sourcePath = sourcePath.slice(4);
  } else if (windows && sourcePath.toUpperCase().startsWith("\\\\?\\UNC\\")) {
    sourcePath = `\\\\${sourcePath.slice(8)}`;
  }
  const isUNC = windows && sourcePath.startsWith("\\\\");
  let resolved = windows ? resolveWindowsPath(sourcePath) : resolvePathForFileURL(sourcePath);
  if (isUNC && /^\\\\[^\\]+\\[^\\]+$/.test(sourcePath) && resolved.endsWith("\\")) {
    resolved = resolved.slice(0, -1);
  }
  if (isUNC || (windows && resolved.startsWith("\\\\"))) {
    const extended = resolved.toUpperCase().startsWith("\\\\?\\UNC\\");
    const prefixLength = extended ? 8 : 2;
    const hostnameEndIndex = resolved.indexOf("\\", prefixLength);
    if (hostnameEndIndex === -1 || hostnameEndIndex === prefixLength) {
      const error = new TypeError(`The argument 'path' must be an absolute path. Received ${JSON.stringify(filepath)}`);
      error.code = "ERR_INVALID_ARG_VALUE";
      throw error;
    }
    const hostname = toASCII(resolved.slice(prefixLength, hostnameEndIndex));
    const pathname = encodePathChars(resolved.slice(hostnameEndIndex).replace(backslashRegEx, "/"));
    return createFileURLFromPath(pathname, hostname);
  }
  if (windows) {
    resolved = resolved.replace(backslashRegEx, "/");
    if (/^[A-Za-z]:\//.test(resolved)) resolved = `/${resolved}`;
    const last = filepath.charCodeAt(filepath.length - 1);
    if ((last === CHAR_FORWARD_SLASH || last === CHAR_BACKWARD_SLASH) && !resolved.endsWith("/")) {
      resolved += "/";
    }
  } else {
    const last = filepath.charCodeAt(filepath.length - 1);
    if (last === CHAR_FORWARD_SLASH && !resolved.endsWith("/")) resolved += "/";
  }
  return createFileURLFromPath(encodePathChars(resolved));
}

function invalidFileUrlPathError(suffix) {
  const error = new TypeError(`File URL path ${suffix}`);
  error.code = "ERR_INVALID_FILE_URL_PATH";
  return error;
}

function getPathFromURLPosix(url) {
  if (url.hostname !== "") {
    const platform = globalThis.process?.platform ?? "darwin";
    const error = new TypeError(`File URL host must be "localhost" or empty on ${platform}`);
    error.code = "ERR_INVALID_FILE_URL_HOST";
    throw error;
  }
  const pathname = url.pathname;
  for (let index = 0; index < pathname.length; index += 1) {
    if (pathname[index] === "%") {
      const third = pathname.codePointAt(index + 2) | 0x20;
      if (pathname[index + 1] === "2" && third === 102) {
        throw invalidFileUrlPathError("must not include encoded / characters");
      }
    }
  }
  return decodeURIComponent(pathname);
}

function getPathFromURLWin32(url) {
  const hostname = url.hostname;
  let pathname = url.pathname;
  for (let index = 0; index < pathname.length; index += 1) {
    if (pathname[index] === "%") {
      const third = pathname.codePointAt(index + 2) | 0x20;
      if (
        (pathname[index + 1] === "2" && third === 102) ||
        (pathname[index + 1] === "5" && third === 99)
      ) {
        throw invalidFileUrlPathError("must not include encoded \\ or / characters");
      }
    }
  }
  pathname = decodeURIComponent(pathname.replace(/\//g, "\\"));
  if (hostname !== "") return `\\\\${toUnicode(hostname)}${pathname}`;
  const letter = pathname.codePointAt(1) | 0x20;
  if (letter < 0x61 || letter > 0x7a || pathname[2] !== ":") {
    throw invalidFileUrlPathError("must be absolute");
  }
  return pathname.slice(1);
}

export function fileURLToPath(path, options = undefined) {
  const windows = options?.windows ?? globalThis.process?.platform === "win32";
  if (typeof path === "string") {
    if (/^file:\/\/[A-Za-z]:[\\/]/.test(path)) path = `file:///${path.slice("file://".length)}`;
    path = new URL(path);
  } else if (
    path === null ||
    typeof path !== "object" ||
    typeof path.href !== "string" ||
    typeof path.protocol !== "string"
  ) {
    throw invalidArgTypeError("path", "string or an instance of URL", path);
  } else if (!(path instanceof URL)) {
    path = new URL(path.href);
  }
  if (path.protocol !== "file:") {
    const error = new TypeError("The URL must be of scheme file");
    error.code = "ERR_INVALID_URL_SCHEME";
    throw error;
  }
  return windows ? getPathFromURLWin32(path) : getPathFromURLPosix(path);
}
