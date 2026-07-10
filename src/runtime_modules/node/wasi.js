import { Buffer } from "./buffer.js";

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_EXIST = 20;
const ERRNO_FAULT = 21;
const ERRNO_INVAL = 28;
const ERRNO_IO = 29;
const ERRNO_ISDIR = 31;
const ERRNO_NOENT = 44;
const ERRNO_NOSYS = 52;
const ERRNO_NOTDIR = 54;

const FILETYPE_CHARACTER_DEVICE = 2;
const FILETYPE_DIRECTORY = 3;
const FILETYPE_REGULAR_FILE = 4;
const FILETYPE_SYMBOLIC_LINK = 7;
const RIGHTS_ALL = 0xffffffffffffffffn;
const OFLAGS_CREAT = 1;
const OFLAGS_DIRECTORY = 2;
const OFLAGS_EXCL = 4;
const OFLAGS_TRUNC = 8;
const FDFLAGS_APPEND = 1;
const EVENTTYPE_CLOCK = 0;
const EVENTTYPE_FD_READ = 1;
const EVENTTYPE_FD_WRITE = 2;
const SUBSCRIPTION_CLOCK_ABSTIME = 1;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class WASIExit extends Error {
  constructor(code) {
    super(`WASI exited with code ${code}`);
    this.code = "WASI_EXIT";
    this.exitCode = Number(code) || 0;
  }
}

function bytesForStrings(values) {
  return values.reduce((total, value) => total + textEncoder.encode(value).byteLength + 1, 0);
}

function writeStream(fd, bytes) {
  const process = globalThis.process;
  const stream = fd === 2 ? process?.stderr : process?.stdout;
  if (stream && typeof stream.write === "function") {
    stream.write(Buffer.from(bytes));
  }
}

function errnoFromError(error) {
  switch (error?.code) {
    case "ENOENT":
      return ERRNO_NOENT;
    case "EEXIST":
      return ERRNO_EXIST;
    case "ENOTDIR":
      return ERRNO_NOTDIR;
    case "EBADF":
      return ERRNO_BADF;
    default:
      return ERRNO_IO;
  }
}

function wasiFiletype(stat) {
  const mode = Number(stat?.mode) || 0;
  const masked = mode & 0o170000;
  if (stat?.isDirectory || masked === 0o040000) return FILETYPE_DIRECTORY;
  if (stat?.isSymbolicLink || masked === 0o120000) return FILETYPE_SYMBOLIC_LINK;
  if (stat?.isFile || masked === 0o100000) return FILETYPE_REGULAR_FILE;
  return 0;
}

