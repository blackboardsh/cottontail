import constantsObject from "../constants.js";
import { EventEmitter } from "../events.js";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  chownSync,
  closeSync,
  copyFileSync,
  cpSync,
  createReadStream,
  createWriteStream,
  fchmodSync,
  fchownSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  futimesSync,
  globSync,
  lchmodSync,
  lchownSync,
  linkSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempDisposableSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  readvSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  statfsSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  watch as watchSync,
  writeFileSync,
  writeSync,
  writevSync,
} from "../fs.js";
import { ReadableStream as WebReadableStream } from "../stream/web.js";

// fs.constants must be the exact same object as fsPromises.constants. Because
// fs.js and fs/promises.js form an import cycle whose evaluation order depends
// on which module is reached first, both files construct the object through a
// shared global registry: whichever module body runs first creates it and the
// other reuses it. Keep the name list below in sync with fs.js. Do not read
// fs.js bindings other than hoisted function declarations at module scope.
const fsConstantNames = [
  "UV_FS_SYMLINK_DIR",
  "UV_FS_SYMLINK_JUNCTION",
  "O_RDONLY",
  "O_WRONLY",
  "O_RDWR",
  "UV_DIRENT_UNKNOWN",
  "UV_DIRENT_FILE",
  "UV_DIRENT_DIR",
  "UV_DIRENT_LINK",
  "UV_DIRENT_FIFO",
  "UV_DIRENT_SOCKET",
  "UV_DIRENT_CHAR",
  "UV_DIRENT_BLOCK",
  "S_IFMT",
  "S_IFREG",
  "S_IFDIR",
  "S_IFCHR",
  "S_IFBLK",
  "S_IFIFO",
  "S_IFLNK",
  "S_IFSOCK",
  "O_CREAT",
  "O_EXCL",
  "UV_FS_O_FILEMAP",
  "O_NOCTTY",
  "O_TRUNC",
  "O_APPEND",
  "O_DIRECTORY",
  "O_NOFOLLOW",
  "O_SYNC",
  "O_DSYNC",
  "O_SYMLINK",
  "O_NONBLOCK",
  "S_IRWXU",
  "S_IRUSR",
  "S_IWUSR",
  "S_IXUSR",
  "S_IRWXG",
  "S_IRGRP",
  "S_IWGRP",
  "S_IXGRP",
  "S_IRWXO",
  "S_IROTH",
  "S_IWOTH",
  "S_IXOTH",
  "F_OK",
  "R_OK",
  "W_OK",
  "X_OK",
  "UV_FS_COPYFILE_EXCL",
  "COPYFILE_EXCL",
  "UV_FS_COPYFILE_FICLONE",
  "COPYFILE_FICLONE",
  "UV_FS_COPYFILE_FICLONE_FORCE",
  "COPYFILE_FICLONE_FORCE",
];

export const constants = globalThis.__cottontailFsConstants ??= Object.freeze(Object.fromEntries(
  fsConstantNames
    .filter((name) => Object.prototype.hasOwnProperty.call(constantsObject, name))
    .map((name) => [name, constantsObject[name]]),
));

export async function access(path, mode = constants.F_OK) {
  return accessSync(path, mode);
}

export async function appendFile(path, data, options = undefined) {
  return appendFileSync(path, data, options);
}

export async function chmod(path, mode) {
  return chmodSync(path, mode);
}

export async function chown(path, uid, gid) {
  return chownSync(path, uid, gid);
}

export async function close(fd) {
  return closeSync(fd);
}

export async function copyFile(source, destination, mode = 0) {
  return copyFileSync(source, destination, mode);
}

export async function cp(source, destination, options = {}) {
  return cpSync(source, destination, options);
}

export async function* glob(pattern, options) {
  for (const item of globSync(pattern, options)) yield item;
}
// Keep Node-compatible function name even if a bundler renames the binding.
Object.defineProperty(glob, "name", { value: "glob" });

export async function lchmod(path, mode) {
  return lchmodSync(path, mode);
}

export async function lchown(path, uid, gid) {
  return lchownSync(path, uid, gid);
}

export async function link(existingPath, newPath) {
  return linkSync(existingPath, newPath);
}

export async function lstat(path, options = undefined) {
  return lstatSync(path, options);
}

