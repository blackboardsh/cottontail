// node:stream — backed by a vendored copy of readable-stream@4.7.0 (the
// userland extraction of the Node.js core streams implementation).
// See ./stream/readable-stream.js (generated bundle; MIT licensed).
import Stream from "./stream/readable-stream.js";
import { _wrapAsyncCallback } from "./async_hooks.js";

export const Readable = Stream.Readable;
export const Writable = Stream.Writable;
export const Duplex = Stream.Duplex;
export const Transform = Stream.Transform;
export const PassThrough = Stream.PassThrough;
export const addAbortSignal = Stream.addAbortSignal;
export const compose = Stream.compose;
export const destroy = Stream.destroy;
const streamFinished = Stream.finished;
export function finished(stream, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }

  const wrappedCallback = _wrapAsyncCallback(callback);
  return options === undefined
    ? streamFinished(stream, wrappedCallback)
    : streamFinished(stream, options, wrappedCallback);
}

for (const key of Object.getOwnPropertySymbols(streamFinished)) {
  Object.defineProperty(finished, key, Object.getOwnPropertyDescriptor(streamFinished, key));
}
Stream.finished = finished;
export const getDefaultHighWaterMark = Stream.getDefaultHighWaterMark;
export const setDefaultHighWaterMark = Stream.setDefaultHighWaterMark;
export const isDestroyed = Stream.isDestroyed;
export const isDisturbed = Stream.isDisturbed;
export const isErrored = Stream.isErrored;
export const isReadable = Stream.isReadable;
export const isWritable = Stream.isWritable;
export const pipeline = Stream.pipeline;
export const promises = Stream.promises;
// The vendored bundle exposes `promises` as a lazy getter that builds a fresh
// object per access; pin the captured instance so require("stream").promises
// and node:stream/promises stay identical.
Object.defineProperty(Stream, "promises", { value: promises, enumerable: false, configurable: true, writable: true });
export const _isUint8Array = Stream._isUint8Array;
export const _uint8ArrayToBuffer = Stream._uint8ArrayToBuffer;

const readableFrom = Readable.from;
Object.defineProperty(Readable, "from", {
  value: function from(...args) {
    const readable = readableFrom.apply(this, args);
    const destroy = readable?._destroy;
    if (typeof destroy === "function" && Object.prototype.hasOwnProperty.call(readable, "_destroy")) {
      readable._destroy = function destroyFromIterable(error, callback) {
        if (typeof callback !== "function") {
          throw new TypeError('The "callback" argument must be of type function.');
        }
        return destroy.call(this, error, callback);
      };
    }
    return readable;
  },
  writable: true,
  configurable: true,
});

// readable-stream queues its end callback before touching an invalid pipe
// destination. Node rejects first, without leaving a delayed dest.end().
const readablePipe = Readable.prototype.pipe;
Object.defineProperty(Readable.prototype, "pipe", {
  value(destination, options) {
    if (destination == null || typeof destination.on !== "function") {
      throw new TypeError("Cannot read properties of undefined (reading 'on')");
    }
    return readablePipe.call(this, destination, options);
  },
  writable: true,
  configurable: true,
});

export function _isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}
Stream._isArrayBufferView ??= _isArrayBufferView;

// Node's stream constructors preallocate common event keys with undefined
// values. The shared EventEmitter counts only installed listeners but returns
// every own key, so filter the placeholders for stream instances.
Object.defineProperty(Stream.prototype, "eventNames", {
  value() {
    if (!this._events || this._eventsCount === 0) return [];
    return Reflect.ownKeys(this._events).filter((name) => this._events[name] !== undefined);
  },
  writable: true,
  configurable: true,
});

