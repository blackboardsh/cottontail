import { EventEmitter } from "./events.js";

let defaultReadableHighWaterMark = 16 * 1024;
let defaultObjectHighWaterMark = 16;

export class Stream extends EventEmitter {
  pipe(destination, options = {}) {
    this.on("data", (chunk) => destination.write?.(chunk));
    if (options.end !== false) this.on("end", () => destination.end?.());
    return destination;
  }

  destroy(error = undefined) {
    this.destroyed = true;
    if (error) {
      this._errored = error;
      this.emit("error", error);
    }
    this.emit("close");
    return this;
  }
}

export class Readable extends Stream {
  constructor(options = {}) {
    super();
    this.readable = true;
    this.destroyed = false;
    this.readableEnded = false;
    this._read = typeof options.read === "function" ? options.read : () => {};
    this._queue = [];
  }

  push(chunk) {
    if (chunk == null) {
      this.readableEnded = true;
      this.emit("end");
      return false;
    }
    this._queue.push(chunk);
    this.emit("data", chunk);
    this.emit("readable");
    return true;
  }

  read() {
    return this._queue.length > 0 ? this._queue.shift() : this._read();
  }

  resume() { return this; }
  pause() { return this; }

  async *[Symbol.asyncIterator]() {
    while (!this.readableEnded || this._queue.length > 0) {
      const value = this.read();
      if (value != null) {
        yield value;
      } else {
        await new Promise((resolve) => this.once("data", resolve).once("end", resolve));
      }
    }
  }

  static from(iterable) {
    const stream = new Readable();
    Promise.resolve().then(async () => {
      for await (const item of iterable) stream.push(item);
      stream.push(null);
    });
    return stream;
  }
}

export class Writable extends Stream {
  constructor(options = {}) {
    super();
    this.writable = true;
    this.destroyed = false;
    this.writableEnded = false;
    this._write = typeof options.write === "function" ? options.write : null;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this._write) {
      this._write(chunk, encoding, callback ?? (() => {}));
      this.emit("data", chunk);
      return true;
    }
    this.emit("data", chunk);
    if (callback) callback();
    return true;
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    if (typeof chunk === "function") {
      callback = chunk;
      chunk = undefined;
    } else if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (chunk != null) this.write(chunk, encoding);
    this.writableEnded = true;
    this.emit("finish");
    this.emit("end");
    if (callback) callback();
  }
}

export class Duplex extends Readable {
  constructor(options = {}) {
    super(options);
    this.writable = true;
    this._write = typeof options.write === "function" ? options.write : null;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (this._write) this._write(chunk, encoding, callback ?? (() => {}));
    else this.push(chunk);
    if (callback) callback();
    return true;
  }

  end(chunk = undefined) {
    if (chunk != null) this.write(chunk);
    this.push(null);
    this.emit("finish");
  }
}

export class Transform extends Duplex {
  constructor(options = {}) {
    super(options);
    this._transform = typeof options.transform === "function" ? options.transform : null;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    if (this._transform) {
      this._transform(chunk, encoding, (error, value) => {
        if (error) this.emit("error", error);
        if (value != null) this.push(value);
        if (callback) callback(error);
      });
      return true;
    }
    this.push(chunk);
    if (callback) callback();
    return true;
  }
}

export class PassThrough extends Transform {}

export function finished(stream, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const promise = new Promise((resolve, reject) => {
    const done = (error = undefined) => error ? reject(error) : resolve();
    stream.once?.("error", done);
    stream.once?.("end", () => done());
    stream.once?.("finish", () => done());
    stream.once?.("close", () => done());
    options?.signal?.addEventListener?.("abort", () => reject(options.signal.reason ?? new Error("AbortError")), { once: true });
  });
  if (callback) promise.then(() => callback(), callback);
  return callback ? () => {} : promise;
}

export function pipeline(...streams) {
  const callback = typeof streams[streams.length - 1] === "function" ? streams.pop() : undefined;
  for (let index = 0; index < streams.length - 1; index += 1) {
    streams[index].pipe?.(streams[index + 1]);
  }
  const last = streams[streams.length - 1];
  const promise = finished(last);
  if (callback) promise.then(() => callback(), callback);
  return callback ? last : promise;
}

export const promises = { finished, pipeline };

export function addAbortSignal(signal, stream) {
  if (signal?.aborted) stream.destroy?.(signal.reason);
  else signal?.addEventListener?.("abort", () => stream.destroy?.(signal.reason), { once: true });
  return stream;
}

export function compose(...streams) {
  if (streams.length === 1) return streams[0];
  pipeline(...streams, () => {});
  return streams[streams.length - 1];
}

export function duplexPair() {
  const left = new Duplex();
  const right = new Duplex();
  left.write = (chunk, _encoding, callback) => {
    right.push(chunk);
    if (callback) callback();
    return true;
  };
  right.write = (chunk, _encoding, callback) => {
    left.push(chunk);
    if (callback) callback();
    return true;
  };
  return [left, right];
}

export function destroy(stream, error = undefined) {
  return stream?.destroy?.(error);
}

export function isDestroyed(stream) {
  return Boolean(stream?.destroyed);
}

export function isReadable(stream) {
  return Boolean(stream?.readable && !stream?.destroyed);
}

export function isWritable(stream) {
  return Boolean(stream?.writable && !stream?.destroyed);
}

export function isErrored(stream) {
  return Boolean(stream?._errored);
}

export function isDisturbed(stream) {
  return Boolean(stream?.readableEnded || stream?.destroyed || stream?._disturbed);
}

export function getDefaultHighWaterMark(objectMode) {
  return objectMode ? defaultObjectHighWaterMark : defaultReadableHighWaterMark;
}

export function setDefaultHighWaterMark(objectMode, value) {
  if (objectMode) defaultObjectHighWaterMark = Number(value);
  else defaultReadableHighWaterMark = Number(value);
}

export function _isArrayBufferView(value) {
  return ArrayBuffer.isView(value);
}

export function _isUint8Array(value) {
  return value instanceof Uint8Array;
}

export function _uint8ArrayToBuffer(value) {
  return globalThis.Buffer?.from ? globalThis.Buffer.from(value) : value;
}

Object.assign(Stream, {
  Duplex,
  PassThrough,
  Readable,
  Stream,
  Transform,
  Writable,
  _isArrayBufferView,
  _isUint8Array,
  _uint8ArrayToBuffer,
  addAbortSignal,
  compose,
  destroy,
  duplexPair,
  finished,
  getDefaultHighWaterMark,
  isDestroyed,
  isDisturbed,
  isErrored,
  isReadable,
  isWritable,
  pipeline,
  promises,
  setDefaultHighWaterMark,
});

export default Stream;
