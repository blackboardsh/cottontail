import { Buffer } from "../buffer.js";
import {
  brotliCompressSync,
  brotliDecompressSync,
  deflateRawSync,
  deflateSync,
  gunzipSync,
  gzipSync,
  inflateRawSync,
  inflateSync,
} from "../zlib.js";

const textEncoder = new TextEncoder();

function bytesFromChunk(chunk) {
  if (chunk == null) return new Uint8Array(0);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === "string") return textEncoder.encode(chunk);
  return Buffer.from(String(chunk));
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export class ReadableStreamDefaultController {
  constructor(stream) { this._stream = stream; }
  enqueue(chunk) { this._stream._enqueue(chunk); }
  close() { this._stream._close(); }
  error(error) { this._stream._error(error); }
}

export class ReadableByteStreamController extends ReadableStreamDefaultController {}

export class ReadableStream {
  constructor(underlyingSource = {}) {
    this._queue = [];
    this._closed = false;
    this._errorValue = undefined;
    this._readers = [];
    this.locked = false;
    this._controller = new ReadableStreamDefaultController(this);
    if (typeof underlyingSource.start === "function") underlyingSource.start(this._controller);
    this._pull = underlyingSource.pull;
    this._cancel = underlyingSource.cancel;
  }

  _enqueue(chunk) {
    if (this._closed) return;
    const reader = this._readers.shift();
    if (reader) reader({ value: chunk, done: false });
    else this._queue.push(chunk);
  }

  _close() {
    this._closed = true;
    while (this._readers.length > 0) this._readers.shift()({ value: undefined, done: true });
  }

  _error(error) {
    this._errorValue = error;
    this._closed = true;
    while (this._readers.length > 0) this._readers.shift()(Promise.reject(error));
  }

  getReader(options = undefined) {
    this.locked = true;
    if (options?.mode === "byob") return new ReadableStreamBYOBReader(this);
    return new ReadableStreamDefaultReader(this);
  }

  cancel(reason = undefined) {
    this._closed = true;
    return Promise.resolve(this._cancel?.(reason));
  }

  tee() {
    const left = new ReadableStream();
    const right = new ReadableStream();
    (async () => {
      const reader = this.getReader();
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        left._enqueue(item.value);
        right._enqueue(item.value);
      }
      left._close();
      right._close();
    })();
    return [left, right];
  }
}

export class ReadableStreamDefaultReader {
  constructor(stream) { this._stream = stream; }
  read() {
    if (this._stream._errorValue) return Promise.reject(this._stream._errorValue);
    if (this._stream._queue.length > 0) return Promise.resolve({ value: this._stream._queue.shift(), done: false });
    if (this._stream._closed) return Promise.resolve({ value: undefined, done: true });
    this._stream._pull?.(this._stream._controller);
    if (this._stream._errorValue) return Promise.reject(this._stream._errorValue);
    if (this._stream._queue.length > 0) return Promise.resolve({ value: this._stream._queue.shift(), done: false });
    if (this._stream._closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this._stream._readers.push(resolve));
  }
  releaseLock() { this._stream.locked = false; }
  cancel(reason = undefined) { return this._stream.cancel(reason); }
}

export class ReadableStreamBYOBReader extends ReadableStreamDefaultReader {
  read(view) {
    if (!ArrayBuffer.isView(view)) return Promise.reject(new TypeError("ReadableStreamBYOBReader.read requires an ArrayBuffer view"));
    const target = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return super.read().then((item) => {
      if (item.done) return { value: view.subarray ? view.subarray(0, 0) : view, done: true };
      const bytes = bytesFromChunk(item.value);
      const count = Math.min(target.byteLength, bytes.byteLength);
      target.set(bytes.subarray(0, count));
      if (count < bytes.byteLength) this._stream._queue.unshift(bytes.subarray(count));
      const value = view.subarray ? view.subarray(0, count) : new Uint8Array(view.buffer, view.byteOffset, count);
      return { value, done: false };
    });
  }
}
export class ReadableStreamBYOBRequest {
  constructor() { this.view = null; }
  respond() {}
  respondWithNewView(view) { this.view = view; }
}

export class WritableStreamDefaultController {
  constructor(stream) { this._stream = stream; }
  error(error) { this._stream._errorValue = error; }
}

export class WritableStream {
  constructor(underlyingSink = {}) {
    this._sink = underlyingSink;
    this._closed = false;
    this._errorValue = undefined;
    this.locked = false;
    this._controller = new WritableStreamDefaultController(this);
    if (typeof underlyingSink.start === "function") underlyingSink.start(this._controller);
  }

