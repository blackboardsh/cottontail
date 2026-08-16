import constantsObject from "../constants.js";
import { dirname, isAbsolute, join, parse, resolve, sep } from "../path.js";

const skippedCopy = Symbol("skippedCopy");
const pathDecoder = new TextDecoder();

function copyPathTypeError(name, value) {
  const received = value === null ? "null" : value === undefined ? "undefined" : `type ${typeof value} (${String(value)})`;
  const error = new TypeError(
    `The "${name}" argument must be of type string or an instance of Buffer or URL. Received ${received}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function nullPathError(name, value) {
  const error = new TypeError(`The argument '${name}' must be a string without null bytes. Received '${value}'`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

export function normalizeCopyPath(value, name) {
  let path;
  if (value instanceof Uint8Array) {
    path = pathDecoder.decode(value);
  } else if (typeof value === "string") {
    path = value;
    if (path.startsWith("file:")) {
      try {
        const url = new URL(path);
        if (url.protocol === "file:") path = decodeURIComponent(url.pathname);
      } catch {}
    }
  } else if (value && typeof value === "object" && value.protocol === "file:" && typeof value.pathname === "string") {
    path = decodeURIComponent(value.pathname);
  } else {
    throw copyPathTypeError(name, value);
  }

  if (globalThis.process?.platform === "win32" && /^\/[A-Za-z]:/.test(path)) {
    path = path.slice(1).replaceAll("/", "\\");
  }
  if (path.includes("\0")) throw nullPathError(name, path);
  while (path.length > 1 && (path.endsWith("/") || path.endsWith("\\"))) path = path.slice(0, -1);
  return path;
}

function cpError(code, message, path) {
  const error = new Error(`${code}: ${message}, cp '${path}'`);
  error.errno = -(Number(constantsObject[code]) || 5);
  error.code = code;
  error.path = path;
  error.syscall = "cp";
  return error;
}

function copyExistsError(destination, options) {
  const error = cpError("EEXIST", `${destination} already exists`, destination);
  if (options.fallback) error.code = "ERR_FS_CP_EEXIST";
  return error;
}

function normalizeCopyMode(mode) {
  if (mode == null) return 0;
  if (typeof mode !== "number") {
    const error = new TypeError(`The "mode" argument must be of type number. Received ${typeof mode}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (!Number.isInteger(mode) || mode < 0 || mode > 7) {
    const error = new RangeError(`The value of "mode" is out of range. It must be >= 0 && <= 7. Received ${mode}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  return mode;
}

export function nativeCopyError(error, destination, sourcePath = undefined) {
  if (error?.code) return error;
  const source = String(error?.message ?? error ?? "");
  const lower = source.toLowerCase();
  let code = "EIO";
  if (lower.includes("filenotfound") || lower.includes("no such file")) code = "ENOENT";
  else if (lower.includes("pathalreadyexists") || lower.includes("already exists")) code = "EEXIST";
  else if (lower.includes("isdir") || lower.includes("is a directory")) code = "EISDIR";
  else if (lower.includes("notdir") || lower.includes("not a directory")) code = "ENOTDIR";
  else if (lower.includes("symlinkloop")) code = "ELOOP";
  else if (lower.includes("symlinktosubdirectory")) code = "ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY";
  else if (lower.includes("copyinvalid")) code = "ERR_FS_CP_EINVAL";
  else if (lower.includes("nametoolong")) code = "ENAMETOOLONG";
  else if (lower.includes("permissiondenied") || lower.includes("accessdenied")) code = "EACCES";
  else if (lower.includes("operationunsupported")) code = "ENOTSUP";
  else if (lower.includes("invalidargument")) code = "EINVAL";
  const path = code === "EEXIST"
    ? error?.dest ?? destination
    : code === "EISDIR"
      ? error?.path ?? sourcePath ?? destination
      : error?.path ?? error?.dest ?? destination;
  const out = cpError(code, source || code, path);
  out.path = path;
  if (error?.dest !== undefined) out.dest = error.dest;
  return out;
}

function copyOptions(options) {
  if (!options) options = {};
  if (typeof options !== "object") throw new TypeError("options must be an object");

  const mode = normalizeCopyMode(options.mode);
  const fallback = Boolean(
    options.dereference ||
    options.filter ||
    options.preserveTimestamps ||
    options.verbatimSymlinks ||
    mode !== 0
  );
  if (options.filter && typeof options.filter !== "function") {
    throw new TypeError("options.filter must be a function");
  }

  return {
    dereference: Boolean(options.dereference),
    errorOnExist: Boolean(options.errorOnExist),
    fallback,
    filter: options.filter || null,
    force: options.force == null ? true : Boolean(options.force),
    mode,
    preserveTimestamps: Boolean(options.preserveTimestamps),
    recursive: Boolean(options.recursive),
    verbatimSymlinks: Boolean(options.verbatimSymlinks),
  };
}

function normalizePathParts(path) {
  const normalized = resolve(path);
  const parts = normalized.split(sep).filter(Boolean);
  if (globalThis.process?.platform === "win32") {
    return parts.map(part => part.toLowerCase());
  }
  return parts;
}

function isSourceSubdirectory(source, destination) {
  const sourceParts = normalizePathParts(source);
  const destinationParts = normalizePathParts(destination);
  return destinationParts.length > sourceParts.length &&
    sourceParts.every((part, index) => destinationParts[index] === part);
}

function areIdentical(sourceStats, destinationStats) {
  return destinationStats != null &&
    sourceStats.dev === destinationStats.dev &&
    sourceStats.ino === destinationStats.ino;
}

function sourceStats(path, options, operations, bigint = false) {
  const stat = options.dereference ? operations.statSync : operations.lstatSync;
  return stat(path, bigint ? { bigint: true } : undefined);
}

function destinationStats(path, options, operations) {
  try {
    return sourceStats(path, options, operations, true);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function checkTypes(source, destination, sourceStat, destinationStat) {
  if (!destinationStat) return;
  if (sourceStat.isDirectory() && !destinationStat.isDirectory()) {
    throw cpError("EISDIR", `cannot overwrite directory ${source} with non-directory ${destination}`, destination);
  }
  if (!sourceStat.isDirectory() && destinationStat.isDirectory()) {
    throw cpError("ENOTDIR", `cannot overwrite non-directory ${source} with directory ${destination}`, destination);
  }
}

function checkRelationship(source, destination, sourceStat, destinationStat, options) {
  if (areIdentical(sourceStat, destinationStat)) {
    if (!options.fallback) return false;
    throw cpError("EINVAL", "src and dest cannot be the same", destination);
  }
  checkTypes(source, destination, sourceStat, destinationStat);
  if (sourceStat.isDirectory() && isSourceSubdirectory(source, destination)) {
    throw cpError("EINVAL", `cannot copy ${source} to a subdirectory of self ${destination}`, destination);
  }
  return true;
}

function checkParentPaths(source, sourceStat, destination, operations) {
  const sourceParent = resolve(dirname(source));
  let destinationParent = resolve(dirname(destination));
  const root = parse(destinationParent).root;

  while (destinationParent !== sourceParent) {
    let parentStat;
    try {
      parentStat = operations.statSync(destinationParent, { bigint: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (parentStat && areIdentical(sourceStat, parentStat)) {
      throw cpError(
        "EINVAL",
        `cannot copy ${source} to a subdirectory of self ${destination}`,
        destination,
      );
    }
    if (destinationParent === root) break;
    const next = dirname(destinationParent);
    if (next === destinationParent) break;
    destinationParent = next;
  }
}

function ensureParent(destination, operations) {
  const parent = dirname(destination);
  try {
    const stats = operations.statSync(parent);
    if (!stats.isDirectory()) throw cpError("ENOTDIR", `not a directory ${parent}`, parent);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    operations.mkdirSync(parent, { recursive: true });
  }
}

function directoryIdentity(stats) {
  return `${String(stats.dev)}:${String(stats.ino)}`;
}

function copyFileEntry(source, destination, sourceStat, destinationStat, options, operations) {
  if (destinationStat) {
    if (options.force) {
      operations.unlinkSync(destination);
    } else if (options.errorOnExist) {
      throw copyExistsError(destination, options);
    } else {
      return;
    }
  }

  operations.copyFileSync(source, destination, options.mode);
  if (options.preserveTimestamps) {
    if ((Number(sourceStat.mode) & 0o200) === 0) {
      operations.chmodSync(destination, Number(sourceStat.mode) | 0o200);
    }
    // Reading the source can update atime, so fetch the timestamps again.
    const updated = operations.statSync(source);
    operations.utimesSync(destination, updated.atime, updated.mtime);
  }
  operations.chmodSync(destination, Number(sourceStat.mode));
}

async function copyFileEntryAsync(source, destination, sourceStat, destinationStat, options, operations) {
  if (destinationStat) {
    if (options.force) {
      operations.unlinkSync(destination);
    } else if (options.errorOnExist) {
      throw copyExistsError(destination, options);
    } else {
      return;
    }
  }

  if (typeof operations.copyFile === "function") {
    await operations.copyFile(source, destination, options.mode);
  } else {
    operations.copyFileSync(source, destination, options.mode);
  }
  if (options.preserveTimestamps) {
    if ((Number(sourceStat.mode) & 0o200) === 0) {
      operations.chmodSync(destination, Number(sourceStat.mode) | 0o200);
    }
    const updated = operations.statSync(source);
    operations.utimesSync(destination, updated.atime, updated.mtime);
  }
  operations.chmodSync(destination, Number(sourceStat.mode));
}

function resolvedLinkTarget(source, options, operations) {
  let target = operations.readlinkSync(source);
  if (!options.verbatimSymlinks && !isAbsolute(target)) {
    target = resolve(dirname(source), target);
  }
  return target;
}

function copyLink(source, destination, destinationStat, options, operations) {
  const target = resolvedLinkTarget(source, options, operations);
  if (!destinationStat) {
    operations.symlinkSync(target, destination);
    return;
  }

  if (!options.fallback) {
    if (!options.force) {
      if (options.errorOnExist) throw cpError("EEXIST", `${destination} already exists`, destination);
      return;
    }
    operations.unlinkSync(destination);
    operations.symlinkSync(target, destination);
    return;
  }

  let destinationTarget;
  try {
    destinationTarget = operations.readlinkSync(destination);
  } catch (error) {
    if (error?.code === "EINVAL" || error?.code === "UNKNOWN") {
      operations.symlinkSync(target, destination);
      return;
    }
    throw error;
  }
  if (!isAbsolute(destinationTarget)) {
    destinationTarget = resolve(dirname(destination), destinationTarget);
  }
  if (isSourceSubdirectory(target, destinationTarget)) {
    throw cpError(
      "EINVAL",
      `cannot copy ${target} to a subdirectory of self ${destinationTarget}`,
      destination,
    );
  }
  const followedSource = operations.statSync(source);
  if (followedSource.isDirectory() && isSourceSubdirectory(destinationTarget, target)) {
    throw cpError("EINVAL", `cannot overwrite ${destinationTarget} with ${target}`, destination);
  }
  operations.unlinkSync(destination);
  operations.symlinkSync(target, destination);
}

function unsupportedEntry(sourceStat, destination) {
  if (sourceStat.isSocket()) {
    throw cpError("EINVAL", `cannot copy a socket file: ${destination}`, destination);
  }
  if (sourceStat.isFIFO()) {
    throw cpError("EINVAL", `cannot copy a FIFO pipe: ${destination}`, destination);
  }
  throw cpError("EINVAL", `cannot copy an unknown file type: ${destination}`, destination);
}

function copyEntrySync(source, destination, destinationStat, options, operations, activeDirectories) {
  const stats = sourceStats(source, options, operations, true);
  if (stats.isDirectory()) {
    if (!options.recursive) {
      throw cpError("EISDIR", `${source} is a directory (not copied)`, source);
    }
    const identity = directoryIdentity(stats);
    if (activeDirectories.has(identity)) {
      throw cpError("ELOOP", `too many symbolic links encountered while copying ${source}`, source);
    }
    activeDirectories.add(identity);
    const created = !destinationStat;
    if (created) operations.mkdirSync(destination);
    try {
      for (const entry of operations.readdirSync(source, { withFileTypes: true })) {
        const childSource = join(source, String(entry.name));
        const childDestination = join(destination, String(entry.name));
        if (options.filter) {
          const decision = options.filter(childSource, childDestination);
          if (decision && typeof decision.then === "function") {
            throw new Error(
              "Expected a boolean from the filter function, but got a promise. Use `fs.promises.cp` instead.",
            );
          }
          if (!decision) continue;
        }
        const childSourceStat = sourceStats(childSource, options, operations, true);
        const childDestinationStat = destinationStats(childDestination, options, operations);
        if (!checkRelationship(
          childSource,
          childDestination,
          childSourceStat,
          childDestinationStat,
          options,
        )) continue;
        copyEntrySync(
          childSource,
          childDestination,
          childDestinationStat,
          options,
          operations,
          activeDirectories,
        );
      }
    } finally {
      activeDirectories.delete(identity);
    }
    if (created) operations.chmodSync(destination, Number(stats.mode));
    return;
  }

  if (stats.isFile() || stats.isCharacterDevice() || stats.isBlockDevice()) {
    copyFileEntry(source, destination, stats, destinationStat, options, operations);
    return;
  }
  if (stats.isSymbolicLink()) {
    copyLink(source, destination, destinationStat, options, operations);
    return;
  }
  unsupportedEntry(stats, destination);
}

function checkRootSync(source, destination, options, operations) {
  if (options.filter) {
    const decision = options.filter(source, destination);
    if (decision && typeof decision.then === "function") {
      throw new Error(
        "Expected a boolean from the filter function, but got a promise. Use `fs.promises.cp` instead.",
      );
    }
    if (!decision) return skippedCopy;
  }
  const sourceStat = sourceStats(source, options, operations, true);
  const destinationStat = destinationStats(destination, options, operations);
  if (!checkRelationship(source, destination, sourceStat, destinationStat, options)) return skippedCopy;
  checkParentPaths(source, sourceStat, destination, operations);
  ensureParent(destination, operations);
  return destinationStat;
}

export function cpSyncImpl(source, destination, rawOptions, operations) {
  const options = copyOptions(rawOptions);
  const destinationStat = checkRootSync(source, destination, options, operations);
  if (destinationStat === skippedCopy) return;
  if (!options.fallback && typeof operations.copyTreeSync === "function") {
    try {
      operations.copyTreeSync(
        source,
        destination,
        options.recursive,
        options.force,
        options.errorOnExist,
      );
      return;
    } catch (error) {
      throw nativeCopyError(error, destination, source);
    }
  }
  copyEntrySync(source, destination, destinationStat, options, operations, new Set());
}

async function copyEntryAsync(source, destination, destinationStat, options, operations, activeDirectories) {
  const stats = sourceStats(source, options, operations, true);
  if (stats.isDirectory()) {
    if (!options.recursive) {
      throw cpError("EISDIR", `${source} is a directory (not copied)`, source);
    }
    const identity = directoryIdentity(stats);
    if (activeDirectories.has(identity)) {
      throw cpError("ELOOP", `too many symbolic links encountered while copying ${source}`, source);
    }
    activeDirectories.add(identity);
    const created = !destinationStat;
    if (created) operations.mkdirSync(destination);
    try {
      for (const entry of operations.readdirSync(source, { withFileTypes: true })) {
        const childSource = join(source, String(entry.name));
        const childDestination = join(destination, String(entry.name));
        if (options.filter && !(await options.filter(childSource, childDestination))) continue;
        const childSourceStat = sourceStats(childSource, options, operations, true);
        const childDestinationStat = destinationStats(childDestination, options, operations);
        if (!checkRelationship(
          childSource,
          childDestination,
          childSourceStat,
          childDestinationStat,
          options,
        )) continue;
        await copyEntryAsync(
          childSource,
          childDestination,
          childDestinationStat,
          options,
          operations,
          activeDirectories,
        );
      }
    } finally {
      activeDirectories.delete(identity);
    }
    if (created) operations.chmodSync(destination, Number(stats.mode));
    return;
  }

  if (stats.isFile() || stats.isCharacterDevice() || stats.isBlockDevice()) {
    await copyFileEntryAsync(source, destination, stats, destinationStat, options, operations);
    return;
  }
  if (stats.isSymbolicLink()) {
    copyLink(source, destination, destinationStat, options, operations);
    return;
  }
  unsupportedEntry(stats, destination);
}

async function cpWithFilter(source, destination, options, operations) {
  if (!(await options.filter(source, destination))) return;
  const sourceStat = sourceStats(source, options, operations, true);
  const destinationStat = destinationStats(destination, options, operations);
  if (!checkRelationship(source, destination, sourceStat, destinationStat, options)) return;
  checkParentPaths(source, sourceStat, destination, operations);
  ensureParent(destination, operations);
  return copyEntryAsync(
    source,
    destination,
    destinationStat,
    options,
    operations,
    new Set(),
  );
}

export function cpPromiseImpl(source, destination, rawOptions, operations) {
  const options = copyOptions(rawOptions);
  if (options.filter) return cpWithFilter(source, destination, options, operations);
  return Promise.resolve().then(() => {
    const destinationStat = checkRootSync(source, destination, options, operations);
    if (destinationStat === skippedCopy) return;
    if (!options.fallback && typeof operations.copyTree === "function") {
      return operations.copyTree(
        source,
        destination,
        options.recursive,
        options.force,
        options.errorOnExist,
      ).catch(error => {
        throw nativeCopyError(error, destination, source);
      });
    }
    return copyEntryAsync(source, destination, destinationStat, options, operations, new Set());
  });
}