// ---------------------------------------------------------------------------
// Compatibility: several runtime modules (fs, http, net, crypto, http2, ...)
// were written against the previous permissive stream shim and assign to
// properties that are getter-only accessors on the real Node stream
// prototypes (closed, readableEnded, writableLength, ...). Real Node throws
// on such assignments in strict mode. Until those modules are migrated to
// proper stream subclassing, let assignments shadow the accessor with an own
// data property instead of throwing.
// ---------------------------------------------------------------------------
for (const ctor of [Stream, Readable, Writable, Duplex, Transform, PassThrough]) {
  const proto = ctor?.prototype;
  if (!proto) continue;
  for (const name of Object.getOwnPropertyNames(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    if (!descriptor || !descriptor.get || descriptor.set || !descriptor.configurable) continue;
    Object.defineProperty(proto, name, {
      get: descriptor.get,
      set(value) {
        Object.defineProperty(this, name, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
      enumerable: descriptor.enumerable,
      configurable: true,
    });
  }
}

// Legacy modules also assign `stream.destroyed = true/false` directly (the
// old shim stored it as a plain property). Routing that through the real
// setter marks _readableState/_writableState destroyed immediately, which
// suppresses pending 'readable'/'end' delivery. Shadow truthy assignments
// with an own property instead; the vendored destroy path recognizes that
// explicit marker without suppressing data that was already buffered.
for (const proto of [Readable.prototype, Writable.prototype, Duplex.prototype]) {
  const descriptor = Object.getOwnPropertyDescriptor(proto, "destroyed");
  if (!descriptor?.get || !descriptor.configurable) continue;
  Object.defineProperty(proto, "destroyed", {
    get: descriptor.get,
    set(value) {
      if (value) {
        Object.defineProperty(this, "destroyed", {
          value: true,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      // Assigning false (constructor initialization) is a no-op; the getter
      // already reports the live state.
    },
    enumerable: descriptor.enumerable,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// duplexPair (port of node's internal/streams/duplexpair)
// ---------------------------------------------------------------------------
const kCallback = Symbol("Callback");
const kInitOtherSide = Symbol("InitOtherSide");
const kOtherSide = Symbol("OtherSide");

class DuplexSide extends Duplex {
  constructor(options) {
    super(options);
    this[kCallback] = null;
    this[kOtherSide] = null;
  }

  [kInitOtherSide](otherSide) {
    if (this[kOtherSide] === null) {
      this[kOtherSide] = otherSide;
    }
  }

  _read() {
    const callback = this[kCallback];
    if (callback) {
      this[kCallback] = null;
      callback();
    }
  }

  _write(chunk, encoding, callback) {
    if (chunk.length === 0) {
      queueMicrotask(callback);
    } else {
      this[kOtherSide].push(chunk);
      this[kOtherSide][kCallback] = callback;
    }
  }

  _final(callback) {
    this[kOtherSide].on("end", callback);
    this[kOtherSide].push(null);
  }
}

export function duplexPair(options) {
  const side0 = new DuplexSide(options);
  const side1 = new DuplexSide(options);
  side0[kInitOtherSide](side1);
  side1[kInitOtherSide](side0);
  return [side0, side1];
}
Stream.duplexPair ??= duplexPair;

// ---------------------------------------------------------------------------
// Web streams adapters (ports of node's internal/webstreams/adapters)
// ---------------------------------------------------------------------------
function webReadableStreamCtor() {
  const ctor = globalThis.ReadableStream;
  if (typeof ctor !== "function") throw new TypeError("ReadableStream is not available");
  return ctor;
}

function webWritableStreamCtor() {
  const ctor = globalThis.WritableStream;
  if (typeof ctor !== "function") throw new TypeError("WritableStream is not available");
  return ctor;
}

function newAbortError() {
  const error = new Error("The operation was aborted");
  error.code = "ABORT_ERR";
  error.name = "AbortError";
  return error;
}

function rethrowLater(error) {
  queueMicrotask(() => {
    throw error;
  });
}

function newReadableStreamFromStreamReadable(streamReadable, options = {}) {
  const ReadableStreamCtor = webReadableStreamCtor();
  if (typeof streamReadable?._readableState !== "object" || streamReadable._readableState === null) {
    throw new TypeError('The "streamReadable" argument must be an instance of stream.Readable');
  }

  if (isDestroyed(streamReadable) || !isReadable(streamReadable)) {
    const readable = new ReadableStreamCtor();
    readable.cancel();
    return readable;
  }

  const objectMode = streamReadable.readableObjectMode;
  const highWaterMark = streamReadable.readableHighWaterMark;
  const strategy =
    options?.strategy ??
    (objectMode
      ? { highWaterMark, size: () => 1 }
      : { highWaterMark, size: (chunk) => chunk?.byteLength ?? 1 });

  let controller;
  let wasCanceled = false;

  function onData(chunk) {
    if (ArrayBuffer.isView(chunk)) {
      chunk = new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    }
    controller.enqueue(chunk);
    const desiredSize = typeof controller.desiredSize === "number" ? controller.desiredSize : 1;
    if (desiredSize <= 0) streamReadable.pause();
  }

  streamReadable.pause();

  const cleanup = finished(streamReadable, (error) => {
    if (error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
      const err = newAbortError();
      err.cause = error;
      error = err;
    }
    cleanup();
    // Prevent uncaught error events after handoff.
    streamReadable.on("error", () => {});
    if (error) {
      try {
        controller.error(error);
      } catch {
        // controller may already be closed/errored
      }
      return;
    }
    if (!wasCanceled) {
      try {
        controller.close();
      } catch {
        // controller may already be closed/errored
      }
    }
  });

  streamReadable.on("data", onData);

  return new ReadableStreamCtor(
    {
      start(c) {
        controller = c;
      },
      pull() {
        streamReadable.resume();
      },
      cancel(reason) {
        wasCanceled = true;
        destroy(streamReadable, reason);
      },
    },
    strategy,
  );
}

function newStreamReadableFromReadableStream(readableStream, options = {}) {
  if (typeof readableStream?.getReader !== "function") {
    throw new TypeError('The "readableStream" argument must be an instance of ReadableStream');
  }

  const reader = readableStream.getReader();
  let closed = false;
  let reading = false;

  const readable = new Readable({
    objectMode: options?.objectMode,
    highWaterMark: options?.highWaterMark,
    encoding: options?.encoding,
    signal: options?.signal,

    read() {
      if (reading) return;
      reading = true;
      reader.read().then(
        (chunk) => {
          reading = false;
          if (chunk.done) {
            closed = true;
            readable.push(null);
          } else if (readable.push(chunk.value)) {
            // keep pulling; _read will be called again as needed
            this._read();
          }
        },
        (error) => {
          reading = false;
          closed = true;
          readable.destroy(error);
        },
      );
    },

    destroy(error, callback) {
      function done() {
        try {
          callback(error);
        } catch (err) {
          rethrowLater(err);
        }
      }
      if (!closed) {
        const result = error != null ? reader.cancel(error) : reader.cancel();
        Promise.resolve(result).then(done, done);
        return;
      }
      done();
    },
  });

  if (reader.closed && typeof reader.closed.then === "function") {
    reader.closed.then(
      () => {
        closed = true;
      },
      (error) => {
        closed = true;
        readable.destroy(error);
      },
    );
  }

  return readable;
}

function newWritableStreamFromStreamWritable(streamWritable) {
  const WritableStreamCtor = webWritableStreamCtor();
  if (typeof streamWritable?._writableState !== "object" || streamWritable._writableState === null) {
    throw new TypeError('The "streamWritable" argument must be an instance of stream.Writable');
  }

  if (isDestroyed(streamWritable) || !isWritable(streamWritable)) {
    const writable = new WritableStreamCtor();
    writable.close();
    return writable;
  }

  const highWaterMark = streamWritable.writableHighWaterMark;
  const strategy = streamWritable.writableObjectMode
    ? { highWaterMark, size: () => 1 }
    : { highWaterMark, size: (chunk) => chunk?.byteLength ?? 1 };

  let controller;
  let backpressurePromise;
  let closed;

  function onDrain() {
    if (backpressurePromise !== undefined) {
      backpressurePromise.resolve();
      backpressurePromise = undefined;
    }
  }

  const cleanup = finished(streamWritable, (error) => {
    if (error?.code === "ERR_STREAM_PREMATURE_CLOSE") {
      const err = newAbortError();
      err.cause = error;
      error = err;
    }
    cleanup();
    streamWritable.on("error", () => {});
    if (error != null) {
      if (backpressurePromise !== undefined) backpressurePromise.reject(error);
      if (closed !== undefined) {
        closed.reject(error);
        closed = undefined;
      }
      try {
        controller?.error(error);
      } catch {
        // ignore
      }
      controller = undefined;
      return;
    }
    if (closed !== undefined) {
      closed.resolve();
      closed = undefined;
      return;
    }
    try {
      controller?.error(newAbortError());
    } catch {
      // ignore
    }
    controller = undefined;
  });

  streamWritable.on("drain", onDrain);

  function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  return new WritableStreamCtor(
    {
      start(c) {
        controller = c;
      },

      write(chunk) {
        if (streamWritable.writableNeedDrain || !streamWritable.write(chunk)) {
          backpressurePromise = deferred();
          return backpressurePromise.promise;
        }
      },

      abort(reason) {
        destroy(streamWritable, reason);
      },

      close() {
        if (closed === undefined && !isWritableEnded(streamWritable)) {
          closed = deferred();
          streamWritable.end();
          return closed.promise;
        }
        cleanup();
        return Promise.resolve();
      },
    },
    strategy,
  );
}

function isWritableEnded(stream) {
  return stream.writableEnded === true;
}

function newStreamWritableFromWritableStream(writableStream, options = {}) {
  if (typeof writableStream?.getWriter !== "function") {
    throw new TypeError('The "writableStream" argument must be an instance of WritableStream');
  }

  const writer = writableStream.getWriter();
  let closed = false;

  const writable = new Writable({
    highWaterMark: options?.highWaterMark,
    objectMode: options?.objectMode,
    signal: options?.signal,
    decodeStrings: options?.decodeStrings !== false,

    write(chunk, encoding, callback) {
      Promise.resolve(writer.ready).then(
        () => Promise.resolve(writer.write(chunk)).then(() => callback(), callback),
        callback,
      );
    },

    final(callback) {
      if (!closed) {
        Promise.resolve(writer.close()).then(() => callback(), callback);
        return;
      }
      callback();
    },

    destroy(error, callback) {
      function done() {
        try {
          callback(error);
        } catch (err) {
          rethrowLater(err);
        }
      }
      if (!closed) {
        const result = error != null ? writer.abort(error) : writer.close();
        Promise.resolve(result).then(done, done);
        return;
      }
      done();
    },
  });

  if (writer.closed && typeof writer.closed.then === "function") {
    writer.closed.then(
      () => {
        closed = true;
      },
      (error) => {
        closed = true;
        writable.destroy(error);
      },
    );
  }

  return writable;
}

function newReadableWritablePairFromDuplex(duplex) {
  if (typeof duplex?._writableState !== "object" || typeof duplex?._readableState !== "object") {
    throw new TypeError('The "duplex" argument must be an instance of stream.Duplex');
  }

  const writable =
    isDestroyed(duplex) || !isWritable(duplex)
      ? (() => {
          const w = new (webWritableStreamCtor())();
          w.close();
          return w;
        })()
      : newWritableStreamFromStreamWritable(duplex);

  const readable =
    isDestroyed(duplex) || !isReadable(duplex)
      ? (() => {
          const r = new (webReadableStreamCtor())();
          r.cancel();
          return r;
        })()
      : newReadableStreamFromStreamReadable(duplex);

  return { writable, readable };
}

function newStreamDuplexFromReadableWritablePair(pair = {}, options = {}) {
  const { readable: readableStream, writable: writableStream } = pair;
  if (typeof readableStream?.getReader !== "function") {
    throw new TypeError('The "pair.readable" argument must be an instance of ReadableStream');
  }
  if (typeof writableStream?.getWriter !== "function") {
    throw new TypeError('The "pair.writable" argument must be an instance of WritableStream');
  }

  const writer = writableStream.getWriter();
  const reader = readableStream.getReader();
  let writableClosed = false;
  let readableClosed = false;
  let reading = false;

  const duplex = new Duplex({
    allowHalfOpen: true,
    highWaterMark: options?.highWaterMark,
    objectMode: options?.objectMode,
    encoding: options?.encoding,
    decodeStrings: options?.decodeStrings !== false,
    signal: options?.signal,

    write(chunk, encoding, callback) {
      Promise.resolve(writer.ready).then(
        () => Promise.resolve(writer.write(chunk)).then(() => callback(), callback),
        callback,
      );
    },

    final(callback) {
      if (!writableClosed) {
        Promise.resolve(writer.close()).then(() => callback(), callback);
        return;
      }
      callback();
    },

    read() {
      if (reading) return;
      reading = true;
      reader.read().then(
        (chunk) => {
          reading = false;
          if (chunk.done) {
            readableClosed = true;
            duplex.push(null);
          } else if (duplex.push(chunk.value)) {
            this._read();
          }
        },
        (error) => {
          reading = false;
          readableClosed = true;
          duplex.destroy(error);
        },
      );
    },

    destroy(error, callback) {
      function done() {
        try {
          callback(error);
        } catch (err) {
          rethrowLater(err);
        }
      }
      async function closeAll() {
        if (!writableClosed) {
          await (error != null ? writer.abort(error) : writer.close()).catch(() => {});
          writableClosed = true;
        }
        if (!readableClosed) {
          await reader.cancel(error).catch(() => {});
          readableClosed = true;
        }
      }
      closeAll().then(done, done);
    },
  });

  if (writer.closed && typeof writer.closed.then === "function") {
    writer.closed.then(
      () => {
        writableClosed = true;
      },
      (error) => {
        writableClosed = true;
        readableClosed = true;
        duplex.destroy(error);
      },
    );
  }
  if (reader.closed && typeof reader.closed.then === "function") {
    reader.closed.then(
      () => {
        readableClosed = true;
      },
      (error) => {
        writableClosed = true;
        readableClosed = true;
        duplex.destroy(error);
      },
    );
  }

  return duplex;
}

Readable.fromWeb = function fromWeb(readableStream, options) {
  return newStreamReadableFromReadableStream(readableStream, options);
};
Readable.toWeb = function toWeb(streamReadable, options) {
  return newReadableStreamFromStreamReadable(streamReadable, options);
};
Writable.fromWeb = function fromWeb(writableStream, options) {
  return newStreamWritableFromWritableStream(writableStream, options);
};
Writable.toWeb = function toWeb(streamWritable) {
  return newWritableStreamFromStreamWritable(streamWritable);
};
Duplex.fromWeb = function fromWeb(pair, options) {
  return newStreamDuplexFromReadableWritablePair(pair, options);
};
Duplex.toWeb = function toWeb(duplex) {
  return newReadableWritablePairFromDuplex(duplex);
};

export { Stream };
export default Stream;
