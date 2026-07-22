import { fileURLToPath as nodeFileURLToPath } from "../node/url.js";
import { bunFileMimeType } from "./mime-types.js";

// Source parity reference: oven-sh/bun@bun-v1.3.10
// - src/bun.js/webcore/Blob.zig
// - src/bun.js/webcore/FileSink.zig
// - src/bun.js/webcore/blob/{read_file,write_file,copy_file}.zig

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_WRITER_HIGH_WATER_MARK = 64 * 1024;
const MAX_FILE_DESCRIPTOR = 0x7fffffff;

const bunFileStates = new WeakMap();

const descriptorFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry((token) => closeOwnedDescriptor(token))
  : null;

function closeOwnedDescriptor(token) {
  if (!token || token.fd == null || token.owned !== true) return;
  const fd = token.fd;
  token.fd = null;
  token.owned = false;
  try { cottontail.closeFd(fd); } catch {}
}

function sleepTurn() {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

function isSharedArrayBuffer(value) {
  return typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer;
}

function isBufferSource(value) {
  return value instanceof ArrayBuffer || isSharedArrayBuffer(value) || ArrayBuffer.isView(value);
}

function bytesFromBufferSource(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer || isSharedArrayBuffer(value)) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw invalidArgumentType("Expected an ArrayBuffer or ArrayBufferView");
}

function bytesFromSinkChunk(value) {
  if (typeof value === "string" || value instanceof String) return new TextEncoder().encode(String(value));
  if (isBufferSource(value)) return bytesFromBufferSource(value);
  throw invalidArgumentType("write() expects a string, ArrayBufferView, or ArrayBuffer");
}

