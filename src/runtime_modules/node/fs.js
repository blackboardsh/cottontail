import "../bun/ffi.js";
import { resolve } from "./path.js";
import { Readable } from "./stream.js";

function assertOk(result, action) {
  if (result.status !== 0) throw new Error(`${action}: ${result.stderr || result.stdout}`);
  return result;
}

function shellEscape(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function makeBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  bytes.toString = function toString(encoding = "utf8") {
    if (encoding === "base64" && globalThis.Buffer?.from) return globalThis.Buffer.from(this).toString("base64");
    return new TextDecoder().decode(this);
  };
  return bytes;
}

export function existsSync(path) {
  return cottontail.existsSync(String(path));
}

export function accessSync(path) {
  if (!existsSync(path)) throw new Error(`ENOENT: no such file or directory, access '${path}'`);
}

export function readFileSync(path, encoding = undefined) {
  if (encoding) return cottontail.readFile(String(path));
  return makeBuffer(cottontail.readFileBuffer(String(path)));
}

export function writeFileSync(path, data) {
  cottontail.writeFile(String(path), data);
}

export function openSync(path, flags = "r", mode = 0o666) {
  return cottontail.openFd(String(path), String(flags ?? "r"), Number(mode ?? 0o666));
}

export function closeSync(fd) {
  cottontail.closeFd(Number(fd));
}

export function cpSync(source, destination, options = {}) {
  const args = [];
  if (options?.recursive) args.push("-R");
  const sourceText = String(source);
  const destinationText = String(destination);
  const parentIndex = destinationText.lastIndexOf("/");
  if (parentIndex > 0) cottontail.mkdirSync(destinationText.slice(0, parentIndex), true);
  const sourceIsDir = statSync(sourceText).isDirectory();
  const destinationIsDir = existsSync(destinationText) && statSync(destinationText).isDirectory();
  args.push(options?.recursive && sourceIsDir && destinationIsDir ? `${sourceText}/.` : sourceText, destinationText);
  assertOk(cottontail.spawnSync("cp", args, { stdio: "pipe" }), "cpSync");
}

export function copyFileSync(source, destination) {
  const destinationText = String(destination);
  const parentIndex = destinationText.lastIndexOf("/");
  if (parentIndex > 0) cottontail.mkdirSync(destinationText.slice(0, parentIndex), true);
  assertOk(cottontail.spawnSync("cp", [String(source), destinationText], { stdio: "pipe" }), "copyFileSync");
}

export function chmodSync(path, mode) {
  const parsed = typeof mode === "string" ? parseInt(mode, 8) : Number(mode);
  cottontail.chmodSync(String(path), parsed);
}

export function mkdirSync(path, options = {}) {
  cottontail.mkdirSync(String(path), Boolean(options?.recursive));
}

export function mkdtempSync(prefix) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    const path = `${String(prefix)}${suffix}`;
    if (!cottontail.existsSync(path)) {
      cottontail.mkdirSync(path, true);
      return path;
    }
  }
  throw new Error(`mkdtempSync failed for prefix ${prefix}`);
}

export function rmSync(path, options = {}) {
  cottontail.rmSync(String(path), Boolean(options?.recursive), Boolean(options?.force));
}

export function rmdirSync(path) {
  rmSync(path, { recursive: false, force: false });
}

export function unlinkSync(path) {
  cottontail.unlinkSync(String(path));
}

export function renameSync(oldPath, newPath) {
  assertOk(cottontail.spawnSync("mv", [String(oldPath), String(newPath)], { stdio: "pipe" }), "renameSync");
}

export function symlinkSync(target, path) {
  assertOk(cottontail.spawnSync("ln", ["-s", String(target), String(path)], { stdio: "pipe" }), "symlinkSync");
}

export function readdirSync(path, options = undefined) {
  const entries = cottontail.readDirSync(String(path));
  if (!options?.withFileTypes) return entries.map((entry) => entry.name);
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: () => Boolean(entry.isDirectory),
    isFile: () => Boolean(entry.isFile),
    isSymbolicLink: () => Boolean(entry.isSymbolicLink),
  }));
}

export function statSync(path) {
  return makeStats(cottontail.statSync(String(path), true));
}

export function lstatSync(path) {
  return makeStats(cottontail.statSync(String(path), false));
}

export function realpathSync(path) {
  return resolve(String(path));
}

const fdWatchListeners = globalThis.__cottontailFdWatchListeners ??= new Map();
if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
  globalThis.__cottontailFdWatchHandlerInstalled = true;
  cottontail.fdSetEventHandler((event) => {
    const listener = fdWatchListeners.get(Number(event?.id));
    if (typeof listener === "function") listener(event);
  });
}

