import { createReadableStdio, createWritableStdio } from "./stdio.js";
import { Buffer } from "./buffer.js";
import constantsObject from "./constants.js";
import * as utilTypes from "./util/types.js";
import * as zlibConstants from "./zlib/constants.js";

const processStartNs = typeof cottontail.nanotime === "function" ? BigInt(Math.floor(cottontail.nanotime())) : 0n;
const processStartMs = Date.now();
let sourceMapsState = false;
let uncaughtExceptionCaptureCallback = null;

function signalNumber(signal = "SIGTERM") {
  if (typeof signal === "number") return signal;
  const name = String(signal).toUpperCase();
  if (name === "0") return 0;
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGABRT: 6,
    SIGKILL: 9,
    SIGUSR1: cottontail.platform?.() === "linux" ? 10 : 30,
    SIGUSR2: cottontail.platform?.() === "linux" ? 12 : 31,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  if (signals[name] == null) throw new TypeError(`Unknown signal: ${signal}`);
  return signals[name];
}

function processInfo(kind, ...args) {
  if (typeof cottontail.processInfo !== "function") {
    throw new Error("native processInfo support is unavailable");
  }
  return cottontail.processInfo(kind, ...args);
}

function createEventApi(processObject) {
  const listeners = processObject.__cottontailListeners ?? new Map();
  Object.defineProperty(processObject, "__cottontailListeners", {
    value: listeners,
    configurable: true,
  });

  processObject._events ??= Object.create(null);
  processObject._eventsCount ??= 0;
  processObject._maxListeners ??= undefined;

  function syncEventsObject() {
    const object = Object.create(null);
    for (const [name, handlers] of listeners) {
      if (handlers.length === 1) object[name] = handlers[0];
      else if (handlers.length > 1) object[name] = [...handlers];
    }
    processObject._events = object;
    processObject._eventsCount = Object.keys(object).length;
  }

  processObject.on = processObject.addListener = function on(name, handler) {
    if (typeof handler !== "function") return this;
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    handlers.push(handler);
    listeners.set(key, handlers);
    syncEventsObject();
    return this;
  };

  processObject.once = function once(name, handler) {
    if (typeof handler !== "function") return this;
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  };

  processObject.off = processObject.removeListener = function off(name, handler) {
    const key = String(name);
    const handlers = listeners.get(key) ?? [];
    listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
    if ((listeners.get(key) ?? []).length === 0) listeners.delete(key);
    syncEventsObject();
    return this;
  };

  processObject.removeAllListeners = function removeAllListeners(name = undefined) {
    if (name == null) listeners.clear();
    else listeners.delete(String(name));
    syncEventsObject();
    return this;
  };

  processObject.listeners = function processListeners(name) {
    return [...(listeners.get(String(name)) ?? [])];
  };

  processObject.listenerCount = function listenerCount(name) {
    return listeners.get(String(name))?.length ?? 0;
  };

  processObject.emit = function emit(name, ...args) {
    const handlers = [...(listeners.get(String(name)) ?? [])];
    for (const handler of handlers) handler(...args);
    return handlers.length > 0;
  };

  syncEventsObject();
}

function nowNs() {
  return typeof cottontail.nanotime === "function"
    ? BigInt(Math.floor(cottontail.nanotime()))
    : BigInt(Date.now()) * 1000000n;
}

function makeHrtime(previous = undefined) {
  let diff = nowNs() - processStartNs;
  if (Array.isArray(previous)) {
    diff -= BigInt(previous[0] || 0) * 1000000000n + BigInt(previous[1] || 0);
  }
  return [Number(diff / 1000000000n), Number(diff % 1000000000n)];
}

makeHrtime.bigint = () => nowNs() - processStartNs;

function makeCpuUsage(kind = "resourceUsage", previous = undefined) {
  const usage = processInfo(kind);
  let user = Number(usage.userCPUTime) || 0;
  let system = Number(usage.systemCPUTime) || 0;
  if (previous) {
    user -= Number(previous.user) || 0;
    system -= Number(previous.system) || 0;
  }
  return { user, system };
}

function makeMemoryUsage() {
  return processInfo("memoryUsage");
}

makeMemoryUsage.rss = () => Number(processInfo("memoryUsage").rss) || 0;

function pickConstants(predicate) {
  const out = {};
  for (const [name, value] of Object.entries(constantsObject)) {
    if (predicate(name, value)) out[name] = value;
  }
  return Object.freeze(out);
}

const errnoConstants = pickConstants((name, value) => /^E[A-Z0-9]+$/.test(name) && Number.isInteger(value));
const signalConstants = pickConstants((name, value) => /^SIG[A-Z0-9]+$/.test(name) && Number.isInteger(value));
const priorityConstants = pickConstants((name) => name.startsWith("PRIORITY_"));
const dlopenConstants = pickConstants((name) => name.startsWith("RTLD_"));
const fsConstants = pickConstants((name) =>
  name === "F_OK" ||
  name === "R_OK" ||
  name === "W_OK" ||
  name === "X_OK" ||
  name.startsWith("O_") ||
  name.startsWith("S_") ||
  name.startsWith("UV_DIRENT_") ||
  name.startsWith("UV_FS_") ||
  name.startsWith("COPYFILE_"));
