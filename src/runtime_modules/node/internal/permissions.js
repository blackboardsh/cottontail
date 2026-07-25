import { isAbsolute, resolve, toNamespacedPath } from "../path.js";

const permissionStateKey = Symbol.for("cottontail.node.permissionState");
const windows = cottontail.platform?.() === "win32";
const separator = windows ? "\\" : "/";

function invalidArgType(name, expected, value) {
  let received;
  if (value === null) received = "null";
  else if (value === undefined) received = "undefined";
  else if (typeof value === "object") received = `an instance of ${value?.constructor?.name || "Object"}`;
  else received = `type ${typeof value} (${String(value)})`;
  const error = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${received}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function tokenizeNodeOptions(source) {
  const args = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const character of String(source || "")) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote === '"') {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = "";
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += "\\";
  if (current) args.push(current);
  return args;
}

function permissionArguments() {
  const cli = Array.from(globalThis.process?.execArgv ?? cottontail.execArgv ?? [], String);
  if (cli.some((argument) => argument === "--permission" || argument === "--experimental-permission")) {
    return cli;
  }
  const nodeOptions = globalThis.process?.env?.NODE_OPTIONS ?? cottontail.env?.()?.NODE_OPTIONS;
  return [...tokenizeNodeOptions(nodeOptions), ...cli];
}

function removeWindowsNamespace(path) {
  if (!windows) return path;
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[A-Za-z]:\\/i.test(path)) return path.slice(4);
  if (/^\\\?\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\?\?\\[A-Za-z]:\\/i.test(path)) return path.slice(4);
  return path;
}

function normalizeWindowsSeparators(path) {
  if (!windows) return path;
  const namespaceless = removeWindowsNamespace(String(path).replace(/\//g, "\\"));
  if (namespaceless.startsWith("\\\\")) {
    return `\\\\${namespaceless.slice(2).replace(/\\+/g, "\\")}`;
  }
  return namespaceless.replace(/\\+/g, "\\");
}

function canonicalPath(path) {
  let text = normalizeWindowsSeparators(String(path));
  text = resolve(text);
  text = normalizeWindowsSeparators(text);
  if (windows) text = text.toLowerCase();
  const parsedRoot = windows
    ? (/^[a-z]:\\/.exec(text)?.[0] ?? /^\\\\[^\\]+\\[^\\]+\\?/.exec(text)?.[0] ?? "")
    : "/";
  while (text.length > parsedRoot.length && text.endsWith(separator)) text = text.slice(0, -1);
  return text;
}

function makePathGrant(value) {
  const original = String(value);
  if (original === "*") return { all: true };
  const wildcard = original.endsWith("*");
  const pathValue = wildcard ? original.slice(0, -1) : original;
  const separatorWildcard = wildcard && /[\\/]$/.test(pathValue);
  const path = canonicalPath(pathValue || ".");
  let directory = false;
  if (!wildcard) {
    try {
      directory = Boolean(cottontail.statSync?.(path, true)?.isDirectory);
    } catch {}
  }
  return {
    all: false,
    wildcard,
    separatorWildcard,
    directory,
    path,
  };
}

function pathMatches(grant, reference) {
  if (grant.all) return true;
  const path = canonicalPath(reference);
  if (grant.wildcard && !grant.separatorWildcard) return path.startsWith(grant.path);
  if (!grant.wildcard && !grant.directory) return path === grant.path;
  const descendantPrefix = grant.path.endsWith(separator) ? grant.path : `${grant.path}${separator}`;
  return path === grant.path || path.startsWith(descendantPrefix);
}

function readFlag(args, index, name) {
  const argument = args[index];
  const prefix = `${name}=`;
  if (argument.startsWith(prefix)) return { value: argument.slice(prefix.length), consumed: 0 };
  if (argument === name && index + 1 < args.length) return { value: args[index + 1], consumed: 1 };
  return null;
}

function parsePermissionState() {
  const args = permissionArguments();
  const enabled = args.some((argument) => argument === "--permission" || argument === "--experimental-permission");
  const grants = {
    "fs.read": [],
    "fs.write": [],
  };
  const simple = new Set();
  if (enabled) {
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      let parsed = readFlag(args, index, "--allow-fs-read");
      if (parsed) {
        grants["fs.read"].push(makePathGrant(parsed.value));
        index += parsed.consumed;
        continue;
      }
      parsed = readFlag(args, index, "--allow-fs-write");
      if (parsed) {
        grants["fs.write"].push(makePathGrant(parsed.value));
        index += parsed.consumed;
        continue;
      }
      if (argument === "--allow-child-process") simple.add("child");
      else if (argument === "--allow-worker") simple.add("worker");
      else if (argument === "--allow-addons") simple.add("addon");
      else if (argument === "--allow-wasi") simple.add("wasi");
      else if (argument === "--allow-inspector") simple.add("inspector");
    }
    const main = globalThis.process?.argv?.[1];
    if (typeof main === "string" && main && main !== "-") grants["fs.read"].push(makePathGrant(main));
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      for (const flag of ["-r", "--require", "--import", "--loader", "--experimental-loader"]) {
        const parsed = readFlag(args, index, flag);
        if (parsed) {
          if (!String(parsed.value).startsWith("node:")) grants["fs.read"].push(makePathGrant(parsed.value));
          index += parsed.consumed;
          break;
        }
      }
    }
  }
  return { enabled, grants, simple };
}

