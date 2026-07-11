import {
  accessSync,
  appendFileSync,
  chmodSync,
  chownSync,
  closeSync,
  constants as fsConstants,
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

export const constants = fsConstants;

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

export async function* glob(pattern, options = {}) {
  for (const item of globSync(pattern, options)) yield item;
}

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

class FileHandle {
  constructor(fd, path) {
    this.fd = fd;
    this.path = path;
    this._asyncId = nextFileHandleAsyncId++;
  }

  appendFile(data, options = undefined) { return appendFile(this.fd, data, options); }
  chmod(mode) { return Promise.resolve(fchmodSync(this.fd, mode)); }
  chown(uid, gid) { return Promise.resolve(fchownSync(this.fd, uid, gid)); }
  close() { const fd = this.fd; this.fd = -1; return Promise.resolve(closeSync(fd)); }
  createReadStream(options = {}) {
    const stream = createReadStream(this.path, { ...options, fd: this.fd });
    if (options?.autoClose !== false) stream.once("close", () => { this.fd = -1; });
    return stream;
  }
  createWriteStream(options = {}) {
    const stream = createWriteStream(this.path, { ...options, fd: this.fd });
    if (options?.autoClose !== false) stream.once("close", () => { this.fd = -1; });
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
  write(data, offset = 0, length = undefined, position = null) {
    return Promise.resolve({ bytesWritten: writeSync(this.fd, data, offset, length, position), buffer: data });
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

export async function writeFile(path, data, options = undefined) {
  return writeFileSync(path, data, options);
}

export default {
  access,
  appendFile,
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
