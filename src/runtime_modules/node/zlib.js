import * as zlibConstants from "./zlib/constants.js";
import { Transform } from "./stream.js";

export {
  DEFLATE,
  DEFLATERAW,
  GUNZIP,
  GZIP,
  INFLATE,
  INFLATERAW,
  UNZIP,
  ZLIB_VERNUM,
  ZSTD_CLEVEL_DEFAULT,
  ZSTD_COMPRESS,
  ZSTD_DECOMPRESS,
  ZSTD_btlazy2,
  ZSTD_btopt,
  ZSTD_btultra,
  ZSTD_btultra2,
  ZSTD_c_chainLog,
  ZSTD_c_checksumFlag,
  ZSTD_c_compressionLevel,
  ZSTD_c_contentSizeFlag,
  ZSTD_c_dictIDFlag,
  ZSTD_c_enableLongDistanceMatching,
  ZSTD_c_hashLog,
  ZSTD_c_jobSize,
  ZSTD_c_ldmBucketSizeLog,
  ZSTD_c_ldmHashLog,
  ZSTD_c_ldmHashRateLog,
  ZSTD_c_ldmMinMatch,
  ZSTD_c_minMatch,
  ZSTD_c_nbWorkers,
  ZSTD_c_overlapLog,
  ZSTD_c_searchLog,
  ZSTD_c_strategy,
  ZSTD_c_targetLength,
  ZSTD_c_windowLog,
  ZSTD_d_windowLogMax,
  ZSTD_dfast,
  ZSTD_e_continue,
  ZSTD_e_end,
  ZSTD_e_flush,
  ZSTD_error_GENERIC,
  ZSTD_error_checksum_wrong,
  ZSTD_error_corruption_detected,
  ZSTD_error_dictionaryCreation_failed,
  ZSTD_error_dictionary_corrupted,
  ZSTD_error_dictionary_wrong,
  ZSTD_error_dstBuffer_null,
  ZSTD_error_dstSize_tooSmall,
  ZSTD_error_frameParameter_unsupported,
  ZSTD_error_frameParameter_windowTooLarge,
  ZSTD_error_init_missing,
  ZSTD_error_literals_headerWrong,
  ZSTD_error_maxSymbolValue_tooLarge,
  ZSTD_error_maxSymbolValue_tooSmall,
  ZSTD_error_memory_allocation,
  ZSTD_error_noForwardProgress_destFull,
  ZSTD_error_noForwardProgress_inputEmpty,
  ZSTD_error_no_error,
  ZSTD_error_parameter_combination_unsupported,
  ZSTD_error_parameter_outOfBound,
  ZSTD_error_parameter_unsupported,
  ZSTD_error_prefix_unknown,
  ZSTD_error_srcSize_wrong,
  ZSTD_error_stabilityCondition_notRespected,
  ZSTD_error_stage_wrong,
  ZSTD_error_tableLog_tooLarge,
  ZSTD_error_version_unsupported,
  ZSTD_error_workSpace_tooSmall,
  ZSTD_fast,
  ZSTD_greedy,
  ZSTD_lazy,
  ZSTD_lazy2,
  Z_BEST_COMPRESSION,
  Z_BEST_SPEED,
  Z_BLOCK,
  Z_BUF_ERROR,
  Z_DATA_ERROR,
  Z_DEFAULT_CHUNK,
  Z_DEFAULT_COMPRESSION,
  Z_DEFAULT_LEVEL,
  Z_DEFAULT_MEMLEVEL,
  Z_DEFAULT_STRATEGY,
  Z_DEFAULT_WINDOWBITS,
  Z_ERRNO,
  Z_FILTERED,
  Z_FINISH,
  Z_FIXED,
  Z_FULL_FLUSH,
  Z_HUFFMAN_ONLY,
  Z_MAX_CHUNK,
  Z_MAX_LEVEL,
  Z_MAX_MEMLEVEL,
  Z_MAX_WINDOWBITS,
  Z_MEM_ERROR,
  Z_MIN_CHUNK,
  Z_MIN_LEVEL,
  Z_MIN_MEMLEVEL,
  Z_MIN_WINDOWBITS,
  Z_NEED_DICT,
  Z_NO_COMPRESSION,
  Z_NO_FLUSH,
  Z_OK,
  Z_PARTIAL_FLUSH,
  Z_RLE,
  Z_STREAM_END,
  Z_STREAM_ERROR,
  Z_SYNC_FLUSH,
  Z_VERSION_ERROR
} from "./zlib/constants.js";

