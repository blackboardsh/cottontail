function addListener(listeners, name, handler) {
  if (typeof handler !== "function") return;
  const key = String(name);
  const handlers = listeners.get(key) ?? [];
  handlers.push(handler);
  listeners.set(key, handlers);
}

function removeListener(listeners, name, handler) {
  const key = String(name);
  const handlers = listeners.get(key) ?? [];
  listeners.set(key, handlers.filter((item) => item !== handler && item.listener !== handler));
}

function emit(listeners, name, ...args) {
  const handlers = [...(listeners.get(String(name)) ?? [])];
  for (const handler of handlers) handler(...args);
  return handlers.length > 0;
}

function installFdWatchDispatcher() {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const listener = listeners.get(Number(event?.id));
      if (typeof listener === "function") listener(event);
    });
  }
  return listeners;
}

function bytesToChunk(bytes, encoding) {
  const view = bytes instanceof ArrayBuffer
    ? new Uint8Array(bytes)
    : ArrayBuffer.isView(bytes)
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : new Uint8Array(0);
  if (encoding) return new TextDecoder().decode(view);
  return globalThis.Buffer?.from ? globalThis.Buffer.from(view) : view;
}

function chunkByteLength(chunk) {
  if (chunk == null) return 0;
  if (typeof chunk === "string") return new TextEncoder().encode(chunk).byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return new TextEncoder().encode(String(chunk)).byteLength;
}

function writeError(errno) {
  const normalized = Number(errno) || 5;
  const code = normalized === 32 ? "EPIPE"
    : normalized === 9 ? "EBADF"
      : normalized === 22 ? "EINVAL"
        : normalized === 28 ? "ENOSPC"
          : "EIO";
  const error = new Error(`${code}: write`);
  error.errno = -normalized;
  error.code = code;
  error.syscall = "write";
  return error;
}