function registerFdWatchListener(id, listener) {
  const key = Number(id);
  fdWatchListeners.set(key, listener);
  return () => {
    if (fdWatchListeners.get(key) === listener) {
      fdWatchListeners.delete(key);
    }
  };
}

function withCallback(action) {
  return (...args) => {
    const callback = args[args.length - 1];
    if (typeof callback !== "function") {
      throw new TypeError("Callback must be a function");
    }
    const callArgs = args.slice(0, -1);
    setTimeout(() => {
      try {
        callback(null, action(...callArgs));
      } catch (error) {
        callback(error);
      }
    }, 0);
  };
}

export const readdir = withCallback(readdirSync);
export const stat = withCallback(statSync);
export const lstat = withCallback(lstatSync);
export const realpath = withCallback(realpathSync);
export const open = withCallback(openSync);
export const close = withCallback(closeSync);
export const readFile = withCallback(readFileSync);
export const writeFile = withCallback(writeFileSync);

function makeStats(result) {
  const atimeMs = Number(result.atimeMs) || 0;
  const mtimeMs = Number(result.mtimeMs) || 0;
  const ctimeMs = Number(result.ctimeMs) || 0;
  const birthtimeMs = Number(result.birthtimeMs) || 0;
  return {
    size: Number(result.size) || 0,
    mode: Number(result.mode) || 0,
    atimeMs,
    mtimeMs,
    ctimeMs,
    birthtimeMs,
    atime: new Date(atimeMs),
    mtime: new Date(mtimeMs),
    ctime: new Date(ctimeMs),
    birthtime: new Date(birthtimeMs),
    isFile: () => Boolean(result.isFile),
    isDirectory: () => Boolean(result.isDirectory),
    isSymbolicLink: () => Boolean(result.isSymbolicLink),
  };
}

export function createReadStream(path, options = {}) {
  const stream = new Readable();
  stream.path = path;
  stream.fd = options && Object.prototype.hasOwnProperty.call(options, "fd") ? Number(options.fd) : null;
  stream.destroyed = false;
  stream.readableEnded = false;
  stream.bytesRead = 0;
  stream.pending = true;

  const highWaterMark = Math.max(1, Math.min(Number(options?.highWaterMark || 64 * 1024), 1024 * 1024));
  const encoding = options?.encoding;
  const autoClose = options?.autoClose !== false;
  let ownsFd = false;
  let closed = false;
  let watchId = 0;
  let unregisterWatch = null;

  if (stream.fd == null || Number.isNaN(stream.fd)) {
    stream.fd = openSync(path, options?.flags || "r", options?.mode ?? 0o666);
    ownsFd = true;
  }

  const closeFd = () => {
    if (closed) return;
    closed = true;
    if (autoClose || ownsFd) {
      closeSync(stream.fd);
    }
  };

  const stopWatch = () => {
    if (unregisterWatch) {
      unregisterWatch();
      unregisterWatch = null;
    }
    if (watchId) {
      cottontail.fdWatchStop?.(watchId);
      watchId = 0;
    }
  };

  const finish = () => {
    if (stream.destroyed) return;
    stream.readableEnded = true;
    stream.destroyed = true;
    stopWatch();
    try {
      closeFd();
    } catch (error) {
      stream.emit("error", error);
    }
    stream.push(null);
    stream.emit("close");
  };

  stream.destroy = function destroy(error = undefined) {
    if (stream.destroyed) return stream;
    stream.destroyed = true;
    stopWatch();
    try {
      closeFd();
    } catch (closeError) {
      if (!error) error = closeError;
    }
    if (error) stream.emit("error", error);
    stream.emit("close");
    return stream;
  };

  if (typeof cottontail.fdWatchStart !== "function") {
    throw new Error("cottontail fd watcher is unavailable");
  }

  const watch = cottontail.fdWatchStart(stream.fd, highWaterMark);
  watchId = Number(watch?.id || 0);
  if (!watchId) {
    throw new Error("failed to start fd watcher");
  }
  unregisterWatch = registerFdWatchListener(watchId, (event) => {
    if (stream.destroyed) return;
    stream.pending = false;
    if (event.type === "data") {
      const bytes = event.data ?? new ArrayBuffer(0);
      if (bytes.byteLength === 0) return;
      stream.bytesRead += bytes.byteLength;
      const value = encoding ? makeBuffer(bytes).toString(encoding) : makeBuffer(bytes);
      stream.push(value);
      return;
    }
    if (event.type === "end") {
      finish();
      return;
    }
    if (event.type === "error") {
      stream.destroy(new Error(event.message || "fd read failed"));
    }
  });

  return stream;
}

function snapshot(path, recursive) {
  const command = recursive
    ? `cd ${shellEscape(path)} && find . -type f -o -type d | sort`
    : `cd ${shellEscape(path)} && ls -A | sort`;
  const result = cottontail.spawnSync("sh", ["-c", command], { stdio: "pipe" });
  return result.status === 0 ? result.stdout : "";
}