const cryptoConstants = pickConstants((name) =>
  name === "defaultCoreCipherList" ||
  name === "OPENSSL_VERSION_NUMBER" ||
  name.startsWith("SSL_") ||
  name.startsWith("ENGINE_") ||
  name.startsWith("DH_") ||
  name.startsWith("RSA_") ||
  name.startsWith("TLS") ||
  name.startsWith("POINT_CONVERSION_"));
const zlibBindingConstants = Object.freeze(Object.fromEntries(
  Object.entries(zlibConstants).filter(([, value]) => typeof value === "number" || typeof value === "string"),
));

function bindingError(message, code = undefined) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

function throwNoSuchBinding(name) {
  throw bindingError(`No such module: ${name}`);
}

function bufferView(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(String(value));
}

function copyBytes(source, target, targetStart = 0, sourceStart = 0, sourceEnd = undefined) {
  const sourceView = bufferView(source);
  const targetView = bufferView(target);
  const start = Math.max(0, Number(sourceStart) || 0);
  const end = Math.min(sourceView.byteLength, sourceEnd == null ? sourceView.byteLength : Number(sourceEnd) || 0);
  const targetOffset = Math.max(0, Number(targetStart) || 0);
  const chunk = sourceView.subarray(start, Math.max(start, end));
  targetView.set(chunk.subarray(0, Math.max(0, targetView.byteLength - targetOffset)), targetOffset);
  return Math.min(chunk.byteLength, Math.max(0, targetView.byteLength - targetOffset));
}

function swapBytes(buffer, width) {
  const view = bufferView(buffer);
  if (view.byteLength % width !== 0) throw bindingError(`Buffer size must be a multiple of ${width}`);
  for (let index = 0; index < view.byteLength; index += width) {
    for (let offset = 0; offset < width / 2; offset += 1) {
      const left = index + offset;
      const right = index + width - offset - 1;
      const value = view[left];
      view[left] = view[right];
      view[right] = value;
    }
  }
  return buffer;
}