function concatBytes(chunks, length) {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function arrayBufferFromBytes(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function invalidArgumentType(message) {
  const error = new TypeError(message);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function invalidPathValue(path) {
  const error = new TypeError(`The argument 'path' must be a string without null bytes. Received ${JSON.stringify(path)}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function invalidFileDescriptor(fd) {
  const error = new RangeError(`The value of "fd" is out of range. It must be >= 0 and <= ${MAX_FILE_DESCRIPTOR}. Received ${String(fd)}`);
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

const systemErrorDetails = [
  ["ENOENT", -2, "no such file or directory", /no such file|not found|filenotfound/i],
  ["EACCES", -13, "permission denied", /permission denied|access denied/i],
  ["EISDIR", -21, "illegal operation on a directory", /is a directory/i],
  ["ENOTDIR", -20, "not a directory", /not a directory/i],
  ["EBADF", -9, "bad file descriptor", /bad file descriptor|invalid file descriptor/i],
  ["EPIPE", -32, "broken pipe", /broken pipe/i],
  ["EEXIST", -17, "file already exists", /file exists|already exists/i],
  ["ENXIO", -6, "no such device or address", /no such device or address|device not configured/i],
  ["EAGAIN", -11, "resource temporarily unavailable", /temporarily unavailable|would block/i],
  ["EINVAL", -22, "invalid argument", /invalid argument/i],
  ["ENOMEM", -12, "out of memory", /out of memory|cannot allocate memory/i],
];

export function makeBunFileError(error, target, syscall = "open") {
  if (error?.code && error?.syscall && (target == null || error.path != null || typeof target === "number")) {
    return error;
  }

  const source = String(error?.message ?? error ?? "");
  let detail = systemErrorDetails.find(([code]) => error?.code === code);
  if (!detail) detail = systemErrorDetails.find(([, , , pattern]) => pattern.test(source));
  const [code, errno, reason] = detail ?? [String(error?.code ?? "EIO"), -5, source || "I/O error"];
  const pathSuffix = typeof target === "string" ? ` '${target}'` : "";
  const result = new Error(`${code}: ${reason}, ${syscall}${pathSuffix}`);
  result.code = code;
  result.errno = errno;
  result.syscall = syscall;
  if (typeof target === "string") result.path = target;
  return result;
}

function validatePath(path) {
  if (path.includes("\0")) throw invalidPathValue(path);
  return path;
}

function pathFromBufferSource(value) {
  return validatePath(new TextDecoder().decode(bytesFromBufferSource(value)));
}

function pathOrFileDescriptor(value) {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > MAX_FILE_DESCRIPTOR) throw invalidFileDescriptor(value);
    return { kind: "fd", fd: value };
  }

  if (typeof value === "string") return { kind: "path", path: validatePath(value) };
  if (isBufferSource(value)) return { kind: "path", path: pathFromBufferSource(value) };

  if (value && typeof value === "object" && typeof value.protocol === "string") {
    if (value.protocol !== "file:") throw invalidArgumentType("Expected file path string or file descriptor");
    try {
      return { kind: "path", path: validatePath(nodeFileURLToPath(value.href ?? value)) };
    } catch (error) {
      throw invalidArgumentType(error?.message || "Expected file path string or file descriptor");
    }
  }

  throw invalidArgumentType("Expected file path string or file descriptor");
}

function descriptorTarget(descriptor) {
  return descriptor.kind === "path" ? descriptor.path : descriptor.fd;
}

export function pathDirname(path) {
  const text = String(path);
  const slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  if (slash < 0) return ".";
  if (slash === 0) return text.slice(0, 1);
  return text.slice(0, slash);
}

export function guessMimeType(path) {
  const name = String(path);
  const basenameStart = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1;
  const dot = name.lastIndexOf(".");
  if (dot <= basenameStart || dot === name.length - 1) return "application/octet-stream";
  return bunFileMimeType(name.slice(dot + 1));
}

function isASCII(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function normalizedContentType(value, fallback) {
  if (typeof value !== "string" || value.length === 0 || !isASCII(value)) return fallback;
  return value.toLowerCase();
}

function currentStat(state) {
  return state.descriptor.kind === "fd"
    ? cottontail.fstatSync(state.descriptor.fd)
    : cottontail.statSync(state.descriptor.path, true);
}

function statIsFIFO(stat) {
  return stat?.isFIFO === true || (Number(stat?.mode ?? 0) & 0o170000) === 0o010000;
}

function statIsRegularFile(stat) {
  if (stat?.isFile === true) return true;
  return (Number(stat?.mode ?? 0) & 0o170000) === 0o100000;
}

function fileSize(state) {
  if (state.length != null) return state.length;
  try {
    const stat = currentStat(state);
    if (statIsFIFO(stat)) return Infinity;
    return Math.max(0, Number(stat?.size ?? 0));
  } catch {
    return 0;
  }
}

function fileLastModified(state) {
  try { return Number(currentStat(state)?.mtimeMs ?? 0); } catch { return 0; }
}

function assertSyntheticAllocationLimit(state) {
  const limit = Number(globalThis.__cottontailSyntheticAllocationLimit);
  const size = fileSize(state);
  if (Number.isFinite(limit) && limit > 0 && Number.isFinite(size) && size > limit) {
    throw new Error("Out of memory");
  }
}

function cloneStateForSlice(state, start, length, type) {
  return {
    descriptor: state.descriptor,
    start: state.start + start,
    length,
    isSlice: true,
    type,
    cachedStream: null,
  };
}

function normalizeSliceIndex(value, size, defaultValue) {
  if (typeof value !== "number" || Number.isNaN(value)) return defaultValue;
  if (value === Infinity) return size;
  if (value === -Infinity) return 0;
  const integer = Math.trunc(value);
  return integer < 0 ? Math.max(size + integer, 0) : Math.min(integer, size);
}

function sliceFile(state, start = 0, end = undefined, type = "") {
  const size = fileSize(state);
  const finiteSize = Number.isFinite(size) ? size : 0;
  if (typeof start === "string") {
    type = start;
    start = 0;
    end = finiteSize;
  } else if (typeof end === "string") {
    type = end;
    end = finiteSize;
  }
  const relativeStart = normalizeSliceIndex(start, finiteSize, 0);
  const relativeEnd = normalizeSliceIndex(end, finiteSize, finiteSize);
  const sliceType = normalizedContentType(type, state.type);
  return createBunFile(cloneStateForSlice(
    state,
    relativeStart,
    Math.max(relativeEnd - relativeStart, 0),
    sliceType,
  ));
}

function createFileReader(state, chunkSize = DEFAULT_CHUNK_SIZE) {
  const target = descriptorTarget(state.descriptor);
  const requestedChunkSize = Math.max(1, Math.min(1024 * 1024, Math.trunc(chunkSize) || DEFAULT_CHUNK_SIZE));
  let fd = null;
  let owned = false;
  let stat = null;
  let fifo = false;
  let cursor = 0;
  let sawData = false;
  let closed = false;

  function ensureOpen() {
    if (fd != null) return;
    try {
      stat = currentStat(state);
      fifo = statIsFIFO(stat);
      if (state.descriptor.kind === "fd") {
        fd = state.descriptor.fd;
      } else {
        fd = cottontail.openFd(state.descriptor.path, fifo ? "rn" : "r");
        owned = true;
      }
    } catch (error) {
      throw makeBunFileError(error, target, "open");
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    if (owned && fd != null) {
      try { cottontail.closeFd(fd); } catch {}
    }
    fd = null;
    owned = false;
  }

  async function readChunk() {
    if (closed) return null;
    if (state.length != null && cursor >= state.length) {
      close();
      return null;
    }
    ensureOpen();
    const remaining = state.length == null ? requestedChunkSize : Math.min(requestedChunkSize, state.length - cursor);
    if (remaining <= 0) {
      close();
      return null;
    }

    if (fifo) {
      for (;;) {
        if (closed) return null;
        let bytes;
        try {
          if (state.descriptor.kind === "path") {
            const buffer = new Uint8Array(remaining);
            const count = Number(cottontail.fdReadAt(fd, buffer, 0, buffer.byteLength, null));
            bytes = count === buffer.byteLength ? buffer : buffer.slice(0, Math.max(0, count));
          } else {
            const result = cottontail.readFd(fd, remaining);
            if (result == null) {
              await sleepTurn();
              continue;
            }
            bytes = bytesFromBufferSource(result);
          }
        } catch (error) {
          const mapped = makeBunFileError(error, target, "read");
          if (mapped.code === "EAGAIN") {
            await sleepTurn();
            continue;
          }
          close();
          throw mapped;
        }
        if (bytes.byteLength === 0) {
          if (!sawData) {
            await sleepTurn();
            continue;
          }
          close();
          return null;
        }
        sawData = true;
        cursor += bytes.byteLength;
        return bytes;
      }
    }

    const bytes = new Uint8Array(remaining);
    const positioned = state.isSlice || (state.descriptor.kind === "path" && state.start > 0);
    let count;
    try {
      count = Number(cottontail.fdReadAt(
        fd,
        bytes,
        0,
        bytes.byteLength,
        positioned ? state.start + cursor : null,
      ));
    } catch (error) {
      close();
      throw makeBunFileError(error, target, "read");
    }
    if (!(count > 0)) {
      close();
      return null;
    }
    cursor += count;
    return count === bytes.byteLength ? bytes : bytes.slice(0, count);
  }

  return {
    open: ensureOpen,
    readChunk,
    close,
    get fd() { return fd; },
    get owned() { return owned; },
  };
}

async function readFileBytes(state) {
  const reader = createFileReader(state);
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.readChunk();
      if (chunk == null) break;
      chunks.push(chunk);
      length += chunk.byteLength;
    }
  } finally {
    reader.close();
  }
  return concatBytes(chunks, length);
}

function streamFile(state, chunkSize) {
  if (chunkSize != null && typeof chunkSize !== "number") {
    throw invalidArgumentType("chunkSize must be a number");
  }
  const normalizedChunkSize = Math.max(1, Math.trunc(Number(chunkSize)) || DEFAULT_CHUNK_SIZE);
  if (state.descriptor.kind === "fd" && state.cachedStream) return state.cachedStream;

  const reader = createFileReader(state, normalizedChunkSize);
  const finalizerToken = { reader, fd: null, owned: false };
  if (state.descriptor.kind === "path") {
    try {
      if (statIsFIFO(currentStat(state))) {
        reader.open();
        finalizerToken.fd = reader.fd;
        finalizerToken.owned = reader.owned;
      }
    } catch {}
  }
  let finalized = false;
  let stream;

  const finish = () => {
    if (finalized) return;
    finalized = true;
    descriptorFinalizer?.unregister(finalizerToken);
    reader.close();
  };

  stream = new ReadableStream({
    async pull(controller) {
      try {
        const chunk = await reader.readChunk();
        finalizerToken.fd = reader.fd;
        finalizerToken.owned = reader.owned;
        if (chunk == null) {
          finish();
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    cancel() {
      finish();
    },
  });

  descriptorFinalizer?.register(stream, finalizerToken, finalizerToken);
  if (state.descriptor.kind === "fd") state.cachedStream = stream;
  return stream;
}

function writeAllToFd(fd, source, target) {
  const isString = typeof source === "string";
  const requestedLength = isString ? source.length * 3 : source.byteLength;
  if (requestedLength === 0) return 0;
  let written;
  try {
    // The native boundary owns UTF-8 conversion and loops until the regular
    // file write is complete, matching Bun's single write-task ownership.
    written = Number(cottontail.fdWriteAt(fd, source, 0, requestedLength, null));
  } catch (error) {
    throw makeBunFileError(error, target, "write");
  }
  if (!(written > 0) || (!isString && written !== source.byteLength)) {
    throw makeBunFileError(new Error("write returned zero bytes"), target, "write");
  }
  return written;
}

async function writeAllToFdAsync(fd, bytes, target) {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + DEFAULT_CHUNK_SIZE, bytes.byteLength);
    let written;
    try {
      written = Number(cottontail.fdWriteSome(fd, bytes.subarray(offset, end)));
    } catch (error) {
      throw makeBunFileError(error, target, "write");
    }
    if (written > 0) {
      offset += written;
      continue;
    }
    await sleepTurn();
  }
  return offset;
}

function normalizedWriterOptions(options) {
  if (options == null) return { highWaterMark: DEFAULT_WRITER_HIGH_WATER_MARK, mode: 0o664 };
  if (typeof options !== "object") throw invalidArgumentType("Expected writer options to be an object");
  const rawHighWaterMark = options.highWaterMark ?? options.chunkSize;
  const highWaterMark = rawHighWaterMark == null
    ? DEFAULT_WRITER_HIGH_WATER_MARK
    : Math.max(1, Math.trunc(Number(rawHighWaterMark)) || DEFAULT_WRITER_HIGH_WATER_MARK);
  const rawMode = options.mode;
  const mode = rawMode == null ? 0o664 : Math.trunc(Number(rawMode));
  if (!Number.isFinite(mode) || mode < 0 || mode > 0o777) {
    const error = new RangeError(`The value of "mode" is out of range. It must be >= 0 and <= 511. Received ${String(rawMode)}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  return { highWaterMark, mode };
}

function createFileSink(state, options) {
  const { highWaterMark, mode } = normalizedWriterOptions(options);
  const target = descriptorTarget(state.descriptor);
  const token = { fd: null, owned: false };
  const chunks = [];
  let pendingBytes = 0;
  let done = false;
  let failure = null;
  let autoFlushQueued = false;
  let activeDrain = null;
  let ending = null;
  let regular = true;

  try {
    if (state.descriptor.kind === "fd") {
      token.fd = state.descriptor.fd;
    } else {
      token.fd = cottontail.openFd(state.descriptor.path, "wn", mode);
      token.owned = true;
    }
  } catch (error) {
    throw makeBunFileError(error, target, "open");
  }
  try { regular = statIsRegularFile(cottontail.fstatSync(token.fd)); } catch {}

  const takePending = () => {
    if (chunks.length === 0) return 0;
    const bytes = concatBytes(chunks.splice(0), pendingBytes);
    pendingBytes = 0;
    return bytes;
  };

  const flushPendingSync = () => {
    const bytes = takePending();
    return bytes === 0 ? 0 : writeAllToFd(token.fd, bytes, target);
  };

  const drainPending = () => {
    if (activeDrain) return activeDrain;
    const bytes = takePending();
    if (bytes === 0) return Promise.resolve(0);
    let pending;
    pending = writeAllToFdAsync(token.fd, bytes, target).then(
      async (written) => {
        if (activeDrain === pending) activeDrain = null;
        if (chunks.length > 0) written += await drainPending();
        return written;
      },
      (error) => {
        if (activeDrain === pending) activeDrain = null;
        throw error;
      },
    );
    activeDrain = pending;
    return pending;
  };

  const close = () => {
    descriptorFinalizer?.unregister(sink);
    closeOwnedDescriptor(token);
  };

  const recordFailure = (error) => {
    failure = error;
    done = true;
    close();
  };

  const flushPending = () => regular ? flushPendingSync() : drainPending();

  const queueAutoFlush = () => {
    if (autoFlushQueued || done) return;
    autoFlushQueued = true;
    queueMicrotask(() => {
      autoFlushQueued = false;
      if (done || chunks.length === 0) return;
      try {
        const result = flushPending();
        if (result && typeof result.then === "function") result.catch(recordFailure);
      } catch (error) {
        recordFailure(error);
      }
    });
  };

  const sink = {
    write(chunk) {
      if (failure) throw failure;
      if (done) return true;
      const bytes = bytesFromSinkChunk(chunk).slice();
      chunks.push(bytes);
      pendingBytes += bytes.byteLength;
      if (pendingBytes >= highWaterMark) {
        const result = flushPending();
        if (result && typeof result.then === "function") result.catch(recordFailure);
      } else {
        queueAutoFlush();
      }
      return bytes.byteLength;
    },
    flush() {
      if (failure) throw failure;
      if (ending) return ending;
      if (done) return undefined;
      const result = flushPending();
      if (!result || typeof result.then !== "function") return result;
      return result.catch((error) => {
        recordFailure(error);
        throw error;
      });
    },
    end() {
      if (failure) throw failure;
      if (ending) return ending;
      if (done) return 0;
      if (!regular) {
        done = true;
        ending = drainPending().then(
          (written) => {
            close();
            return written;
          },
          (error) => {
            recordFailure(error);
            throw error;
          },
        );
        return ending;
      }
      let written = 0;
      try {
        written = flushPendingSync();
        done = true;
        return written;
      } finally {
        done = true;
        close();
      }
    },
    ref() { return this; },
    unref() { return this; },
  };

  descriptorFinalizer?.register(sink, token, sink);
  return sink;
}

function createBunFile(state) {
  const result = {
    get name() { return state.descriptor.kind === "path" ? state.descriptor.path : undefined; },
    get fd() { return state.descriptor.kind === "fd" ? state.descriptor.fd : undefined; },
    get type() { return state.type; },
    get size() { return fileSize(state); },
    get lastModified() { return fileLastModified(state); },
    [Symbol.for("nodejs.util.inspect.custom")]() {
      const label = state.descriptor.kind === "fd"
        ? `FileRef (fd: ${state.descriptor.fd})`
        : `FileRef (${JSON.stringify(state.descriptor.path)})`;
      return state.type ? `${label} {\n  type: ${JSON.stringify(state.type)}\n}` : `${label} {}`;
    },
    async exists() {
      try {
        const stat = currentStat(state);
        return statIsRegularFile(stat) || statIsFIFO(stat);
      } catch {
        return false;
      }
    },
    async stat() {
      try { return currentStat(state); } catch (error) {
        throw makeBunFileError(error, descriptorTarget(state.descriptor), "stat");
      }
    },
    write(data, options = undefined) {
      if (options != null && typeof options !== "object") throw invalidArgumentType("Expected options to be an object");
      if (options?.type != null) {
        if (typeof options.type !== "string") throw invalidArgumentType("Expected options.type to be a string for 'write'.");
        state.type = normalizedContentType(options.type, state.type);
      }
      return write(result, data, options);
    },
    async delete() {
      if (state.descriptor.kind === "fd") throw invalidArgumentType("Cannot delete a file descriptor");
      try { cottontail.unlinkSync(state.descriptor.path); } catch (error) {
        throw makeBunFileError(error, state.descriptor.path, "unlink");
      }
    },
    unlink() { return this.delete(); },
    async text() {
      assertSyntheticAllocationLimit(state);
      return new TextDecoder().decode(await readFileBytes(state));
    },
    async json() {
      assertSyntheticAllocationLimit(state);
      return JSON.parse(new TextDecoder().decode(await readFileBytes(state)));
    },
    async bytes() {
      assertSyntheticAllocationLimit(state);
      return readFileBytes(state);
    },
    async arrayBuffer() {
      return arrayBufferFromBytes(await readFileBytes(state));
    },
    stream(chunkSize = undefined) { return streamFile(state, chunkSize); },
    slice(start = 0, end = undefined, type = "") { return sliceFile(state, start, end, type); },
    writer(options = undefined) { return createFileSink(state, options); },
  };

  bunFileStates.set(result, state);
  if (state.descriptor.kind === "path") {
    Object.defineProperty(result, "_bunFilePath", { value: state.descriptor.path, configurable: true });
    if (state.isSlice) {
      Object.defineProperties(result, {
        _bunFileStart: { value: state.start, configurable: true },
        _bunFileEnd: { value: state.start + state.length, configurable: true },
      });
    }
  }
  Object.setPrototypeOf(result, Blob.prototype);
  return result;
}

export function file(path, options = undefined) {
  const descriptor = pathOrFileDescriptor(path);
  const inferredType = descriptor.kind === "path" ? guessMimeType(descriptor.path) : "application/octet-stream";
  const type = normalizedContentType(options?.type, inferredType);
  return createBunFile({
    descriptor,
    start: 0,
    length: null,
    isSlice: false,
    type,
    cachedStream: null,
  });
}

export function isBunFileLike(value) {
  if (!value || typeof value !== "object") return false;
  if (bunFileStates.has(value)) return true;
  return typeof value.arrayBuffer === "function" &&
    typeof value.text === "function" &&
    typeof value.exists === "function" &&
    (typeof value.writer === "function" || typeof value.write === "function");
}

function normalizeWriteOptions(options) {
  if (options == null) return { createPath: true, createPathWasSet: false, mode: 0o664 };
  if (typeof options !== "object") throw invalidArgumentType("Expected options to be an object for 'write'.");
  let createPath = true;
  let createPathWasSet = false;
  if (options.createPath != null) {
    createPathWasSet = true;
    if (typeof options.createPath !== "boolean") {
      throw invalidArgumentType("Expected options.createPath to be a boolean for 'write'.");
    }
    createPath = options.createPath;
  }
  let mode = 0o664;
  if (options.mode != null) {
    if (typeof options.mode !== "number" || !Number.isFinite(options.mode)) {
      throw invalidArgumentType("Expected options.mode to be a number for 'write'.");
    }
    mode = Math.trunc(options.mode);
    if (mode < 0 || mode > 0o777) {
      const error = new RangeError(`The value of "mode" is out of range. It must be >= 0 and <= 511. Received ${String(options.mode)}`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
  }
  // Bun 1.3.10 only parses createPath and mode for local files. In particular,
  // an AbortSignal in this object is intentionally ignored.
  return { createPath, createPathWasSet, mode };
}

function normalizeWriteDestination(destination, options) {
  const state = bunFileStates.get(destination);
  if (state) {
    if (state.descriptor.kind === "fd" && options.createPathWasSet && options.createPath) {
      throw new Error("Cannot create a directory for a file descriptor");
    }
    return { kind: state.descriptor.kind, state, ...state.descriptor };
  }

  if (isBunFileLike(destination)) {
    if (typeof destination.fd === "number") {
      if (options.createPathWasSet && options.createPath) throw new Error("Cannot create a directory for a file descriptor");
      return { kind: "fd", fd: pathOrFileDescriptor(destination.fd).fd, state: null };
    }
    if (typeof destination.name === "string") {
      return { kind: "path", path: validatePath(destination.name), state: null };
    }
  }

  if (destination && typeof destination === "object" && typeof destination.write === "function" &&
      !(destination instanceof Blob)) {
    return { kind: "stream", stream: destination };
  }

  if (destination instanceof Blob) {
    throw invalidArgumentType("Cannot write to a Blob backed by bytes, which are always read-only");
  }

  const descriptor = pathOrFileDescriptor(destination);
  if (descriptor.kind === "fd" && options.createPathWasSet && options.createPath) {
    throw new Error("Cannot create a directory for a file descriptor");
  }
  return { kind: descriptor.kind, state: null, ...descriptor };
}

function immediateSource(data) {
  if (typeof data === "string" || data instanceof String) return String(data);
  if (isBufferSource(data)) return bytesFromBufferSource(data);
  if (typeof data === "symbol") throw invalidArgumentType("Bun.write expects a Blob-y thing to write");
  if (data == null) return null;
  if (bunFileStates.has(data) || isBunFileLike(data)) return undefined;
  if (typeof Blob === "function" && data instanceof Blob) return undefined;
  if (typeof Response === "function" && data instanceof Response) return undefined;
  if (typeof Request === "function" && data instanceof Request) return undefined;
  if (data?.constructor?.name === "Archive" && typeof data.bytes === "function") return undefined;
  return new TextEncoder().encode(String(data));
}

function ensureDestinationParent(destination, options) {
  if (destination.kind !== "path" || !options.createPath) return;
  const parent = pathDirname(destination.path);
  try {
    if (!cottontail.existsSync(parent)) cottontail.mkdirSync(parent, true);
  } catch (error) {
    throw makeBunFileError(error, destination.path, "mkdir");
  }
}

function openWriteDestination(destination, options) {
  if (destination.kind === "stream") return { fd: null, owned: false, stream: destination.stream };
  if (destination.kind === "fd") return { fd: destination.fd, owned: false, stream: null };
  ensureDestinationParent(destination, options);
  try {
    return { fd: cottontail.openFd(destination.path, "wnt", options.mode), owned: true, stream: null };
  } catch (error) {
    throw makeBunFileError(error, destination.path, "open");
  }
}

function closeWriteDestination(opened) {
  if (!opened.owned || opened.fd == null) return;
  try { cottontail.closeFd(opened.fd); } catch {}
  opened.fd = null;
  opened.owned = false;
}

function writeImmediate(destination, source, options) {
  if (destination.kind === "stream") {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    destination.stream.write(bytes);
    return bytes.byteLength;
  }
  const opened = openWriteDestination(destination, options);
  const target = destination.kind === "path" ? destination.path : destination.fd;
  let regular = true;
  try { regular = statIsRegularFile(cottontail.fstatSync(opened.fd)); } catch {}

  const sourceLength = typeof source === "string" ? source.length : source.byteLength;
  if (!regular && sourceLength > 0) {
    const bytes = typeof source === "string" ? new TextEncoder().encode(source) : source;
    return writeAllToFdAsync(opened.fd, bytes, target).finally(() => closeWriteDestination(opened));
  }
  try {
    if (sourceLength === 0 && destination.kind === "fd") {
      if (regular) cottontail.ftruncateSync?.(destination.fd, 0);
      return 0;
    }
    return writeAllToFd(opened.fd, source, target);
  } finally {
    closeWriteDestination(opened);
  }
}

function sourceFromBunFile(state, destination) {
  let sourceState = state;
  // Bun 1.3.10's file-to-file copy path applies a destination slice as the
  // source copy range. Byte-backed inputs intentionally do not use this path.
  if (destination.state?.isSlice) {
    const sourceSize = fileSize(state);
    const skipped = Math.min(destination.state.start, Number.isFinite(sourceSize) ? sourceSize : destination.state.start);
    sourceState = cloneStateForSlice(
      state,
      skipped,
      Math.max(0, Math.min(destination.state.length, sourceSize - skipped)),
      state.type,
    );
  }
  const reader = createFileReader(sourceState);
  return {
    open: () => reader.open(),
    read: () => reader.readChunk(),
    cancel: () => reader.close(),
    close: () => reader.close(),
  };
}

function sourceFromReadableStream(stream) {
  if (!stream || typeof stream.getReader !== "function") return null;
  if (stream.locked) throw new TypeError("ReadableStream has already been used");
  const reader = stream.getReader();
  let finished = false;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try { reader.releaseLock(); } catch {}
  };
  return {
    async read() {
      const item = await reader.read();
      if (item.done) {
        finished = true;
        release();
        return null;
      }
      return bytesFromSinkChunk(item.value);
    },
    async cancel(reason) {
      if (finished) return;
      finished = true;
      try { await reader.cancel(reason); } catch {}
      release();
    },
    close() { if (finished) release(); },
  };
}

async function createAsyncSource(data, destination) {
  const state = bunFileStates.get(data);
  if (state) return sourceFromBunFile(state, destination);

  if (isBunFileLike(data)) {
    if (typeof data.stream === "function") {
      const source = sourceFromReadableStream(data.stream());
      if (source) return source;
    }
    const bytes = bytesFromBufferSource(await data.arrayBuffer());
    let consumed = false;
    return {
      read() { if (consumed) return null; consumed = true; return bytes; },
      cancel() {},
      close() {},
    };
  }

  if (data?.constructor?.name === "Archive" && typeof data.bytes === "function") {
    const bytes = bytesFromBufferSource(await data.bytes());
    let consumed = false;
    return {
      read() { if (consumed) return null; consumed = true; return bytes; },
      cancel() {},
      close() {},
    };
  }

  if ((typeof Response === "function" && data instanceof Response) ||
      (typeof Request === "function" && data instanceof Request)) {
    if (data.bodyUsed) throw new TypeError("ReadableStream has already been used");
    const body = data.body ?? data._body;
    if (bunFileStates.has(body)) return sourceFromBunFile(bunFileStates.get(body), destination);
    const source = sourceFromReadableStream(body);
    if (source) return source;
    const bytes = bytesFromBufferSource(await data.arrayBuffer());
    let consumed = false;
    return {
      read() { if (consumed) return null; consumed = true; return bytes; },
      cancel() {},
      close() {},
    };
  }

  if (typeof Blob === "function" && data instanceof Blob) {
    const source = sourceFromReadableStream(data.stream?.());
    if (source) return source;
    const bytes = bytesFromBufferSource(await data.arrayBuffer());
    let consumed = false;
    return {
      read() { if (consumed) return null; consumed = true; return bytes; },
      cancel() {},
      close() {},
    };
  }

  throw invalidArgumentType("Bun.write expects a Blob-y thing to write");
}

async function writeAsync(destination, data, options) {
  const source = await createAsyncSource(data, destination);
  let opened;
  let total = 0;
  try {
    source.open?.();
    opened = openWriteDestination(destination, options);
    for (;;) {
      const chunk = await source.read();
      if (chunk == null) break;
      if (opened.stream) {
        opened.stream.write(chunk);
        total += chunk.byteLength;
      } else {
        total += await writeAllToFdAsync(
          opened.fd,
          chunk,
          destination.kind === "path" ? destination.path : destination.fd,
        );
      }
    }
    return total;
  } catch (error) {
    await source.cancel(error);
    throw error;
  } finally {
    source.close();
    if (opened) closeWriteDestination(opened);
  }
}

export function write(destinationValue, data, optionsValue = undefined) {
  if (arguments.length < 2 || data == null) {
    throw invalidArgumentType("Bun.write(pathOrFdOrBlob, blob) expects a Blob-y thing to write");
  }
  const options = normalizeWriteOptions(optionsValue);
  const destination = normalizeWriteDestination(destinationValue, options);
  const immediate = immediateSource(data);
  if (immediate !== undefined) {
    try {
      return Promise.resolve(writeImmediate(destination, immediate, options));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return writeAsync(destination, data, options);
}
