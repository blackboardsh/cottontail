import * as zlibConstants from "./zlib/constants.js";

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
  const result = level == null
    ? cottontail.zlibTransformSync(mode, bytesFromData(data))
    : cottontail.zlibTransformSync(mode, bytesFromData(data), level);
  return asBuffer(result);
}

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

export const deflate = callbackifySync(deflateSync);
export const deflateRaw = callbackifySync(deflateRawSync);
export const gzip = callbackifySync(gzipSync);
export const inflate = callbackifySync(inflateSync);
export const inflateRaw = callbackifySync(inflateRawSync);
export const gunzip = callbackifySync(gunzipSync);
export const unzip = callbackifySync(unzipSync);

// COTTONTAIL-COMPAT: node:zlib streams/Brotli/Zstd/crc32 - require stream classes plus native Brotli/Zstd/crc32 bindings; add after core sync/callback zlib transforms.

export default {
  codes,
  constants,
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
};