export function watch(path, options = {}, listener = undefined) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  const listeners = new Map();
  let closed = false;
  let last = snapshot(String(path), Boolean(options?.recursive));
  const on = (name, handler) => {
    const handlers = listeners.get(name) ?? [];
    handlers.push(handler);
    listeners.set(name, handlers);
    return watcher;
  };
  const emit = (name, ...args) => {
    for (const handler of listeners.get(name) ?? []) handler(...args);
  };
  const watcher = {
    close() {
      closed = true;
      clearInterval(timer);
    },
    on,
    once(name, handler) {
      const wrapped = (...args) => {
        watcher.off(name, wrapped);
        handler(...args);
      };
      return on(name, wrapped);
    },
    off(name, handler) {
      const handlers = listeners.get(name) ?? [];
      listeners.set(name, handlers.filter((item) => item !== handler));
      return watcher;
    },
    removeListener(name, handler) {
      return watcher.off(name, handler);
    },
  };
  if (listener) on("change", listener);
  const timer = setInterval(() => {
    if (closed) return;
    const next = snapshot(String(path), Boolean(options?.recursive));
    if (next !== last) {
      last = next;
      emit("change", "change", "");
    }
  }, 500);
  return watcher;
}

function zeroStats() {
  return makeStats({});
}

function statSnapshot(path) {
  try {
    return statSync(path);
  } catch {
    return zeroStats();
  }
}

function statsEqual(a, b) {
  return a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.birthtimeMs === b.birthtimeMs &&
    a.atimeMs === b.atimeMs &&
    a.isFile() === b.isFile() &&
    a.isDirectory() === b.isDirectory() &&
    a.isSymbolicLink() === b.isSymbolicLink();
}

const fileWatchers = globalThis.__cottontailFileWatchers ??= new Map();

function normalizeWatchFileArgs(options, listener) {
  if (typeof options === "function") {
    return { options: {}, listener: options };
  }
  return { options: options ?? {}, listener };
}

function closeFileWatcher(path, entry) {
  clearInterval(entry.timer);
  fileWatchers.delete(path);
}

export function watchFile(path, options = {}, listener = undefined) {
  const normalized = normalizeWatchFileArgs(options, listener);
  if (typeof normalized.listener !== "function") {
    throw new TypeError("The \"listener\" argument must be of type function");
  }

  const filename = String(path);
  const interval = Math.max(1, Number(normalized.options?.interval || 5007));
  let entry = fileWatchers.get(filename);
  if (!entry) {
    entry = {
      previous: statSnapshot(filename),
      listeners: new Set(),
      timer: null,
    };
    entry.timer = setInterval(() => {
      const current = statSnapshot(filename);
      if (statsEqual(current, entry.previous)) return;
      const previous = entry.previous;
      entry.previous = current;
      for (const handler of [...entry.listeners]) handler(current, previous);
    }, interval);
    fileWatchers.set(filename, entry);
  }

  entry.listeners.add(normalized.listener);

  const watcher = {
    close() {
      unwatchFile(filename, normalized.listener);
      return watcher;
    },
    ref() {
      return watcher;
    },
    unref() {
      return watcher;
    },
  };
  return watcher;
}

export function unwatchFile(path, listener = undefined) {
  const filename = String(path);
  const entry = fileWatchers.get(filename);
  if (!entry) return;

  if (typeof listener === "function") {
    entry.listeners.delete(listener);
  } else {
    entry.listeners.clear();
  }

  if (entry.listeners.size === 0) closeFileWatcher(filename, entry);
}

export const promises = {
  async access(path) {
    return accessSync(path);
  },
  async mkdir(path, options = {}) {
    return mkdirSync(path, options);
  },
  async mkdtemp(prefix) {
    return mkdtempSync(prefix);
  },
  async readFile(path, encoding = undefined) {
    return readFileSync(path, encoding);
  },
  async readdir(path, options = undefined) {
    return readdirSync(path, options);
  },
  async realpath(path) {
    return realpathSync(path);
  },
  async rm(path, options = {}) {
    return rmSync(path, options);
  },
  async rmdir(path) {
    return rmdirSync(path);
  },
  async unlink(path) {
    return unlinkSync(path);
  },
  async writeFile(path, data) {
    return writeFileSync(path, data);
  },
  async stat(path) {
    return statSync(path);
  },
  async lstat(path) {
    return lstatSync(path);
  },
};

export default {
  accessSync,
  chmodSync,
  closeSync,
  cpSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  open,
  promises,
  readFile,
  readFileSync,
  readdir,
  readdirSync,
  realpath,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  lstat,
  stat,
  statSync,
  unlinkSync,
  watch,
  watchFile,
  unwatchFile,
  close,
  writeFileSync,
  writeFile,
};
