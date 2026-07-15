// node:stream/web — WHATWG streams backed by the vendored
// web-streams-polyfill@4.3.0 (./whatwg.js, MIT licensed), plus Bun's
// non-standard `type: "direct"` ReadableStream extension and the encoding /
// compression transform streams.
import * as whatwg from "./whatwg.js";
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
  zstdCompressSync,
  zstdDecompressSync,
} from "../zlib.js";

const textEncoder = new TextEncoder();

function bytesFromChunk(chunk) {
  if (chunk == null) return new Uint8Array(0);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0));
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
  }
  if (typeof chunk === "string") return textEncoder.encode(chunk);
  if (typeof chunk === "number") return textEncoder.encode(String(chunk));
  return textEncoder.encode(String(chunk));
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

export const ReadableStreamDefaultController = whatwg.ReadableStreamDefaultController;
export const ReadableByteStreamController = whatwg.ReadableByteStreamController;
export const ReadableStreamDefaultReader = whatwg.ReadableStreamDefaultReader;
export const ReadableStreamBYOBReader = whatwg.ReadableStreamBYOBReader;
export const ReadableStreamBYOBRequest = whatwg.ReadableStreamBYOBRequest;
export const WritableStream = whatwg.WritableStream;
export const WritableStreamDefaultController = whatwg.WritableStreamDefaultController;
export const WritableStreamDefaultWriter = whatwg.WritableStreamDefaultWriter;
export const TransformStream = whatwg.TransformStream;
export const TransformStreamDefaultController = whatwg.TransformStreamDefaultController;
export const ByteLengthQueuingStrategy = whatwg.ByteLengthQueuingStrategy;
export const CountQueuingStrategy = whatwg.CountQueuingStrategy;

// ---------------------------------------------------------------------------
// Bun extension: "direct" ReadableStream. The underlying source's pull()
// receives a sink with write()/flush()/end()/close() that feeds bytes
// directly into the stream; when the (possibly async) pull() settles, the
// stream is closed.
// ---------------------------------------------------------------------------
class HTTPResponseSink {
  #controller;
  #active = true;
  #buffered = [];

  constructor(controller) {
    this.#controller = controller;
  }