export function createReadableStdio(fd = 0) {
  const listeners = new Map();
  const stream = {
    fd,
    isTTY: false,
    readable: true,
    readableEnded: false,
    destroyed: false,
    bytesRead: 0,
  };

  let encoding = null;
  let watchId = 0;
  let unregisterWatch = null;

  const stop = () => {
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
    if (stream.readableEnded) return;
    stream.readableEnded = true;
    stream.destroyed = true;
    stop();
    emit(listeners, "end");
    emit(listeners, "close");
  };

  const start = () => {
    if (stream.destroyed || watchId) return stream;
    if (typeof cottontail.fdWatchStart !== "function") {
      queueMicrotask(() => emit(listeners, "error", new Error("cottontail fd watcher is unavailable")));
      return stream;
    }

    const fdWatchListeners = installFdWatchDispatcher();
    const watch = cottontail.fdWatchStart(fd, 64 * 1024);
    watchId = Number(watch?.id || 0);
    if (!watchId) {
      queueMicrotask(() => emit(listeners, "error", new Error("failed to start fd watcher")));
      return stream;
    }

    fdWatchListeners.set(watchId, (event) => {
      if (stream.destroyed) return;
      if (event.type === "data") {
        const bytes = event.data ?? new ArrayBuffer(0);
        const byteLength = Number(bytes.byteLength ?? 0);
        if (byteLength === 0) return;
        stream.bytesRead += byteLength;
        emit(listeners, "data", bytesToChunk(bytes, encoding));
        return;
      }
      if (event.type === "end") {
        finish();
        return;
      }
      if (event.type === "error") {
        emit(listeners, "error", new Error(event.message || "fd read failed"));
        finish();
      }
    });

    unregisterWatch = () => {
      if (fdWatchListeners.get(watchId)) fdWatchListeners.delete(watchId);
    };
    return stream;
  };

  stream.on = stream.addListener = function on(name, handler) {
    addListener(listeners, name, handler);
    if (name === "data" || name === "readable") start();
    return this;
  };
  stream.once = function once(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  };
  stream.off = stream.removeListener = function off(name, handler) {
    removeListener(listeners, name, handler);
    return this;
  };
  stream.emit = function streamEmit(name, ...args) {
    return emit(listeners, name, ...args);
  };
  stream.resume = () => start();
  stream.pause = () => stream;
  stream.pipe = (destination, options = {}) => {
    stream.on("data", (chunk) => destination?.write?.(chunk));
    if (options?.end !== false) stream.on("end", () => destination?.end?.());
    start();
    return destination;
  };
  stream.stream = () => {
    if (typeof globalThis.ReadableStream !== "function") {
      return {
        async *[Symbol.asyncIterator]() {
          const chunks = [];
          let done = false;
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("end", () => { done = true; });
          stream.resume();
          while (!done || chunks.length > 0) {
            if (chunks.length > 0) yield chunks.shift();
            else await new Promise((resolve) => setTimeout(resolve, 0));
          }
        },
      };
    }
    return new globalThis.ReadableStream({
      start(controller) {
        const onData = (chunk) => {
          const byteLength = chunkByteLength(chunk);
          if (fd === 0 && byteLength > 1) {
            if (typeof chunk === "string") {
              const midpoint = Math.ceil(chunk.length / 2);
              controller.enqueue(chunk.slice(0, midpoint));
              controller.enqueue(chunk.slice(midpoint));
              return;
            }
            const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
            const midpoint = Math.ceil(bytes.byteLength / 2);
            controller.enqueue(bytes.slice(0, midpoint));
            controller.enqueue(bytes.slice(midpoint));
            return;
          }
          controller.enqueue(chunk);
        };
        const onEnd = () => {
          cleanup();
          controller.close();
        };
        const onError = (error) => {
          cleanup();
          controller.error(error);
        };
        const cleanup = () => {
          stream.off("data", onData);
          stream.off("end", onEnd);
          stream.off("error", onError);
        };
        stream.on("data", onData);
        stream.once("end", onEnd);
        stream.once("error", onError);
        stream.resume();
      },
    });
  };
  stream.setEncoding = (value = "utf8") => {
    encoding = String(value || "utf8").toLowerCase();
    return stream;
  };
  stream.destroy = (error = undefined) => {
    if (stream.destroyed) return stream;
    stream.destroyed = true;
    stop();
    if (error) emit(listeners, "error", error);
    emit(listeners, "close");
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;

  return stream;
}

export function createWritableStdio(fd = 1) {
  const listeners = new Map();
  const stream = {
    fd,
    isTTY: false,
    writable: true,
    destroyed: false,
  };

  stream.on = stream.addListener = function on(name, handler) {
    addListener(listeners, name, handler);
    return this;
  };
  stream.once = function once(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  };
  stream.off = stream.removeListener = function off(name, handler) {
    removeListener(listeners, name, handler);
    return this;
  };
  stream.emit = function streamEmit(name, ...args) {
    return emit(listeners, name, ...args);
  };
  stream.write = function write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    const status = typeof cottontail.fdWriteStatus === "function"
      ? Number(cottontail.fdWriteStatus(fd, chunk))
      : cottontail.fdWrite?.(fd, chunk) === true ? 0 : 32;
    if (status === 0) {
      if (typeof callback === "function") callback(undefined);
      return true;
    }
    const error = writeError(status);
    if (typeof callback === "function") callback(error);
    if (!emit(listeners, "error", error)) throw error;
    return false;
  };
  stream.end = function end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (chunk != null) stream.write(chunk, encoding);
    stream.destroyed = true;
    emit(listeners, "finish");
    emit(listeners, "close");
    if (typeof callback === "function") callback();
  };
  stream.writer = function writer() {
    let closed = false;
    return {
      write(chunk) {
        if (closed) return 0;
        stream.write(chunk);
        return chunkByteLength(chunk);
      },
      flush() {
        return 0;
      },
      end(chunk = undefined) {
        if (!closed && chunk != null) stream.write(chunk);
        closed = true;
        return 0;
      },
    };
  };
  stream.destroy = function destroy(error = undefined) {
    if (stream.destroyed) return stream;
    stream.destroyed = true;
    if (error) emit(listeners, "error", error);
    emit(listeners, "close");
    return stream;
  };
  stream.ref = () => stream;
  stream.unref = () => stream;
  // Node's stdout/stderr are Duplex-like and expose Symbol.asyncIterator
  // (tools like execa feature-detect this); iterating a write-only stream
  // completes immediately without yielding values.
  stream[Symbol.asyncIterator] = async function* asyncIterator() {};

  return stream;
}