export function permissionState() {
  return globalThis[permissionStateKey] ??= parsePermissionState();
}

export function permissionsEnabled() {
  return permissionState().enabled;
}

export function hasPermission(scope, reference = undefined) {
  if (typeof scope !== "string") throw invalidArgType("scope", "string", scope);
  const state = permissionState();
  if (!state.enabled) return true;
  if (scope === "fs") return false;
  const grants = state.grants[scope];
  if (grants) {
    if (reference === undefined) return grants.some((grant) => grant.all);
    if (typeof reference !== "string") throw invalidArgType("reference", "string", reference);
    return grants.some((grant) => pathMatches(grant, reference));
  }
  if (reference !== undefined && (scope === "fs.read" || scope === "fs.write") && typeof reference !== "string") {
    throw invalidArgType("reference", "string", reference);
  }
  return state.simple.has(scope);
}

function permissionName(scope) {
  if (scope === "fs.read") return "FileSystemRead";
  if (scope === "fs.write") return "FileSystemWrite";
  if (scope === "child") return "ChildProcess";
  if (scope === "worker") return "WorkerThreads";
  return scope;
}

function permissionFlag(scope) {
  if (scope === "fs.read") return "--allow-fs-read";
  if (scope === "fs.write") return "--allow-fs-write";
  if (scope === "child") return "--allow-child-process";
  if (scope === "worker") return "--allow-worker";
  return `--allow-${scope}`;
}

export function accessDenied(scope, resource) {
  const error = new Error(
    `Access to this API has been restricted. Use ${permissionFlag(scope)} to manage permissions.`,
  );
  error.code = "ERR_ACCESS_DENIED";
  error.permission = permissionName(scope);
  if (resource !== undefined) error.resource = resource;
  return error;
}

function errorResource(path) {
  const text = String(path);
  if (!windows || !isAbsolute(text)) return text;
  return toNamespacedPath(text);
}

export function assertPermission(scope, resource = undefined) {
  if (!permissionsEnabled()) return;
  if (!hasPermission(scope, resource)) throw accessDenied(scope, resource);
}

export function assertFsRead(path, resource = path) {
  const text = String(path);
  if (!hasPermission("fs.read", text)) throw accessDenied("fs.read", errorResource(resource));
}

export function assertFsWrite(path, resource = path) {
  const text = String(path);
  if (!hasPermission("fs.write", text)) throw accessDenied("fs.write", errorResource(resource));
}

export const permission = Object.freeze({
  has: hasPermission,
});