  #assertActive() {
    if (!this.#active) {
      throw new TypeError(
        'This HTTPResponseSink has already been closed. A "direct" ReadableStream terminates its underlying socket once `async pull()` returns.',
      );
    }
  }

  // Writes within one pull() are coalesced and delivered as a single chunk
  // on flush()/end()/pull completion, matching Bun's direct streams.
  write(chunk) {
    if (!(this instanceof HTTPResponseSink)) throw new TypeError("Expected HTTPResponseSink");
    this.#assertActive();
    const bytes = bytesFromChunk(chunk);
    if (bytes.byteLength > 0) this.#buffered.push(bytes);
    return bytes.byteLength;
  }

  #flushBuffered() {
    if (this.#buffered.length === 0) return 0;
    const bytes = concatBytes(this.#buffered);
    this.#buffered = [];
    try {
      this.#controller.enqueue(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    } catch {
      // already closed or errored
    }
    return bytes.byteLength;
  }

  flush() {
    if (!(this instanceof HTTPResponseSink)) throw new TypeError("Expected HTTPResponseSink");
    this.#assertActive();
    return this.#flushBuffered();
  }

  end(chunk = undefined) {
    if (!(this instanceof HTTPResponseSink)) throw new TypeError("Expected HTTPResponseSink");
    this.#assertActive();
    if (chunk !== undefined) this.write(chunk);
    this._finish();
    return Promise.resolve();
  }

  close() {
    if (!(this instanceof HTTPResponseSink)) throw new TypeError("Expected HTTPResponseSink");
    this.#assertActive();
    this._finish();
  }

  _finish() {
    if (!this.#active) return;
    this.#flushBuffered();
    this.#active = false;
    try {
      this.#controller.close();
    } catch {
      // already closed or errored
    }
  }

  _error(error) {
    if (!this.#active) return;
    this.#active = false;
    this.#buffered = [];
    try {
      this.#controller.error(error);
    } catch {
      // already closed or errored
    }
  }

  _deactivate() {
    this.#active = false;
  }
}

function directUnderlyingSource(underlyingSource) {
  const pullFn = underlyingSource.pull;
  const cancelFn = underlyingSource.cancel;
  const startFn = underlyingSource.start;
  let sink;
  let pulled = false;
  return {
    start(controller) {
      sink = new HTTPResponseSink(controller);
      if (typeof startFn === "function") return startFn.call(underlyingSource, sink);
    },
    pull() {
      if (pulled) return undefined;
      pulled = true;
      let result;
      try {
        result = typeof pullFn === "function" ? pullFn.call(underlyingSource, sink) : undefined;
      } catch (error) {
        sink._error(error);
        throw error;
      }
      return Promise.resolve(result).then(
        () => {
          sink._finish();
        },
        (error) => {
          sink._error(error);
          throw error;
        },
      );
    },
    cancel(reason) {
      sink._deactivate();
      if (typeof cancelFn === "function") return cancelFn.call(underlyingSource, reason);
      return undefined;
    },
  };
}

// A Proxy keeps instances (including those produced internally by tee(),
// pipeThrough(), Response bodies, ...) on the polyfill's own prototype while
// letting us intercept construction for the "direct" extension.
export const ReadableStream = new Proxy(whatwg.ReadableStream, {
  construct(target, args, newTarget) {
    const [underlyingSource, strategy] = args;
    if (underlyingSource != null && underlyingSource.type === "direct") {
      const adapted = directUnderlyingSource(underlyingSource);
      const directStrategy = strategy ?? { highWaterMark: 0 };
      return Reflect.construct(target, [adapted, directStrategy], newTarget === ReadableStream ? target : newTarget);
    }
    return Reflect.construct(target, args, newTarget === ReadableStream ? target : newTarget);
  },
});

// Bun extension: reader.readMany() drains every synchronously available
// chunk in one call.
if (typeof whatwg.ReadableStreamDefaultReader.prototype.readMany !== "function") {
  const chunkSize = (chunk) => chunk?.byteLength ?? chunk?.length ?? 0;
  Object.defineProperty(whatwg.ReadableStreamDefaultReader.prototype, "readMany", {
    value: async function readMany() {
      const first = await this.read();
      if (first.done) return { value: [], size: 0, done: true };
      const value = [first.value];
      let size = chunkSize(first.value);
      for (;;) {
        // Only keep reading while the controller queue has chunks ready, so
        // we never leave a dangling read request.
        const controller = this._ownerReadableStream?._readableStreamController;
        if (!controller?._queue?.length) break;
        const next = await this.read();
        if (next.done) break;
        value.push(next.value);
        size += chunkSize(next.value);
      }
      return { value, size, done: false };
    },
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Encoding streams
// ---------------------------------------------------------------------------
export class TextEncoderStream extends TransformStream {
  #encoder = new TextEncoder();
  #pendingHighSurrogate = null;

  constructor() {
    let self;
    super({
      transform: (chunk, controller) => {
        chunk = String(chunk);
        if (self.#pendingHighSurrogate !== null) {
          chunk = self.#pendingHighSurrogate + chunk;
          self.#pendingHighSurrogate = null;
        }
        const last = chunk.charCodeAt(chunk.length - 1);
        if (last >= 0xd800 && last <= 0xdbff) {
          self.#pendingHighSurrogate = chunk[chunk.length - 1];
          chunk = chunk.slice(0, -1);
        }
        if (chunk.length > 0) controller.enqueue(self.#encoder.encode(chunk));
      },
      flush: (controller) => {
        if (self.#pendingHighSurrogate !== null) {
          controller.enqueue(new Uint8Array([0xef, 0xbf, 0xbd]));
          self.#pendingHighSurrogate = null;
        }
      },
    });
    self = this;
  }

  get encoding() {
    return "utf-8";
  }
}

export class TextDecoderStream extends TransformStream {
  #decoder;

  constructor(encoding = "utf-8", options = undefined) {
    // Coerce dictionary members with plain WebIDL boolean semantics; the
    // stricter validation TextDecoder itself applies would reject objects.
    let fatal = false;
    let ignoreBOM = false;
    if (options !== undefined && options !== null) {
      fatal = Boolean(options.fatal);
      ignoreBOM = Boolean(options.ignoreBOM);
    }
    const decoder = new TextDecoder(`${encoding}`, { fatal, ignoreBOM });
    super({
      transform: (chunk, controller) => {
        const text = decoder.decode(chunk, { stream: true });
        if (text.length > 0) controller.enqueue(text);
      },
      flush: (controller) => {
        const text = decoder.decode();
        if (text.length > 0) controller.enqueue(text);
      },
    });
    this.#decoder = decoder;
  }

  get encoding() {
    return this.#decoder.encoding;
  }

  get fatal() {
    return this.#decoder.fatal;
  }

  get ignoreBOM() {
    return this.#decoder.ignoreBOM;
  }
}

// ---------------------------------------------------------------------------
// Compression streams (buffered; synchronous codecs from node:zlib)
// ---------------------------------------------------------------------------
function compressionMode(format, decompress = false) {
  const normalized = String(format).toLowerCase();
  if (decompress) {
    if (normalized === "gzip") return gunzipSync;
    if (normalized === "deflate") return inflateSync;
    if (normalized === "deflate-raw") return inflateRawSync;
    if (normalized === "br" || normalized === "brotli") return brotliDecompressSync;
    if (normalized === "zstd") return zstdDecompressSync;
  } else {
    if (normalized === "gzip") return gzipSync;
    if (normalized === "deflate") return deflateSync;
    if (normalized === "deflate-raw") return deflateRawSync;
    if (normalized === "br" || normalized === "brotli") return brotliCompressSync;
    if (normalized === "zstd") return zstdCompressSync;
  }
  throw new TypeError(`Invalid compression format: ${format}`);
}

function chunkToBytesStrict(chunk) {
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk.slice(0));
  if (ArrayBuffer.isView(chunk)) {
    return new Uint8Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
  }
  throw new TypeError("Expected chunk to be an ArrayBuffer or an ArrayBuffer view");
}

export class CompressionStream extends TransformStream {
  constructor(format) {
    const chunks = [];
    const transform = compressionMode(format, false);
    super({
      transform(chunk) {
        chunks.push(chunkToBytesStrict(chunk));
      },
      flush(controller) {
        const output = transform(concatBytes(chunks));
        controller.enqueue(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
      },
    });
    this.format = String(format);
  }
}

export class DecompressionStream extends TransformStream {
  constructor(format) {
    const chunks = [];
    const transform = compressionMode(format, true);
    super({
      transform(chunk) {
        chunks.push(chunkToBytesStrict(chunk));
      },
      flush(controller) {
        const output = transform(concatBytes(chunks));
        controller.enqueue(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
      },
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