export const constants = zlibConstants;
export const codes = {
  "0": "Z_OK",
  "1": "Z_STREAM_END",
  "2": "Z_NEED_DICT",
  "Z_OK": 0,
  "Z_STREAM_END": 1,
  "Z_NEED_DICT": 2,
  "Z_ERRNO": -1,
  "Z_STREAM_ERROR": -2,
  "Z_DATA_ERROR": -3,
  "Z_MEM_ERROR": -4,
  "Z_BUF_ERROR": -5,
  "Z_VERSION_ERROR": -6,
  "-1": "Z_ERRNO",
  "-2": "Z_STREAM_ERROR",
  "-3": "Z_DATA_ERROR",
  "-4": "Z_MEM_ERROR",
  "-5": "Z_BUF_ERROR",
  "-6": "Z_VERSION_ERROR"
};

function bytesFromData(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

function asBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes;
}

function levelFromOptions(options) {
  if (options && typeof options === "object" && options.level != null) return Number(options.level);
  return undefined;
}

function transformSync(mode, data, options = undefined) {
  if (typeof cottontail.zlibTransformSync !== "function") {
    throw new Error("native zlib support is unavailable");
  }
  const level = levelFromOptions(options);
  const nativeOptions = options && typeof options === "object" ? options : level;
  const result = nativeOptions == null
    ? cottontail.zlibTransformSync(mode, bytesFromData(data))
    : cottontail.zlibTransformSync(mode, bytesFromData(data), nativeOptions);
  return asBuffer(result);
}

function defaultStreamFinishFlush(mode) {
  return mode === "inflate" || mode === "inflateRaw" || mode === "gunzip" || mode === "unzip"
    ? constants.Z_SYNC_FLUSH
    : constants.Z_FINISH;
}