export async function lutimes(path, atime, mtime) {
  return lutimesSync(path, atime, mtime);
}

export async function mkdir(path, options = {}) {
  return mkdirSync(path, options);
}

export async function mkdtemp(prefix) {
  return mkdtempSync(prefix);
}

export async function mkdtempDisposable(prefix) {
  return mkdtempDisposableSync(prefix);
}

let nextFileHandleAsyncId = 1;

function createReadLinesInterface(stream) {
  let closed = false;
  const lines = {
    close() {
      closed = true;
      stream.close?.();
    },
    async *[Symbol.asyncIterator]() {
      let buffered = "";
      try {
        for await (const chunk of stream) {
          if (closed) break;
          buffered += String(chunk);
          for (;;) {
            const match = buffered.match(/\r?\n/);
            if (!match) break;
            const line = buffered.slice(0, match.index);
            buffered = buffered.slice(match.index + match[0].length);
            yield line;
          }
        }
        if (!closed && buffered.length > 0) yield buffered.replace(/\r$/, "");
      } finally {
        if (!closed) lines.close();
      }
    },
  };
  return lines;
}

class FileHandle extends EventEmitter {
  constructor(fd, path) {
    super();
    this.fd = fd;
    this.path = path;
    this._asyncId = nextFileHandleAsyncId++;
    this._closed = false;
  }

  _markClosed() {
    this.fd = -1;
    if (!this._closed) {
      this._closed = true;
      this.emit("close");
    }
  }