function indexOfBuffer(source, needle, byteOffset = 0) {
  const haystack = bufferView(source);
  const target = bufferView(needle);
  const start = Math.max(0, Number(byteOffset) || 0);
  if (target.byteLength === 0) return start <= haystack.byteLength ? start : haystack.byteLength;
  outer: for (let index = start; index <= haystack.byteLength - target.byteLength; index += 1) {
    for (let offset = 0; offset < target.byteLength; offset += 1) {
      if (haystack[index + offset] !== target[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function makeBufferBinding() {
  return Object.freeze({
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    byteLengthUtf8(value) {
      return Buffer.byteLength ? Buffer.byteLength(String(value), "utf8") : new TextEncoder().encode(String(value)).byteLength;
    },
    copy: copyBytes,
    compare(left, right) {
      const a = bufferView(left);
      const b = bufferView(right);
      const length = Math.min(a.byteLength, b.byteLength);
      for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
      }
      if (a.byteLength === b.byteLength) return 0;
      return a.byteLength < b.byteLength ? -1 : 1;
    },
    compareOffset(left, right, targetStart = 0, sourceStart = 0, sourceEnd = undefined) {
      return this.compare(bufferView(left).subarray(Number(sourceStart) || 0, sourceEnd == null ? undefined : Number(sourceEnd)), bufferView(right).subarray(Number(targetStart) || 0));
    },
    fill(buffer, value, offset = 0, end = undefined, encoding = "utf8") {
      const view = bufferView(buffer);
      const start = Math.max(0, Number(offset) || 0);
      const stop = Math.min(view.byteLength, end == null ? view.byteLength : Number(end) || 0);
      const fillBytes = typeof value === "number" ? Uint8Array.of(Number(value) & 0xff) : bufferView(Buffer.from(String(value), encoding));
      if (fillBytes.byteLength === 0) return;
      for (let index = start; index < stop; index += 1) view[index] = fillBytes[(index - start) % fillBytes.byteLength];
    },
    indexOfBuffer,
    indexOfNumber(source, value, byteOffset = 0) {
      const view = bufferView(source);
      const target = Number(value) & 0xff;
      for (let index = Math.max(0, Number(byteOffset) || 0); index < view.byteLength; index += 1) {
        if (view[index] === target) return index;
      }
      return -1;
    },
    indexOfString(source, value, byteOffset = 0, encoding = "utf8") {
      return indexOfBuffer(source, Buffer.from(String(value), encoding), byteOffset);
    },
    copyArrayBuffer(source, target, sourceStart = 0, targetStart = 0, length = undefined) {
      const sourceView = bufferView(source);
      const targetView = bufferView(target);
      const start = Math.max(0, Number(sourceStart) || 0);
      const count = Math.min(
        length == null ? sourceView.byteLength - start : Number(length) || 0,
        targetView.byteLength - (Number(targetStart) || 0),
      );
      targetView.set(sourceView.subarray(start, start + Math.max(0, count)), Math.max(0, Number(targetStart) || 0));
    },
    swap16: (buffer) => swapBytes(buffer, 2),
    swap32: (buffer) => swapBytes(buffer, 4),
    swap64: (buffer) => swapBytes(buffer, 8),
    isUtf8(value) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bufferView(value));
        return true;
      } catch {
        return false;
      }
    },
    isAscii(value) {
      return bufferView(value).every((byte) => byte <= 0x7f);
    },
    kMaxLength: Number.MAX_SAFE_INTEGER,
    kStringMaxLength: 536870888,
    utf8Slice: (buffer, start = 0, end = undefined) => Buffer.from(bufferView(buffer).subarray(Number(start) || 0, end == null ? undefined : Number(end))).toString("utf8"),
    latin1Slice: (buffer, start = 0, end = undefined) => Buffer.from(bufferView(buffer).subarray(Number(start) || 0, end == null ? undefined : Number(end))).toString("latin1"),
    asciiSlice: (buffer, start = 0, end = undefined) => Buffer.from(bufferView(buffer).subarray(Number(start) || 0, end == null ? undefined : Number(end))).toString("ascii"),
    hexSlice: (buffer, start = 0, end = undefined) => Buffer.from(bufferView(buffer).subarray(Number(start) || 0, end == null ? undefined : Number(end))).toString("hex"),
    base64Slice: (buffer, start = 0, end = undefined) => Buffer.from(bufferView(buffer).subarray(Number(start) || 0, end == null ? undefined : Number(end))).toString("base64"),
    getZeroFillToggle: () => [0],
  });
}

function maybeCompleteRequest(request, error, result) {
  if (request && typeof request.oncomplete === "function") {
    queueMicrotask(() => request.oncomplete(error ?? null, result));
  }
  if (error) throw error;
  return result;
}

function fsStatKind(path) {
  try {
    const stat = cottontail.statSync(String(path), true);
    if (stat?.isDirectory || ((Number(stat?.mode) & (fsConstants.S_IFMT ?? 0o170000)) === (fsConstants.S_IFDIR ?? 0o040000))) return 1;
    if (stat?.isFile || ((Number(stat?.mode) & (fsConstants.S_IFMT ?? 0o170000)) === (fsConstants.S_IFREG ?? 0o100000))) return 0;
    return 0;
  } catch {
    return -(errnoConstants.ENOENT ?? 2);
  }
}

function makeFsBinding() {
  const readBuffers = (fd, buffers, position = null, request = undefined) => {
    let total = 0;
    let currentPosition = position;
    for (const buffer of buffers ?? []) {
      const view = bufferView(buffer);
      const count = Number(cottontail.fdReadAt(Number(fd), view, 0, view.byteLength, currentPosition ?? null));
      total += count;
      if (currentPosition != null) currentPosition += count;
      if (count < view.byteLength) break;
    }
    return maybeCompleteRequest(request, null, total);
  };
  const writeBuffers = (fd, buffers, position = null, request = undefined) => {
    let total = 0;
    let currentPosition = position;
    for (const buffer of buffers ?? []) {
      const view = bufferView(buffer);
      const count = Number(cottontail.fdWriteAt(Number(fd), view, 0, view.byteLength, currentPosition ?? null));
      total += count;
      if (currentPosition != null) currentPosition += count;
    }
    return maybeCompleteRequest(request, null, total);
  };
  return Object.freeze({
    access(path, mode = 0, request = undefined) {
      return maybeCompleteRequest(request, null, cottontail.accessSync(String(path), Number(mode ?? 0)) ?? 0);
    },
    close(fd, request = undefined) {
      return maybeCompleteRequest(request, null, cottontail.closeFd(Number(fd)) ?? 0);
    },
    existsSync: (path) => Boolean(cottontail.existsSync(String(path))),
    open(path, flags = "r", mode = 0o666, request = undefined) {
      return maybeCompleteRequest(request, null, cottontail.openFd(String(path), flags ?? "r", Number(mode ?? 0o666)));
    },
    read(fd, buffer, offset = 0, length = undefined, position = null, request = undefined) {
      const view = bufferView(buffer);
      const byteLength = length == null ? view.byteLength - Number(offset || 0) : Number(length);
      const count = Number(cottontail.fdReadAt(Number(fd), view, Number(offset || 0), byteLength, position ?? null));
      return maybeCompleteRequest(request, null, count);
    },
    readFileUtf8: (path) => cottontail.readFile(String(path)),
    readBuffers,
    fdatasync: (fd, request = undefined) => maybeCompleteRequest(request, null, cottontail.fdatasyncSync(Number(fd)) ?? 0),
    fsync: (fd, request = undefined) => maybeCompleteRequest(request, null, cottontail.fsyncSync(Number(fd)) ?? 0),
    rename: (oldPath, newPath, request = undefined) => maybeCompleteRequest(request, null, cottontail.renameSync(String(oldPath), String(newPath)) ?? 0),
    ftruncate: (fd, length = 0, request = undefined) => maybeCompleteRequest(request, null, cottontail.ftruncateSync(Number(fd), Number(length ?? 0)) ?? 0),
    rmdir: (path, request = undefined) => maybeCompleteRequest(request, null, cottontail.rmdirSync(String(path)) ?? 0),
    rmSync: (path, options = {}) => cottontail.rmSync(String(path), Boolean(options?.recursive), Boolean(options?.force)) ?? undefined,
    mkdir: (path, mode = 0o777, recursive = false, request = undefined) => {
      void mode;
      return maybeCompleteRequest(request, null, cottontail.mkdirSync(String(path), Boolean(recursive)) ?? 0);
    },
    readdir: (path, options = undefined, request = undefined) => maybeCompleteRequest(request, null, cottontail.readDirSync(String(path), options) ?? []),
    internalModuleStat: fsStatKind,
    stat: (path, bigint = false, request = undefined) => maybeCompleteRequest(request, null, cottontail.statSync(String(path), true, Boolean(bigint))),
    lstat: (path, bigint = false, request = undefined) => maybeCompleteRequest(request, null, cottontail.statSync(String(path), false, Boolean(bigint))),
    fstat: (fd, bigint = false, request = undefined) => maybeCompleteRequest(request, null, cottontail.fstatSync(Number(fd), Boolean(bigint))),
    statfs: (path, bigint = false, request = undefined) => maybeCompleteRequest(request, null, cottontail.statfsSync(String(path), Boolean(bigint))),
    link: (existingPath, newPath, request = undefined) => maybeCompleteRequest(request, null, cottontail.linkSync(String(existingPath), String(newPath)) ?? 0),
    symlink: (target, path, type = undefined, request = undefined) => maybeCompleteRequest(request, null, cottontail.symlinkSync(String(target), String(path), type) ?? 0),
    readlink: (path, request = undefined) => maybeCompleteRequest(request, null, cottontail.readlinkSync(String(path))),
    unlink: (path, request = undefined) => maybeCompleteRequest(request, null, cottontail.unlinkSync(String(path)) ?? 0),
    writeBuffer(fd, buffer, offset = 0, length = undefined, position = null, request = undefined) {
      const view = bufferView(buffer);
      const byteLength = length == null ? view.byteLength - Number(offset || 0) : Number(length);
      const count = Number(cottontail.fdWriteAt(Number(fd), view, Number(offset || 0), byteLength, position ?? null));
      return maybeCompleteRequest(request, null, count);
    },
    writeBuffers,
    writeString(fd, string, offset = 0, length = undefined, position = null, request = undefined) {
      const view = bufferView(Buffer.from(String(string)));
      const byteLength = length == null ? view.byteLength - Number(offset || 0) : Number(length);
      const count = Number(cottontail.fdWriteAt(Number(fd), view, Number(offset || 0), byteLength, position ?? null));
      return maybeCompleteRequest(request, null, count);
    },
    writeFileUtf8: (path, data) => cottontail.writeFile(String(path), String(data)),
    realpath: (path, cache = undefined, request = undefined) => maybeCompleteRequest(request, null, cottontail.realpathSync(String(path), cache)),
    copyFile: (source, destination, flags = 0, request = undefined) => {
      if ((Number(flags) & (fsConstants.COPYFILE_EXCL ?? 1)) !== 0 && cottontail.existsSync(String(destination))) {
        throw bindingError(`EEXIST: file already exists, copyfile '${source}' -> '${destination}'`, "EEXIST");
      }
      cottontail.writeFile(String(destination), cottontail.readFileBuffer(String(source)));
      return maybeCompleteRequest(request, null, 0);
    },
    chmod: (path, mode, request = undefined) => maybeCompleteRequest(request, null, cottontail.chmodSync(String(path), Number(mode)) ?? 0),
    fchmod: (fd, mode, request = undefined) => maybeCompleteRequest(request, null, cottontail.fchmodSync(Number(fd), Number(mode)) ?? 0),
    chown: (path, uid, gid, request = undefined) => maybeCompleteRequest(request, null, cottontail.chownSync(String(path), Number(uid), Number(gid), true) ?? 0),
    fchown: (fd, uid, gid, request = undefined) => maybeCompleteRequest(request, null, cottontail.fchownSync(Number(fd), Number(uid), Number(gid)) ?? 0),
    lchown: (path, uid, gid, request = undefined) => maybeCompleteRequest(request, null, cottontail.chownSync(String(path), Number(uid), Number(gid), false) ?? 0),
    utimes: (path, atime, mtime, request = undefined) => maybeCompleteRequest(request, null, cottontail.utimesSync(String(path), Number(atime), Number(mtime), true) ?? 0),
    futimes: (fd, atime, mtime, request = undefined) => maybeCompleteRequest(request, null, cottontail.futimesSync(Number(fd), Number(atime), Number(mtime)) ?? 0),
    lutimes: (path, atime, mtime, request = undefined) => maybeCompleteRequest(request, null, cottontail.utimesSync(String(path), Number(atime), Number(mtime), false) ?? 0),
    mkdtemp: (prefix, request = undefined) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const path = `${String(prefix)}${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        if (!cottontail.existsSync(path)) {
          cottontail.mkdirSync(path, true);
          return maybeCompleteRequest(request, null, path);
        }
      }
      throw bindingError(`mkdtemp failed for prefix ${prefix}`);
    },
    kFsStatsFieldsNumber: 18,
    FSReqCallback: class FSReqCallback { oncomplete() {} },
    FileHandle: class FileHandle {},
    kUsePromises: Symbol("kUsePromises"),
    statValues: new Float64Array(18),
    bigintStatValues: new BigInt64Array(18),
    statFsValues: new Float64Array(11),
    bigintStatFsValues: new BigInt64Array(11),
  });
}

function makeOsBinding() {
  const loadavgValues = () => {
    if (processObject.platform === "win32") return [0, 0, 0];
    try {
      const source = cottontail.existsSync?.("/proc/loadavg") ? cottontail.readFile("/proc/loadavg") : "";
      const matches = String(source).match(/[-+]?\d+(?:\.\d+)?/g) ?? [];
      return [0, 1, 2].map((index) => Number(matches[index] ?? 0));
    } catch {
      return [0, 0, 0];
    }
  };
  return Object.freeze({
    getHostname: () => cottontail.hostname(),
    getLoadAvg(target = undefined) {
      const values = loadavgValues();
      if (target && typeof target.length === "number") {
        for (let index = 0; index < 3; index += 1) target[index] = values[index];
      }
      return values;
    },
    getUptime: () => Math.max(0, (Date.now() - processStartMs) / 1000),
    getTotalMem: () => Number(processObject.constrainedMemory?.() || processObject.availableMemory?.() || 0),
    getFreeMem: () => Number(processObject.availableMemory?.() || 0),
    getCPUs: () => Array.from({ length: Math.max(1, Number(cottontail.cpuCount?.() || 1)) }, () => ({
      model: "",
      speed: 0,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
    })),
    getInterfaceAddresses: () => typeof cottontail.osNetworkInterfaces === "function" ? cottontail.osNetworkInterfaces() : [],
    getHomeDirectory: () => cottontail.env("HOME") || cottontail.env("USERPROFILE") || "/",
    getUserInfo: () => ({
      uid: Number(processObject.getuid?.() ?? -1),
      gid: Number(processObject.getgid?.() ?? -1),
      username: cottontail.env("USER") || cottontail.env("USERNAME") || "",
      homedir: cottontail.env("HOME") || cottontail.env("USERPROFILE") || "/",
      shell: cottontail.env("SHELL") || (processObject.platform === "win32" ? cottontail.env("ComSpec") || "cmd.exe" : "/bin/sh"),
    }),
    setPriority: (pid, priority) => cottontail.osSetPriority?.(Number(pid || processObject.pid), Number(priority)),
    getPriority: (pid = 0) => typeof cottontail.osGetPriority === "function" ? Number(cottontail.osGetPriority(Number(pid || processObject.pid))) : 0,
    getAvailableParallelism: () => Math.max(1, Number(cottontail.cpuCount?.() || 1)),
    getOSInformation: () => [processObject.platform, processObject.arch, processObject.version],
    isBigEndian: () => false,
  });
}

function makeSpawnSyncBinding() {
  return Object.freeze({
    spawn(options = {}) {
      const file = String(options.file ?? options.args?.[0] ?? "");
      const rawArgs = Array.isArray(options.args) ? options.args.map(String) : [file];
      const args = rawArgs[0] === file ? rawArgs.slice(1) : rawArgs;
      const nativeOptions = {
        stdio: "pipe",
        cwd: options.cwd,
      };
      if (Array.isArray(options.envPairs)) {
        nativeOptions.clearEnv = true;
        nativeOptions.env = Object.fromEntries(options.envPairs.map((entry) => {
          const text = String(entry);
          const equals = text.indexOf("=");
          return equals < 0 ? [text, ""] : [text.slice(0, equals), text.slice(equals + 1)];
        }));
      }
      try {
        const result = cottontail.spawnSync(file, args, nativeOptions);
        const stdout = Buffer.from(result.stdout ?? "");
        const stderr = Buffer.from(result.stderr ?? "");
        return {
          status: Number(result.status),
          signal: result.signal ?? null,
          output: [null, stdout, stderr],
          pid: Number(result.pid ?? 0),
        };
      } catch (error) {
        return {
          error: error?.errno ?? error?.code ?? -1,
          status: null,
          signal: null,
          output: [null, Buffer.alloc(0), Buffer.alloc(0)],
          pid: 0,
        };
      }
    },
  });
}

function crc32(data, value = 0) {
  let crc = (Number(value) ^ -1) >>> 0;
  for (const byte of bufferView(data)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  }
  return (crc ^ -1) >>> 0;
}

function makeZlibBinding() {
  return Object.freeze({
    ...zlibBindingConstants,
    ZLIB_VERSION: zlibBindingConstants.ZLIB_VERSION ?? "1.3.1",
    crc32,
    Zlib: class Zlib {},
    BrotliEncoder: class BrotliEncoder {},
    BrotliDecoder: class BrotliDecoder {},
    ZstdCompress: class ZstdCompress {},
    ZstdDecompress: class ZstdDecompress {},
  });
}

function makeNativesBinding() {
  const names = new Set([
    "assert", "assert/strict", "async_hooks", "buffer", "child_process", "cluster", "console",
    "constants", "crypto", "diagnostics_channel", "dgram", "dns", "dns/promises", "domain",
    "events", "fs", "fs/promises", "http", "http2", "https", "inspector", "inspector/promises",
    "module", "os", "path", "path/posix", "path/win32", "perf_hooks", "process", "punycode",
    "querystring", "readline", "readline/promises", "repl", "stream", "stream/consumers",
    "stream/promises", "stream/web", "string_decoder", "sys", "timers", "timers/promises",
    "tls", "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi",
    "worker_threads", "zlib",
  ]);
  const map = globalThis.__cottontailBuiltinModules;
  if (map) {
    for (const key of map.keys()) names.add(String(key).replace(/^node:/, ""));
  }
  const output = {};
  for (const name of names) {
    output[name] = `module.exports = require(${JSON.stringify(`node:${name}`)});`;
  }
  return Object.freeze(output);
}

const utilBinding = Object.freeze(Object.fromEntries(
  [
    "isAnyArrayBuffer",
    "isArrayBuffer",
    "isArrayBufferView",
    "isAsyncFunction",
    "isDataView",
    "isDate",
    "isExternal",
    "isMap",
    "isMapIterator",
    "isNativeError",
    "isPromise",
    "isRegExp",
    "isSet",
    "isSetIterator",
    "isTypedArray",
    "isUint8Array",
  ].map((name) => [name, utilTypes[name] ?? (() => false)]),
));
const uvBinding = (() => {
  const byNegativeCode = new Map();
  const out = {
    errname(code) {
      const normalized = Number(code);
      if (!Number.isInteger(normalized) || normalized >= 0) throw new RangeError(`Unknown system error ${code}`);
      return byNegativeCode.get(normalized) ?? `Unknown system error ${normalized}`;
    },
  };
  for (const [name, value] of Object.entries(errnoConstants)) {
    const uvName = `UV_${name}`;
    const uvValue = -Math.abs(Number(value));
    out[uvName] = uvValue;
    byNegativeCode.set(uvValue, name);
  }
  return Object.freeze(out);
})();

const processBindingCache = new Map();

function makeProcessBinding(name) {
  switch (name) {
    case "natives":
      return makeNativesBinding();
    case "constants":
      return Object.freeze({
        os: Object.freeze({
          dlopen: dlopenConstants,
          errno: errnoConstants,
          signals: signalConstants,
          priority: priorityConstants,
        }),
        fs: fsConstants,
        crypto: cryptoConstants,
        zlib: zlibBindingConstants,
        trace: Object.freeze({}),
        internal: Object.freeze({}),
      });
    case "fs":
      return makeFsBinding();
    case "buffer":
      return makeBufferBinding();
    case "os":
      return makeOsBinding();
    case "spawn_sync":
      return makeSpawnSyncBinding();
    case "zlib":
      return makeZlibBinding();
    case "uv":
      return uvBinding;
    case "util":
      return utilBinding;
    case "config":
      return Object.freeze({
        isDebugBuild: false,
        openSSLIsBoringSSL: false,
        hasOpenSSL: true,
        fipsMode: false,
        hasIntl: typeof Intl === "object",
        hasTracing: false,
        hasNodeOptions: true,
        hasInspector: Boolean(processObject.features?.inspector),
        noBrowserGlobals: false,
        bits: processObject.arch === "x64" || processObject.arch === "arm64" ? 64 : 32,
        getDefaultLocale: () => Intl.DateTimeFormat().resolvedOptions().locale,
      });
    default:
      throwNoSuchBinding(name);
  }
}

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const equals = trimmed.indexOf("=");
  if (equals < 0) return null;
  const key = trimmed.slice(0, equals).trim();
  let value = trimmed.slice(equals + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return key ? [key, value] : null;
}

function makeReport() {
  const reportObject = {
    directory: "",
    filename: "report.json",
    compact: false,
    excludeNetwork: false,
    signal: "SIGUSR2",
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    excludeEnv: false,
    getReport(error = undefined) {
      return {
        header: {
          event: error ? "Exception" : "JavaScript API",
          trigger: "GetReport",
          filename: this.filename,
          dumpEventTime: new Date().toISOString(),
          processId: pid,
          cwd: cwd(),
          commandLine: [...argv],
          nodejsVersion: version,
          cottontailVersion: versions.cottontail,
        },
        javascriptStack: error ? { message: String(error?.message ?? error), stack: String(error?.stack ?? "") } : {},
        resourceUsage: resourceUsage(),
        environmentVariables: this.excludeEnv ? {} : { ...env },
      };
    },
    writeReport(filename = undefined, error = undefined) {
      const output = filename || this.filename || "report.json";
      const data = JSON.stringify(this.getReport(error), null, this.compact ? 0 : 2);
      cottontail.writeFile(output, data);
      return output;
    },
  };
  return reportObject;
}

const cottontailExecPath = cottontail.execPath?.() ?? "cottontail";
const cottontailArgv = Array.isArray(cottontail.argv) ? [...cottontail.argv] : [cottontailExecPath, ...(cottontail.args || [])];
if (cottontailArgv.length === 0) cottontailArgv.push(cottontailExecPath);
if (cottontailArgv[0] === "cottontail") cottontailArgv[0] = cottontailExecPath;
const processObject = globalThis.process ?? {
  argv: cottontailArgv,
  argv0: cottontailExecPath,
  execPath: cottontailExecPath,
  env: cottontail.env(),
  platform: cottontail.platform(),
  arch: cottontail.arch(),
  pid: cottontail.pid?.() ?? 0,
  versions: { node: "24.0.0", cottontail: "0.0.0-dev" },
  release: { name: "cottontail" },
};

globalThis.process = processObject;
createEventApi(processObject);

processObject.argv ??= cottontailArgv;
if (Array.isArray(processObject.argv) && processObject.argv[0] === "cottontail") processObject.argv[0] = cottontailExecPath;
processObject.argv0 ??= cottontailExecPath;
processObject.execPath ??= cottontailExecPath;
processObject.env ??= cottontail.env();
processObject.platform ??= cottontail.platform();
processObject.arch ??= cottontail.arch();
processObject.pid ??= cottontail.pid?.() ?? 0;
processObject.ppid = processInfo("ppid");
processObject.version ??= "v24.0.0";
processObject.versions ??= { node: "24.0.0", cottontail: "0.0.0-dev" };
processObject.versions.node ??= "24.0.0";
processObject.versions.cottontail ??= "0.0.0-dev";
processObject.release ??= { name: "cottontail" };
processObject.title ??= "cottontail";
processObject.browser ??= false;
processObject.execArgv ??= Array.from(cottontail.execArgv || []);
processObject._preload_modules ??= [];
processObject.moduleLoadList ??= [];
processObject.debugPort ??= 9229;
processObject.domain ??= null;
processObject._exiting ??= false;
processObject.exitCode ??= undefined;
processObject.stdin ??= createReadableStdio(0);
processObject.stdout ??= createWritableStdio(1);
processObject.stderr ??= createWritableStdio(2);
processObject.config ??= {
  target_defaults: {
    cflags: [],
    default_configuration: "Release",
    defines: [],
    include_dirs: [],
    libraries: [],
  },
  variables: {
    host_arch: processObject.arch,
    target_arch: processObject.arch,
    node_target_type: "executable",
    node_use_openssl: true,
    node_shared_zlib: false,
  },
};
processObject.features ??= {
  inspector: false,
  debug: false,
  uv: false,
  ipv6: true,
  tls_alpn: false,
  tls_sni: false,
  tls_ocsp: false,
  tls: false,
  cached_builtins: false,
  require_module: true,
  typescript: true,
};

export const argv = processObject.argv;
export const argv0 = processObject.argv0;
export const execPath = processObject.execPath;
export const env = processObject.env;
export const platform = processObject.platform;
export const arch = processObject.arch;
export const versions = processObject.versions;
export const release = processObject.release;
export const pid = processObject.pid;
export const ppid = processObject.ppid;
export const stdin = processObject.stdin;
export const stdout = processObject.stdout;
export const stderr = processObject.stderr;
export const version = processObject.version;
export const title = processObject.title;
export const browser = processObject.browser;
export const execArgv = processObject.execArgv;
export const _preload_modules = processObject._preload_modules;
export const moduleLoadList = processObject.moduleLoadList;
export const debugPort = processObject.debugPort;
export const domain = processObject.domain;
export const config = processObject.config;
export const features = processObject.features;
export const _events = processObject._events;
export const _eventsCount = processObject._eventsCount;
export const _maxListeners = processObject._maxListeners;
export let _exiting = processObject._exiting;
export let exitCode = processObject.exitCode;
export let sourceMapsEnabled = sourceMapsState;
export const allowedNodeEnvironmentFlags = new Set([
  "--conditions",
  "--enable-source-maps",
  "--experimental-modules",
  "--inspect",
  "--inspect-brk",
  "--loader",
  "--max-old-space-size",
  "--no-deprecation",
  "--preserve-symlinks",
  "--require",
  "--throw-deprecation",
  "--trace-deprecation",
  "--trace-warnings",
  "--unhandled-rejections",
]);

export const cwd = processObject.cwd = () => cottontail.cwd();

export const chdir = processObject.chdir = (directory) => {
  processInfo("chdir", String(directory));
};

export const exit = processObject.exit = (code = processObject.exitCode ?? 0) => {
  processObject._exiting = true;
  _exiting = true;
  cottontail.exit(Number(code ?? 0));
};

export const reallyExit = processObject.reallyExit = (code = processObject.exitCode ?? 0) => {
  cottontail.exit(Number(code ?? 0));
};

export const abort = processObject.abort = () => {
  cottontail.kill(processObject.pid, signalNumber("SIGABRT"));
};

export const nextTick = processObject.nextTick = (callback, ...args) => {
  if (typeof callback !== "function") throw new TypeError("process.nextTick callback must be a function");
  queueMicrotask(() => callback(...args));
};

export const hrtime = processObject.hrtime = makeHrtime;
export const uptime = processObject.uptime = () => (Date.now() - processStartMs) / 1000;

export const kill = processObject.kill = (targetPid = processObject.pid, signal = "SIGTERM") =>
  cottontail.kill(Number(targetPid), signalNumber(signal));

export const _kill = processObject._kill = kill;

export const cpuUsage = processObject.cpuUsage = (previous = undefined) => makeCpuUsage("resourceUsage", previous);
export const threadCpuUsage = processObject.threadCpuUsage = (previous = undefined) => makeCpuUsage("threadResourceUsage", previous);
export const resourceUsage = processObject.resourceUsage = () => processInfo("resourceUsage");
export const memoryUsage = processObject.memoryUsage = makeMemoryUsage;
export const availableMemory = processObject.availableMemory = () => Number(processInfo("availableMemory")) || 0;
export const constrainedMemory = processObject.constrainedMemory = () => Number(processInfo("constrainedMemory")) || 0;

export const getuid = processObject.getuid = () => Number(processInfo("getuid"));
export const geteuid = processObject.geteuid = () => Number(processInfo("geteuid"));
export const getgid = processObject.getgid = () => Number(processInfo("getgid"));
export const getegid = processObject.getegid = () => Number(processInfo("getegid"));
export const getgroups = processObject.getgroups = () => Array.from(processInfo("getgroups") ?? [], Number);
export const setuid = processObject.setuid = (id) => processInfo("setuid", Number(id));
export const seteuid = processObject.seteuid = (id) => processInfo("seteuid", Number(id));
export const setgid = processObject.setgid = (id) => processInfo("setgid", Number(id));
export const setegid = processObject.setegid = (id) => processInfo("setegid", Number(id));
export const setgroups = processObject.setgroups = (groups) => processInfo("setgroups", Array.from(groups ?? [], Number));
export const initgroups = processObject.initgroups = (user, extraGroup) => processInfo("initgroups", String(user), Number(extraGroup));
export const umask = processObject.umask = (mask = undefined) => processInfo("umask", mask == null ? undefined : Number(mask));

export const openStdin = processObject.openStdin = () => {
  processObject.stdin.resume?.();
  return processObject.stdin;
};

export const ref = processObject.ref = (maybeRefable = undefined) => {
  maybeRefable?.ref?.();
};

export const unref = processObject.unref = (maybeRefable = undefined) => {
  maybeRefable?.unref?.();
};

export const _getActiveHandles = processObject._getActiveHandles = () =>
  [processObject.stdin, processObject.stdout, processObject.stderr].filter(Boolean);

export const _getActiveRequests = processObject._getActiveRequests = () => [];
export const getActiveResourcesInfo = processObject.getActiveResourcesInfo = () => [];

export const emitWarning = processObject.emitWarning = (warning, type = "Warning", code = undefined, ctor = undefined) => {
  const error = warning instanceof Error ? warning : new Error(String(warning));
  error.name = type || error.name || "Warning";
  if (code != null) error.code = String(code);
  if (typeof ctor === "function" && Error.captureStackTrace) Error.captureStackTrace(error, ctor);
  if (!processObject.emit("warning", error)) {
    const line = `${error.name}${error.code ? ` [${error.code}]` : ""}: ${error.message}\n`;
    cottontail.fdWrite?.(2, line);
  }
};

export const _rawDebug = processObject._rawDebug = (...args) => {
  cottontail.fdWrite?.(2, `${args.map(String).join(" ")}\n`);
};

export const _fatalException = processObject._fatalException = (error) => {
  if (typeof uncaughtExceptionCaptureCallback === "function") {
    uncaughtExceptionCaptureCallback(error);
    return true;
  }
  return processObject.emit("uncaughtException", error);
};

export const setUncaughtExceptionCaptureCallback = processObject.setUncaughtExceptionCaptureCallback = (callback) => {
  if (callback != null && typeof callback !== "function") {
    throw new TypeError("callback must be a function or null");
  }
  uncaughtExceptionCaptureCallback = callback;
};

export const hasUncaughtExceptionCaptureCallback = processObject.hasUncaughtExceptionCaptureCallback = () =>
  typeof uncaughtExceptionCaptureCallback === "function";

export const setSourceMapsEnabled = processObject.setSourceMapsEnabled = (enabled) => {
  sourceMapsState = Boolean(enabled);
  sourceMapsEnabled = sourceMapsState;
};

export const _tickCallback = processObject._tickCallback = () => cottontail.drainJobs?.();
export const _debugEnd = processObject._debugEnd = () => {};
export const _debugProcess = processObject._debugProcess = (targetPid) => cottontail.kill(Number(targetPid), signalNumber("SIGUSR1"));
export const _startProfilerIdleNotifier = processObject._startProfilerIdleNotifier = () => {};
export const _stopProfilerIdleNotifier = processObject._stopProfilerIdleNotifier = () => {};

export const binding = processObject.binding = (name) => {
  const key = String(name);
  if (!processBindingCache.has(key)) processBindingCache.set(key, makeProcessBinding(key));
  return processBindingCache.get(key);
};

export const _linkedBinding = processObject._linkedBinding = (name) => {
  throw bindingError(`No such binding was linked: ${String(name)}`, "ERR_INVALID_MODULE");
};

export const dlopen = processObject.dlopen = (module, filename = undefined) => {
  const target = filename ?? module?.filename ?? module?.id ?? "";
  throw bindingError(`dlopen(${String(target)}, 0x0001): native add-on loading is pending for Cottontail`, "ERR_DLOPEN_FAILED");
};

export const execve = processObject.execve = (file, args, execEnv) => {
  if (typeof file !== "string") throw new TypeError('The "execPath" argument must be of type string');
  if (!Array.isArray(args)) throw new TypeError('The "args" argument must be an Array');
  if (execEnv == null || typeof execEnv !== "object" || Array.isArray(execEnv)) throw new TypeError('The "env" argument must be an object');
  return cottontail.processExecve(file, args.map(String), execEnv);
};

export const getBuiltinModule = processObject.getBuiltinModule = (specifier) => {
  const text = String(specifier);
  const map = globalThis.__cottontailBuiltinModules;
  if (map?.has(text)) return map.get(text);
  if (text.startsWith("node:") && map?.has(text.slice(5))) return map.get(text.slice(5));
  if (text === "process" || text === "node:process") return processObject;
  return undefined;
};

export const loadEnvFile = processObject.loadEnvFile = (path = ".env") => {
  const source = cottontail.readFile(String(path));
  for (const line of source.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (parsed) processObject.env[parsed[0]] = parsed[1];
  }
};

export const finalization = processObject.finalization = (() => {
  const registry = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((callback) => {
      if (typeof callback === "function") callback();
    })
    : null;
  const callbacks = new WeakMap();
  return {
    register(refValue, callback) {
      if (registry && refValue && typeof refValue === "object") {
        callbacks.set(refValue, callback);
        registry.register(refValue, callback, refValue);
      }
    },
    registerBeforeExit(refValue, callback) {
      this.register(refValue, callback);
    },
    unregister(refValue) {
      callbacks.delete(refValue);
      registry?.unregister?.(refValue);
    },
  };
})();

export const report = processObject.report = makeReport();

// COTTONTAIL-COMPAT: node:process addon ABI - process metadata, credentials, signals, reports, env loading, execve, and common internal bindings use native host APIs; N-API module initialization still needs a Node-compatible ABI entrypoint.

export const on = processObject.on.bind(processObject);
export const once = processObject.once.bind(processObject);
export const off = processObject.off.bind(processObject);
export const emit = processObject.emit.bind(processObject);

export default processObject;