  getWriter() {
    this.locked = true;
    return new WritableStreamDefaultWriter(this);
  }

  abort(reason = undefined) {
    this._closed = true;
    return Promise.resolve(this._sink.abort?.(reason));
  }

  close() {
    this._closed = true;
    return Promise.resolve(this._sink.close?.());
  }
}

export class WritableStreamDefaultWriter {
  constructor(stream) { this._stream = stream; }
  write(chunk) { return Promise.resolve(this._stream._sink.write?.(chunk, this._stream._controller)); }
  close() { return this._stream.close(); }
  abort(reason = undefined) { return this._stream.abort(reason); }
  releaseLock() { this._stream.locked = false; }
  get ready() { return Promise.resolve(); }
  get closed() { return this._stream._closed ? Promise.resolve() : Promise.resolve(); }
}

export class TransformStreamDefaultController {
  constructor(stream) { this._stream = stream; }
  enqueue(chunk) { this._stream._readable._enqueue(chunk); }
  error(error) { this._stream._readable._error(error); }
  terminate() { this._stream._readable._close(); }
}

export class TransformStream {
  constructor(transformer = {}) {
    this._readable = new ReadableStream();
    this._controller = new TransformStreamDefaultController(this);
    this.readable = this._readable;
    this.writable = new WritableStream({
      write: async (chunk) => {
        if (typeof transformer.transform === "function") {
          await transformer.transform(chunk, this._controller);
        } else {
          this._controller.enqueue(chunk);
        }
      },
      close: async () => {
        if (typeof transformer.flush === "function") await transformer.flush(this._controller);
        this._controller.terminate();
      },
    });
    if (typeof transformer.start === "function") transformer.start(this._controller);
  }
}

export class ByteLengthQueuingStrategy {
  constructor(options = {}) { this.highWaterMark = Number(options.highWaterMark ?? 0); }
  size(chunk) { return Number(chunk?.byteLength ?? chunk?.length ?? 1); }
}

export class CountQueuingStrategy {
  constructor(options = {}) { this.highWaterMark = Number(options.highWaterMark ?? 0); }
  size() { return 1; }
}

export class TextEncoderStream extends TransformStream {
  constructor() {
    const encoder = new TextEncoder();
    super({ transform(chunk, controller) { controller.enqueue(encoder.encode(String(chunk))); } });
    this.encoding = "utf-8";
  }
}

export class TextDecoderStream extends TransformStream {
  constructor(encoding = "utf-8") {
    const decoder = new TextDecoder(encoding);
    super({ transform(chunk, controller) { controller.enqueue(decoder.decode(chunk)); } });
    this.encoding = encoding;
  }
}

function compressionMode(format, decompress = false) {
  const normalized = String(format).toLowerCase();
  if (decompress) {
    if (normalized === "gzip") return gunzipSync;
    if (normalized === "deflate") return inflateSync;
    if (normalized === "deflate-raw") return inflateRawSync;
    if (normalized === "br" || normalized === "brotli") return brotliDecompressSync;
  } else {
    if (normalized === "gzip") return gzipSync;
    if (normalized === "deflate") return deflateSync;
    if (normalized === "deflate-raw") return deflateRawSync;
    if (normalized === "br" || normalized === "brotli") return brotliCompressSync;
  }
  throw new TypeError(`Invalid compression format: ${format}`);
}

export class CompressionStream extends TransformStream {
  constructor(format) {
    const chunks = [];
    const transform = compressionMode(format, false);
    super({
      transform(chunk) { chunks.push(bytesFromChunk(chunk)); },
      flush(controller) { controller.enqueue(transform(concatBytes(chunks))); },
    });
    this.format = String(format);
  }
}

export class DecompressionStream extends TransformStream {
  constructor(format) {
    const chunks = [];
    const transform = compressionMode(format, true);
    super({
      transform(chunk) { chunks.push(bytesFromChunk(chunk)); },
      flush(controller) { controller.enqueue(transform(concatBytes(chunks))); },
    });
    this.format = String(format);
  }
}

export default {
  ByteLengthQueuingStrategy,
  CompressionStream,
  CountQueuingStrategy,
  DecompressionStream,
  ReadableByteStreamController,
  ReadableStream,
  ReadableStreamBYOBReader,
  ReadableStreamBYOBRequest,
  ReadableStreamDefaultController,
  ReadableStreamDefaultReader,
  TextDecoderStream,
  TextEncoderStream,
  TransformStream,
  TransformStreamDefaultController,
  WritableStream,
  WritableStreamDefaultController,
  WritableStreamDefaultWriter,
};