function sandboxJoin(root, relative) {
  const parts = [];
  for (const part of String(relative || ".").split(/[\\/]+/)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? String(root) : `${String(root).replace(/[\\/]+$/, "")}/${parts.join("/")}`;
}

export class WASI {
  constructor(options = {}) {
    if (options.version != null && options.version !== "preview1") {
      throw new TypeError('The "options.version" property must be "preview1" when provided');
    }
    this.args = Array.from(options.args ?? [], String);
    this.env = { ...(options.env ?? {}) };
    this.preopens = { ...(options.preopens ?? {}) };
    this.returnOnExit = options.returnOnExit === true;
    this._instance = null;
    this._preopenEntries = Object.entries(this.preopens);
    this._fds = new Map();
    this._nextFd = 3 + this._preopenEntries.length;
    this.wasiImport = this._makeImportObject();
  }

  _memory() {
    const memory = this._instance?.exports?.memory;
    return memory instanceof WebAssembly.Memory ? memory : null;
  }

  _bytes(ptr, len) {
    const memory = this._memory();
    if (!memory) return null;
    const start = Number(ptr) >>> 0;
    const length = Number(len) >>> 0;
    if (start + length > memory.buffer.byteLength) return null;
    return new Uint8Array(memory.buffer, start, length);
  }

  _view(ptr, len) {
    const memory = this._memory();
    if (!memory) return null;
    const start = Number(ptr) >>> 0;
    const length = Number(len) >>> 0;
    if (start + length > memory.buffer.byteLength) return null;
    return new DataView(memory.buffer, start, length);
  }

  _writeU32(ptr, value) {
    const view = this._view(ptr, 4);
    if (!view) return false;
    view.setUint32(0, Number(value) >>> 0, true);
    return true;
  }

  _writeU64(ptr, value) {
    const view = this._view(ptr, 8);
    if (!view) return false;
    view.setBigUint64(0, BigInt(value), true);
    return true;
  }

  _writeBytes(ptr, bytes) {
    const target = this._bytes(ptr, bytes.byteLength);
    if (!target) return false;
    target.set(bytes);
    return true;
  }

  _stringListGet(values, pointersPtr, bufferPtr) {
    let cursor = Number(bufferPtr) >>> 0;
    for (let index = 0; index < values.length; index += 1) {
      const bytes = textEncoder.encode(`${values[index]}\0`);
      if (!this._writeU32(Number(pointersPtr) + index * 4, cursor)) return ERRNO_FAULT;
      if (!this._writeBytes(cursor, bytes)) return ERRNO_FAULT;
      cursor += bytes.byteLength;
    }
    return ERRNO_SUCCESS;
  }

  _fdForPreopen(fd) {
    const index = Number(fd) - 3;
    return index >= 0 && index < this._preopenEntries.length ? this._preopenEntries[index] : null;
  }

  _openFile(fd) {
    return this._fds.get(Number(fd)) ?? null;
  }

  _stringFromMemory(ptr, len) {
    const bytes = this._bytes(ptr, len);
    if (!bytes) return null;
    return textDecoder.decode(bytes);
  }

  _pathForPreopen(fd, pathPtr, pathLen) {
    const entry = this._fdForPreopen(fd);
    if (!entry) return { errno: ERRNO_BADF };
    const relative = this._stringFromMemory(pathPtr, pathLen);
    if (relative == null) return { errno: ERRNO_FAULT };
    const path = sandboxJoin(entry[1], relative);
    if (path == null) return { errno: ERRNO_INVAL };
    return { path };
  }

  _writeFilestat(ptr, stat) {
    const view = this._view(ptr, 64);
    if (!view) return false;
    view.setBigUint64(0, BigInt(Number(stat?.dev) || 0), true);
    view.setBigUint64(8, BigInt(Number(stat?.ino) || 0), true);
    view.setUint8(16, wasiFiletype(stat));
    view.setBigUint64(24, BigInt(Number(stat?.nlink) || 1), true);
    view.setBigUint64(32, BigInt(Number(stat?.size) || 0), true);
    view.setBigUint64(40, BigInt(Math.trunc((Number(stat?.atimeMs) || 0) * 1000000)), true);
    view.setBigUint64(48, BigInt(Math.trunc((Number(stat?.mtimeMs) || 0) * 1000000)), true);
    view.setBigUint64(56, BigInt(Math.trunc((Number(stat?.ctimeMs) || 0) * 1000000)), true);
    return true;
  }

  _writeDirent(ptr, nextCookie, stat, nameBytes) {
    const view = this._view(ptr, 24);
    if (!view) return false;
    view.setBigUint64(0, BigInt(nextCookie), true);
    view.setBigUint64(8, BigInt(Number(stat?.ino) || 0), true);
    view.setUint32(16, Number(nameBytes.byteLength) >>> 0, true);
    view.setUint8(20, wasiFiletype(stat));
    return true;
  }

  _writeEvent(ptr, userdata, errno, type, nbytes = 0, flags = 0) {
    const view = this._view(ptr, 32);
    if (!view) return false;
    view.setBigUint64(0, BigInt(userdata), true);
    view.setUint16(8, Number(errno) >>> 0, true);
    view.setUint8(10, Number(type) >>> 0);
    view.setBigUint64(16, BigInt(nbytes), true);
    view.setUint16(24, Number(flags) >>> 0, true);
    return true;
  }

  _directoryPathForFd(fd) {
    const open = this._openFile(fd);
    if (open?.directory) return open.path;
    const preopen = this._fdForPreopen(fd);
    return preopen ? preopen[1] : null;
  }

  _readIovs(iovs, iovsLen, callback) {
    let total = 0;
    for (let index = 0; index < Number(iovsLen); index += 1) {
      const view = this._view(Number(iovs) + index * 8, 8);
      if (!view) return { errno: ERRNO_FAULT, total };
      const ptr = view.getUint32(0, true);
      const len = view.getUint32(4, true);
      const bytes = this._bytes(ptr, len);
      if (!bytes) return { errno: ERRNO_FAULT, total };
      const count = callback(bytes, total);
      total += Number(count);
      if (Number(count) < len) break;
    }
    return { errno: ERRNO_SUCCESS, total };
  }

  _makeImportObject() {
    const imports = {
      args_get: (argv, argvBuf) => this._stringListGet(this.args, argv, argvBuf),
      args_sizes_get: (argcPtr, argvBufSizePtr) => (
        this._writeU32(argcPtr, this.args.length) && this._writeU32(argvBufSizePtr, bytesForStrings(this.args))
      ) ? ERRNO_SUCCESS : ERRNO_FAULT,
      environ_get: (environ, environBuf) => this._stringListGet(this._envStrings(), environ, environBuf),
      environ_sizes_get: (countPtr, sizePtr) => {
        const env = this._envStrings();
        return this._writeU32(countPtr, env.length) && this._writeU32(sizePtr, bytesForStrings(env)) ? ERRNO_SUCCESS : ERRNO_FAULT;
      },
      clock_res_get: (_clockId, resultPtr) => this._writeU64(resultPtr, 1000000n) ? ERRNO_SUCCESS : ERRNO_FAULT,
      clock_time_get: (clockId, _precision, resultPtr) => {
        const now = Number(clockId) === 1 && globalThis.performance?.now
          ? BigInt(Math.floor(globalThis.performance.now() * 1000000))
          : BigInt(Date.now()) * 1000000n;
        return this._writeU64(resultPtr, now) ? ERRNO_SUCCESS : ERRNO_FAULT;
      },
      random_get: (buf, len) => {
        const bytes = this._bytes(buf, len);
        if (!bytes) return ERRNO_FAULT;
        if (globalThis.crypto?.getRandomValues) {
          globalThis.crypto.getRandomValues(bytes);
        } else {
          for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
        }
        return ERRNO_SUCCESS;
      },
      fd_write: (fd, iovs, iovsLen, nwrittenPtr) => {
        const open = this._openFile(fd);
        if (![1, 2].includes(Number(fd)) && !open) return ERRNO_BADF;
        if (open?.directory) return ERRNO_ISDIR;
        const result = this._readIovs(iovs, iovsLen, (bytes) => {
          if ([1, 2].includes(Number(fd))) {
            writeStream(Number(fd), bytes);
            return bytes.byteLength;
          }
          const position = open.append ? null : open.position;
          const buffer = Buffer.alloc(bytes.byteLength);
          for (let index = 0; index < bytes.byteLength; index += 1) buffer[index] = bytes[index];
          const count = Number(cottontail.fdWriteAt(open.hostFd, buffer, 0, buffer.byteLength, position));
          open.position += count;
          return count;
        });
        return result.errno === ERRNO_SUCCESS && this._writeU32(nwrittenPtr, result.total) ? ERRNO_SUCCESS : result.errno;
      },
      fd_read: (fd, iovs, iovsLen, nreadPtr) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        const result = this._readIovs(iovs, iovsLen, (bytes) => {
          const buffer = Buffer.alloc(bytes.byteLength);
          const count = Number(cottontail.fdReadAt(open.hostFd, buffer, 0, buffer.byteLength, open.position));
          for (let index = 0; index < count; index += 1) bytes[index] = buffer[index];
          open.position += count;
          return count;
        });
        return result.errno === ERRNO_SUCCESS && this._writeU32(nreadPtr, result.total) ? ERRNO_SUCCESS : result.errno;
      },
      fd_pread: (fd, iovs, iovsLen, offset, nreadPtr) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        let position = Number(offset);
        const result = this._readIovs(iovs, iovsLen, (bytes) => {
          const buffer = Buffer.alloc(bytes.byteLength);
          const count = Number(cottontail.fdReadAt(open.hostFd, buffer, 0, buffer.byteLength, position));
          for (let index = 0; index < count; index += 1) bytes[index] = buffer[index];
          position += count;
          return count;
        });
        return result.errno === ERRNO_SUCCESS && this._writeU32(nreadPtr, result.total) ? ERRNO_SUCCESS : result.errno;
      },
      fd_pwrite: (fd, iovs, iovsLen, offset, nwrittenPtr) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        let position = Number(offset);
        const result = this._readIovs(iovs, iovsLen, (bytes) => {
          const buffer = Buffer.alloc(bytes.byteLength);
          for (let index = 0; index < bytes.byteLength; index += 1) buffer[index] = bytes[index];
          const count = Number(cottontail.fdWriteAt(open.hostFd, buffer, 0, buffer.byteLength, position));
          position += count;
          return count;
        });
        return result.errno === ERRNO_SUCCESS && this._writeU32(nwrittenPtr, result.total) ? ERRNO_SUCCESS : result.errno;
      },
      fd_seek: (fd, offset, whence, newOffsetPtr) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        const value = Number(offset);
        if (Number(whence) === 0) open.position = value;
        else if (Number(whence) === 1) open.position += value;
        else if (Number(whence) === 2) open.position = Number(cottontail.fstatSync(open.hostFd)?.size ?? 0) + value;
        else return ERRNO_INVAL;
        if (open.position < 0) return ERRNO_INVAL;
        return this._writeU64(newOffsetPtr, BigInt(open.position)) ? ERRNO_SUCCESS : ERRNO_FAULT;
      },
      fd_tell: (fd, offsetPtr) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        return this._writeU64(offsetPtr, BigInt(open.position)) ? ERRNO_SUCCESS : ERRNO_FAULT;
      },
      fd_close: (fd) => {
        const number = Number(fd);
        const open = this._openFile(number);
        if (!open) return number > 2 && this._fdForPreopen(number) == null ? ERRNO_SUCCESS : ERRNO_BADF;
        try {
          if (open.hostFd != null) cottontail.closeFd(open.hostFd);
          this._fds.delete(number);
          return ERRNO_SUCCESS;
        } catch (error) {
          return errnoFromError(error);
        }
      },
      fd_fdstat_get: (fd, statPtr) => {
        const open = this._openFile(fd);
        const filetype = Number(fd) <= 2 ? FILETYPE_CHARACTER_DEVICE : (this._fdForPreopen(fd) || open?.directory ? FILETYPE_DIRECTORY : (open ? FILETYPE_REGULAR_FILE : 0));
        if (filetype === 0) return ERRNO_BADF;
        const view = this._view(statPtr, 24);
        if (!view) return ERRNO_FAULT;
        view.setUint8(0, filetype);
        view.setUint16(2, 0, true);
        view.setBigUint64(8, RIGHTS_ALL, true);
        view.setBigUint64(16, RIGHTS_ALL, true);
        return ERRNO_SUCCESS;
      },
      fd_prestat_get: (fd, prestatPtr) => {
        const entry = this._fdForPreopen(fd);
        if (!entry) return ERRNO_BADF;
        const name = entry[0];
        const view = this._view(prestatPtr, 8);
        if (!view) return ERRNO_FAULT;
        view.setUint8(0, 0);
        view.setUint32(4, Buffer.byteLength(name), true);
        return ERRNO_SUCCESS;
      },
      fd_prestat_dir_name: (fd, pathPtr, pathLen) => {
        const entry = this._fdForPreopen(fd);
        if (!entry) return ERRNO_BADF;
        const bytes = textEncoder.encode(entry[0]);
        if (bytes.byteLength > Number(pathLen)) return ERRNO_FAULT;
        return this._writeBytes(pathPtr, bytes) ? ERRNO_SUCCESS : ERRNO_FAULT;
      },
      fd_filestat_get: (fd, statPtr) => {
        const open = this._openFile(fd);
        try {
          const stat = open?.directory ? cottontail.statSync(open.path, true) : (open ? cottontail.fstatSync(open.hostFd) : (this._fdForPreopen(fd) ? cottontail.statSync(this._fdForPreopen(fd)[1], true) : null));
          if (!stat) return ERRNO_BADF;
          return this._writeFilestat(statPtr, stat) ? ERRNO_SUCCESS : ERRNO_FAULT;
        } catch (error) {
          return errnoFromError(error);
        }
      },
      fd_sync: (fd) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        try { cottontail.fsyncSync(open.hostFd); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      fd_datasync: (fd) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        try { cottontail.fdatasyncSync(open.hostFd); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      fd_filestat_set_size: (fd, size) => {
        const open = this._openFile(fd);
        if (!open) return ERRNO_BADF;
        if (open.directory) return ERRNO_ISDIR;
        try { cottontail.ftruncateSync(open.hostFd, Number(size)); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      fd_readdir: (fd, bufPtr, bufLen, cookie, bufusedPtr) => {
        const directoryPath = this._directoryPathForFd(fd);
        if (!directoryPath) return ERRNO_BADF;
        try {
          const entries = Array.from(cottontail.readDirSync(directoryPath) ?? [])
            .map((entry) => ({
              name: String(entry.name),
              stat: entry,
              bytes: textEncoder.encode(String(entry.name)),
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
          let cursor = Number(bufPtr) >>> 0;
          const end = cursor + (Number(bufLen) >>> 0);
          let used = 0;
          const start = Number(cookie) || 0;
          for (let index = start; index < entries.length; index += 1) {
            const entry = entries[index];
            if (cursor + 24 > end) break;
            if (!this._writeDirent(cursor, BigInt(index + 1), entry.stat, entry.bytes)) return ERRNO_FAULT;
            cursor += 24;
            used += 24;
            const available = end - cursor;
            const count = Math.min(entry.bytes.byteLength, available);
            if (count > 0 && !this._writeBytes(cursor, entry.bytes.subarray(0, count))) return ERRNO_FAULT;
            cursor += count;
            used += count;
            if (count < entry.bytes.byteLength) break;
          }
          return this._writeU32(bufusedPtr, used) ? ERRNO_SUCCESS : ERRNO_FAULT;
        } catch (error) {
          return errnoFromError(error);
        }
      },
      path_open: (fd, _dirflags, pathPtr, pathLen, oflags, _rightsBase, _rightsInheriting, fdflags, openedFdPtr) => {
        const resolved = this._pathForPreopen(fd, pathPtr, pathLen);
        if (resolved.errno) return resolved.errno;
        try {
          if ((Number(oflags) & OFLAGS_DIRECTORY) !== 0) {
            const stat = cottontail.statSync(resolved.path, true);
            if (wasiFiletype(stat) !== FILETYPE_DIRECTORY) return ERRNO_NOTDIR;
            const wasiFd = this._nextFd++;
            this._fds.set(wasiFd, { path: resolved.path, directory: true, position: 0, append: false });
            return this._writeU32(openedFdPtr, wasiFd) ? ERRNO_SUCCESS : ERRNO_FAULT;
          }
          if ((Number(oflags) & OFLAGS_EXCL) !== 0 && cottontail.existsSync(resolved.path)) return ERRNO_EXIST;
          const createOrTruncate = (Number(oflags) & (OFLAGS_CREAT | OFLAGS_TRUNC)) !== 0;
          const append = (Number(fdflags) & FDFLAGS_APPEND) !== 0;
          const hostFd = cottontail.openFd(resolved.path, append ? "a+" : (createOrTruncate ? "w+" : "r+"), 0o666);
          const wasiFd = this._nextFd++;
          const position = append ? Number(cottontail.fstatSync(hostFd)?.size ?? 0) : 0;
          this._fds.set(wasiFd, { hostFd, path: resolved.path, position, append });
          return this._writeU32(openedFdPtr, wasiFd) ? ERRNO_SUCCESS : ERRNO_FAULT;
        } catch (error) {
          return errnoFromError(error);
        }
      },
      path_create_directory: (fd, pathPtr, pathLen) => {
        const resolved = this._pathForPreopen(fd, pathPtr, pathLen);
        if (resolved.errno) return resolved.errno;
        try { cottontail.mkdirSync(resolved.path, false); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      path_filestat_get: (fd, flags, pathPtr, pathLen, statPtr) => {
        const resolved = this._pathForPreopen(fd, pathPtr, pathLen);
        if (resolved.errno) return resolved.errno;
        try {
          const follow = (Number(flags) & 1) !== 0;
          return this._writeFilestat(statPtr, cottontail.statSync(resolved.path, follow)) ? ERRNO_SUCCESS : ERRNO_FAULT;
        } catch (error) {
          return errnoFromError(error);
        }
      },
      path_remove_directory: (fd, pathPtr, pathLen) => {
        const resolved = this._pathForPreopen(fd, pathPtr, pathLen);
        if (resolved.errno) return resolved.errno;
        try { cottontail.rmdirSync(resolved.path); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      path_unlink_file: (fd, pathPtr, pathLen) => {
        const resolved = this._pathForPreopen(fd, pathPtr, pathLen);
        if (resolved.errno) return resolved.errno;
        try { cottontail.unlinkSync(resolved.path); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      path_rename: (oldFd, oldPathPtr, oldPathLen, newFd, newPathPtr, newPathLen) => {
        const oldPath = this._pathForPreopen(oldFd, oldPathPtr, oldPathLen);
        if (oldPath.errno) return oldPath.errno;
        const newPath = this._pathForPreopen(newFd, newPathPtr, newPathLen);
        if (newPath.errno) return newPath.errno;
        try { cottontail.renameSync(oldPath.path, newPath.path); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      path_symlink: (oldPathPtr, oldPathLen, fd, newPathPtr, newPathLen) => {
        const target = this._stringFromMemory(oldPathPtr, oldPathLen);
        if (target == null) return ERRNO_FAULT;
        const newPath = this._pathForPreopen(fd, newPathPtr, newPathLen);
        if (newPath.errno) return newPath.errno;
        try { cottontail.symlinkSync(target, newPath.path); return ERRNO_SUCCESS; } catch (error) { return errnoFromError(error); }
      },
      path_readlink: (fd, pathPtr, pathLen, bufferPtr, bufferLen, resultSizePtr) => {
        const resolved = this._pathForPreopen(fd, pathPtr, pathLen);
        if (resolved.errno) return resolved.errno;
        try {
          const bytes = textEncoder.encode(cottontail.readlinkSync(resolved.path));
          const count = Math.min(bytes.byteLength, Number(bufferLen));
          if (!this._writeBytes(bufferPtr, bytes.subarray(0, count))) return ERRNO_FAULT;
          return this._writeU32(resultSizePtr, count) ? ERRNO_SUCCESS : ERRNO_FAULT;
        } catch (error) {
          return errnoFromError(error);
        }
      },
      proc_exit: (code) => {
        const exitCode = Number(code) || 0;
        if (this.returnOnExit) throw new WASIExit(exitCode);
        if (typeof globalThis.process?.exit === "function") globalThis.process.exit(exitCode);
        throw new WASIExit(exitCode);
      },
      sched_yield: () => ERRNO_SUCCESS,
      poll_oneoff: (subscriptionsPtr, eventsPtr, subscriptionCount, eventsCountPtr) => {
        const count = Number(subscriptionCount) >>> 0;
        if (count === 0) return this._writeU32(eventsCountPtr, 0) ? ERRNO_SUCCESS : ERRNO_FAULT;
        const events = [];
        let clockDelayNs = null;
        for (let index = 0; index < count; index += 1) {
          const view = this._view(Number(subscriptionsPtr) + index * 48, 48);
          if (!view) return ERRNO_FAULT;
          const userdata = view.getBigUint64(0, true);
          const type = view.getUint8(8);
          if (type === EVENTTYPE_CLOCK) {
            const timeout = view.getBigUint64(24, true);
            const flags = view.getUint16(40, true);
            let delayNs = timeout;
            if ((flags & SUBSCRIPTION_CLOCK_ABSTIME) !== 0) {
              const now = BigInt(Date.now()) * 1000000n;
              delayNs = timeout > now ? timeout - now : 0n;
            }
            clockDelayNs = clockDelayNs == null || delayNs < clockDelayNs ? delayNs : clockDelayNs;
            events.push({ userdata, type, errno: ERRNO_SUCCESS });
          } else if (type === EVENTTYPE_FD_READ || type === EVENTTYPE_FD_WRITE) {
            const fd = view.getUint32(16, true);
            const open = this._openFile(fd);
            const valid = Number(fd) <= 2 || this._fdForPreopen(fd) || open;
            events.push({ userdata, type, errno: valid ? ERRNO_SUCCESS : ERRNO_BADF });
          } else {
            events.push({ userdata, type, errno: ERRNO_INVAL });
          }
        }
        if (events.length > 0 && events.every((event) => event.type === EVENTTYPE_CLOCK) && clockDelayNs != null && clockDelayNs > 0n) {
          cottontail.sleep?.(Number(clockDelayNs / 1000000n));
        }
        const eventCount = Math.min(events.length, count);
        for (let index = 0; index < eventCount; index += 1) {
          const event = events[index];
          if (!this._writeEvent(Number(eventsPtr) + index * 32, event.userdata, event.errno, event.type)) return ERRNO_FAULT;
        }
        return this._writeU32(eventsCountPtr, eventCount) ? ERRNO_SUCCESS : ERRNO_FAULT;
      },
    };
    return new Proxy(imports, {
      get(target, property) {
        if (typeof property !== "string") return target[property];
        return target[property] ?? (() => ERRNO_NOSYS);
      },
    });
  }

  _envStrings() {
    return Object.entries(this.env).map(([key, value]) => `${key}=${value}`);
  }

  getImportObject() {
    return { wasi_snapshot_preview1: this.wasiImport };
  }

  _setInstance(instance) {
    if (!instance?.exports || typeof instance.exports !== "object") {
      throw new TypeError("WASI requires a WebAssembly.Instance-like object with exports");
    }
    this._instance = instance;
  }

  start(instance) {
    this._setInstance(instance);
    const start = instance.exports._start;
    if (typeof start !== "function") throw new TypeError("WASI.start requires a WebAssembly.Instance with an _start export");
    try {
      const result = start();
      return this.returnOnExit ? Number(result ?? 0) : undefined;
    } catch (error) {
      if (error instanceof WASIExit) {
        if (this.returnOnExit) return error.exitCode;
      }
      throw error;
    }
  }

  initialize(instance) {
    this._setInstance(instance);
    const initialize = instance.exports._initialize;
    if (typeof initialize === "function") initialize();
  }
}

// COTTONTAIL-COMPAT: node:wasi inherited sockets - preview1 lifecycle, args/env, clocks, random, stdio, proc_exit, preopen metadata, fd_readdir, poll_oneoff, and preopen-backed file path operations are implemented; sock_* calls need real inherited socket fd support.

export default { WASI };