  appendFile(data, options = undefined) { return appendFile(this.fd, data, options); }
  chmod(mode) { return Promise.resolve(fchmodSync(this.fd, mode)); }
  chown(uid, gid) { return Promise.resolve(fchownSync(this.fd, uid, gid)); }
  close() {
    const fd = this.fd;
    this.fd = -1;
    if (fd != null && fd >= 0) {
      try {
        closeSync(fd);
      } catch (error) {
        this._markClosed();
        return Promise.reject(error);
      }
    }
    this._markClosed();
    return Promise.resolve();
  }
  createReadStream(options = {}) {
    const stream = createReadStream(this.path, { ...options, fd: this.fd });
    if (options?.autoClose !== false) stream.once("close", () => this._markClosed());
    return stream;
  }
  createWriteStream(options = {}) {
    const stream = createWriteStream(this.path, { ...options, fd: this.fd });
    if (options?.autoClose !== false) stream.once("close", () => this._markClosed());
    return stream;
  }
  datasync() { return Promise.resolve(fdatasyncSync(this.fd)); }
  getAsyncId() { return this._asyncId; }
  read(buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
    return Promise.resolve({ bytesRead: readSync(this.fd, buffer, offset, length, position), buffer });
  }
  readFile(options = undefined) { return Promise.resolve(readFileSync(this.fd, options)); }
  readLines(options = {}) {
    return createReadLinesInterface(this.createReadStream({ ...options, encoding: options?.encoding ?? "utf8" }));
  }
  readableWebStream(options = {}) {
    const highWaterMark = Math.max(1, Math.min(Number(options?.highWaterMark || 64 * 1024), 1024 * 1024));
    return new WebReadableStream({
      pull: (controller) => {
        try {
          const chunk = new Uint8Array(highWaterMark);
          const bytesRead = readSync(this.fd, chunk, 0, chunk.byteLength, null);
          if (bytesRead <= 0) {
            controller.close();
            return;
          }
          controller.enqueue(chunk.subarray(0, bytesRead));
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }
  readv(buffers, position = null) {
    return Promise.resolve({ bytesRead: readvSync(this.fd, buffers, position), buffers });
  }
  stat(options = undefined) { return Promise.resolve(fstatSync(this.fd, options)); }
  sync() { return Promise.resolve(fsyncSync(this.fd)); }
  truncate(len = 0) { return Promise.resolve(ftruncateSync(this.fd, len)); }
  utimes(atime, mtime) { return Promise.resolve(futimesSync(this.fd, atime, mtime)); }
  write(data, offsetOrOptions = undefined, length = undefined, position = undefined) {
    if (typeof data === "string") {
      // write(string[, position[, encoding]]): default position null writes at
      // the current file offset (so append-mode handles keep appending).
      const stringPosition = typeof offsetOrOptions === "number" ? offsetOrOptions : null;
      const encoding = typeof length === "string" ? length : "utf8";
      return Promise.resolve({ bytesWritten: writeSync(this.fd, data, stringPosition, encoding), buffer: data });
    }
    let offset = offsetOrOptions;
    if (offset !== null && typeof offset === "object") {
      position = offset.position ?? null;
      length = offset.length;
      offset = offset.offset ?? 0;
    }
    return Promise.resolve({
      bytesWritten: writeSync(this.fd, data, offset ?? 0, length, position ?? null),
      buffer: data,
    });
  }
  writeFile(data, options = undefined) { writeFileSync(this.fd, data, options); return Promise.resolve(); }
  writev(buffers, position = null) {
    return Promise.resolve({ bytesWritten: writevSync(this.fd, buffers, position), buffers });
  }
}

export async function open(path, flags = "r", mode = 0o666) {
  return new FileHandle(openSync(path, flags, mode), String(path));
}

export async function opendir(path, options = {}) {
  return opendirSync(path, options);
}

export async function readFile(path, options = undefined) {
  return readFileSync(path, options);
}

export async function readdir(path, options = undefined) {
  return readdirSync(path, options);
}

export async function readlink(path, options = undefined) {
  return readlinkSync(path, options);
}

export async function realpath(path, options = undefined) {
  return realpathSync(path, options);
}

export async function rename(oldPath, newPath) {
  return renameSync(oldPath, newPath);
}

export async function rm(path, options = {}) {
  return rmSync(path, options);
}

export async function rmdir(path, options = {}) {
  return rmdirSync(path, options);
}

export async function stat(path, options = undefined) {
  return statSync(path, options);
}

export async function statfs(path, options = undefined) {
  return statfsSync(path, options);
}

export async function symlink(target, path, type = undefined) {
  return symlinkSync(target, path, type);
}

export async function truncate(path, len = 0) {
  return truncateSync(path, len);
}

export async function unlink(path) {
  return unlinkSync(path);
}

export async function utimes(path, atime, mtime) {
  return utimesSync(path, atime, mtime);
}

export async function watch(path, options = {}) {
  return watchSync(path, options);
}

function isStreamLikeData(data) {
  if (data == null || typeof data === "string") return false;
  if (ArrayBuffer.isView(data) || data instanceof ArrayBuffer) return false;
  if (typeof data !== "object" && typeof data !== "function") return false;
  return typeof data[Symbol.asyncIterator] === "function" ||
    typeof data[Symbol.iterator] === "function" ||
    (typeof data.pipe === "function" && typeof data.on === "function");
}

function writeChunkToFd(fd, chunk, encoding) {
  if (typeof chunk === "string") {
    writeSync(fd, chunk, null, encoding);
    return;
  }
  if (ArrayBuffer.isView(chunk) || chunk instanceof ArrayBuffer) {
    writeSync(fd, chunk);
    return;
  }
  const error = new TypeError(
    'The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView.',
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
}

export async function writeFile(path, data, options = undefined) {
  if (isStreamLikeData(data)) {
    const encoding = (typeof options === "string" ? options : options?.encoding) ?? "utf8";
    const flag = (typeof options === "object" && options?.flag) || "w";
    // Open before touching the iterator so path errors (e.g. EISDIR) surface
    // without consuming the input, matching Node.
    const fileHandleFd = path !== null && typeof path === "object" && typeof path.fd === "number" ? path.fd : null;
    const fd = fileHandleFd ?? (typeof path === "number" ? path : openSync(path, flag, 0o666));
    const ownsFd = fileHandleFd == null && typeof path !== "number";
    try {
      for await (const chunk of data) {
        writeChunkToFd(fd, chunk, encoding);
      }
    } finally {
      if (ownsFd) closeSync(fd);
    }
    return;
  }
  return writeFileSync(path, data, options);
}

// Bun extends fs.promises with exists(); it never rejects.
export async function exists(path) {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export default {
  access,
  appendFile,
  exists,
  chmod,
  chown,
  close,
  constants,
  copyFile,
  cp,
  glob,
  lchmod,
  lchown,
  link,
  lstat,
  lutimes,
  mkdir,
  mkdtemp,
  mkdtempDisposable,
  open,
  opendir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
  symlink,
  truncate,
  unlink,
  utimes,
  watch,
  writeFile,
};