const crc32Table = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data, value = 0) {
  let crc = (Number(value) ^ -1) >>> 0;
  for (const byte of bytesFromData(data)) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

class ZlibTransform extends Transform {
  constructor(mode, options = {}) {
    super();
    this._mode = mode;
    this._options = options ?? {};
    this._chunks = [];
    this.bytesRead = 0;
    this.bytesWritten = 0;
  }

  _consumeChunks() {
    const inputLength = this._chunks.reduce((sum, item) => sum + item.byteLength, 0);
    const input = new Uint8Array(inputLength);
    let offset = 0;
    for (const chunkBytes of this._chunks) {
      input.set(chunkBytes, offset);
      offset += chunkBytes.byteLength;
    }
    this._chunks = [];
    return input;
  }

  _emitBuffered() {
    if (this._chunks.length === 0) return false;
    const output = transformSync(this._mode, this._consumeChunks(), {
      finishFlush: defaultStreamFinishFlush(this._mode),
      ...this._options,
    });
    this.bytesWritten += output.byteLength ?? output.length ?? 0;
    this.push(output);
    return true;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    const bytes = bytesFromData(typeof chunk === "string" && encoding ? globalThis.Buffer?.from(chunk, encoding) ?? chunk : chunk);
    this._chunks.push(bytes);
    this.bytesRead += bytes.byteLength;
    callback?.();
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
    try {
      this._emitBuffered();
      this.push(null);
      this.emit("finish");
      callback?.();
    } catch (error) {
      this.emit("error", error);
      callback?.(error);
    }
  }

  flush(kind = undefined, callback = undefined) {
    if (typeof kind === "function") {
      callback = kind;
      kind = undefined;
    }
    void kind;
    try {
      this._emitBuffered();
      callback?.();
    } catch (error) {
      this.emit("error", error);
      callback?.(error);
    }
  }

  close(callback = undefined) {
    callback?.();
    this.emit("close");
  }

  reset() {
    this._chunks = [];
    this.bytesRead = 0;
    this.bytesWritten = 0;
  }
}

export class Deflate extends ZlibTransform { constructor(options = {}) { super("deflate", options); } }
export class DeflateRaw extends ZlibTransform { constructor(options = {}) { super("deflateRaw", options); } }
export class Gzip extends ZlibTransform { constructor(options = {}) { super("gzip", options); } }
export class Gunzip extends ZlibTransform { constructor(options = {}) { super("gunzip", options); } }
export class Inflate extends ZlibTransform { constructor(options = {}) { super("inflate", options); } }
export class InflateRaw extends ZlibTransform { constructor(options = {}) { super("inflateRaw", options); } }
export class Unzip extends ZlibTransform { constructor(options = {}) { super("unzip", options); } }
export class BrotliCompress extends ZlibTransform { constructor(options = {}) { super("brotliCompress", options); } }
export class BrotliDecompress extends ZlibTransform { constructor(options = {}) { super("brotliDecompress", options); } }
export class ZstdCompress extends ZlibTransform { constructor(options = {}) { super("zstdCompress", options); } }
export class ZstdDecompress extends ZlibTransform { constructor(options = {}) { super("zstdDecompress", options); } }

export function createDeflate(options = {}) { return new Deflate(options); }
export function createDeflateRaw(options = {}) { return new DeflateRaw(options); }
export function createGzip(options = {}) { return new Gzip(options); }
export function createGunzip(options = {}) { return new Gunzip(options); }
export function createInflate(options = {}) { return new Inflate(options); }
export function createInflateRaw(options = {}) { return new InflateRaw(options); }
export function createUnzip(options = {}) { return new Unzip(options); }
export function createBrotliCompress(options = {}) { return new BrotliCompress(options); }
export function createBrotliDecompress(options = {}) { return new BrotliDecompress(options); }
export function createZstdCompress(options = {}) { return new ZstdCompress(options); }
export function createZstdDecompress(options = {}) { return new ZstdDecompress(options); }

function callbackifySync(fn) {
  return (data, options, callback) => {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    queueMicrotask(() => {
      try {
        callback(null, fn(data, options));
      } catch (error) {
        callback(error);
      }
    });
  };
}

export function deflateSync(data, options = undefined) { return transformSync("deflate", data, options); }
export function deflateRawSync(data, options = undefined) { return transformSync("deflateRaw", data, options); }
export function gzipSync(data, options = undefined) { return transformSync("gzip", data, options); }
export function inflateSync(data, options = undefined) { return transformSync("inflate", data, options); }
export function inflateRawSync(data, options = undefined) { return transformSync("inflateRaw", data, options); }
export function gunzipSync(data, options = undefined) { return transformSync("gunzip", data, options); }
export function unzipSync(data, options = undefined) { return transformSync("unzip", data, options); }
export function brotliCompressSync(data, options = undefined) { return transformSync("brotliCompress", data, options); }
export function brotliDecompressSync(data, options = undefined) { return transformSync("brotliDecompress", data, options); }
export function zstdCompressSync(data, options = undefined) { return transformSync("zstdCompress", data, options); }
export function zstdDecompressSync(data, options = undefined) { return transformSync("zstdDecompress", data, options); }

export const deflate = callbackifySync(deflateSync);
export const deflateRaw = callbackifySync(deflateRawSync);
export const gzip = callbackifySync(gzipSync);
export const inflate = callbackifySync(inflateSync);
export const inflateRaw = callbackifySync(inflateRawSync);
export const gunzip = callbackifySync(gunzipSync);
export const unzip = callbackifySync(unzipSync);
export const brotliCompress = callbackifySync(brotliCompressSync);
export const brotliDecompress = callbackifySync(brotliDecompressSync);
export const zstdCompress = callbackifySync(zstdCompressSync);
export const zstdDecompress = callbackifySync(zstdDecompressSync);

// COTTONTAIL-COMPAT: node:zlib streaming flush - zlib/gzip/deflate/Brotli/Zstd streams, crc32, compression options, and dictionary transforms are implemented; incremental flush semantics need deeper native stream state.

export default {
  BrotliCompress,
  BrotliDecompress,
  Deflate,
  DeflateRaw,
  Gunzip,
  Gzip,
  Inflate,
  InflateRaw,
  Unzip,
  ZstdCompress,
  ZstdDecompress,
  codes,
  constants,
  crc32,
  brotliCompress,
  brotliCompressSync,
  brotliDecompress,
  brotliDecompressSync,
  createBrotliCompress,
  createBrotliDecompress,
  createDeflate,
  createDeflateRaw,
  createGunzip,
  createGzip,
  createInflate,
  createInflateRaw,
  createUnzip,
  createZstdCompress,
  createZstdDecompress,
  deflate,
  deflateRaw,
  deflateRawSync,
  deflateSync,
  gunzip,
  gunzipSync,
  gzip,
  gzipSync,
  inflate,
  inflateRaw,
  inflateRawSync,
  inflateSync,
  unzip,
  unzipSync,
  zstdCompress,
  zstdCompressSync,
  zstdDecompress,
  zstdDecompressSync,
};
