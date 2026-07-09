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
    const ok = cottontail.fdWrite?.(fd, chunk) === true;
    if (typeof callback === "function") callback(ok ? undefined : new Error("write failed"));
    if (!ok) emit(listeners, "error", new Error("write failed"));
    return ok;
  };
  stream.end = function end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (chunk != null) stream.write(chunk, encoding);
    stream.destroyed = true;
    emit(listeners, "finish");
    emit(listeners, "close");
    if (typeof callback === "function") callback();
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

  return stream;
}

