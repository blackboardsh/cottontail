import * as zlibConstants from "./zlib/constants.js";
import bufferModule from "./buffer.js";
import { Transform } from "./stream.js";

export {
  BROTLI_DECODE,
  BROTLI_ENCODE,
  BROTLI_OPERATION_PROCESS,
  BROTLI_OPERATION_FLUSH,
  BROTLI_OPERATION_FINISH,
  BROTLI_OPERATION_EMIT_METADATA,
  BROTLI_PARAM_MODE,
  BROTLI_MODE_GENERIC,
  BROTLI_MODE_TEXT,
  BROTLI_MODE_FONT,
  BROTLI_DEFAULT_MODE,
  BROTLI_PARAM_QUALITY,
  BROTLI_MIN_QUALITY,
  BROTLI_MAX_QUALITY,
  BROTLI_DEFAULT_QUALITY,
  BROTLI_PARAM_LGWIN,
  BROTLI_MIN_WINDOW_BITS,
  BROTLI_MAX_WINDOW_BITS,
  BROTLI_LARGE_MAX_WINDOW_BITS,
  BROTLI_DEFAULT_WINDOW,
  BROTLI_PARAM_LGBLOCK,
  BROTLI_MIN_INPUT_BLOCK_BITS,
  BROTLI_MAX_INPUT_BLOCK_BITS,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING,
  BROTLI_PARAM_SIZE_HINT,
  BROTLI_PARAM_LARGE_WINDOW,
  BROTLI_PARAM_NPOSTFIX,
  BROTLI_PARAM_NDIRECT,
  BROTLI_DECODER_RESULT_ERROR,
  BROTLI_DECODER_RESULT_SUCCESS,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION,
  BROTLI_DECODER_PARAM_LARGE_WINDOW,
  BROTLI_DECODER_NO_ERROR,
  BROTLI_DECODER_SUCCESS,
  BROTLI_DECODER_NEEDS_MORE_INPUT,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES,
  BROTLI_DECODER_ERROR_UNREACHABLE,
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

// Node and Bun expose this CommonJS export as writable. Cottontail eagerly
// bundles builtins, so preserve that behavior on the shared namespace object.
const kMaxLengthDescriptor = Object.getOwnPropertyDescriptor(bufferModule, "kMaxLength");
if (kMaxLengthDescriptor?.configurable && kMaxLengthDescriptor.writable !== true) {
  Object.defineProperty(bufferModule, "kMaxLength", {
    configurable: true,
    enumerable: kMaxLengthDescriptor.enumerable,
    value: bufferModule.kMaxLength,
    writable: true,
  });
}

function bytesFromData(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return new TextEncoder().encode(String(data));
}

function asBuffer(value) {
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return globalThis.Buffer?.from
    ? globalThis.Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;
}

function invalidOptionType(name, value) {
  const error = new TypeError(`The "options.${name}" property must be of type number. Received type ${typeof value}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function outOfRangeOption(name, range, value) {
  const error = new RangeError(`The value of "options.${name}" is out of range. It must be ${range}. Received ${String(value)}`);
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

function validateNumericOption(options, name, minimum, maximum) {
  const value = options[name];
  if (value === undefined) return;
  if (typeof value !== "number") throw invalidOptionType(name, value);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw outOfRangeOption(name, `>= ${minimum} and <= ${maximum}`, value);
  }
}

function validateZlibOptions(options) {
  if (options === undefined) return {};
  if (options === null || typeof options !== "object") {
    const error = new TypeError(`The "options" argument must be of type object. Received ${options === null ? "null" : `type ${typeof options}`}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  validateNumericOption(options, "chunkSize", constants.Z_MIN_CHUNK, kMaxLengthLimit());
  validateNumericOption(options, "level", constants.Z_MIN_LEVEL, constants.Z_MAX_LEVEL);
  validateNumericOption(options, "windowBits", constants.Z_MIN_WINDOWBITS, constants.Z_MAX_WINDOWBITS);
  validateNumericOption(options, "memLevel", constants.Z_MIN_MEMLEVEL, constants.Z_MAX_MEMLEVEL);
  validateNumericOption(options, "strategy", constants.Z_DEFAULT_STRATEGY, constants.Z_FIXED);
  validateNumericOption(options, "maxOutputLength", 1, kMaxLengthLimit());
  return options;
}

function levelFromOptions(options) {
  if (options && typeof options === "object" && options.level != null) return Number(options.level);
  return undefined;
}

function transformSync(mode, data, options = undefined) {
  if (typeof cottontail.zlibTransformSync !== "function") {
    throw new Error("native zlib support is unavailable");
  }
  if (mode === "deflate" || mode === "deflateRaw" || mode === "gzip") validateZlibOptions(options);
  const level = levelFromOptions(options);
  const nativeOptions = options && typeof options === "object" ? options : level;
  let result;
  try {
    result = nativeOptions == null
      ? cottontail.zlibTransformSync(mode, bytesFromData(data))
      : cottontail.zlibTransformSync(mode, bytesFromData(data), nativeOptions);
  } catch (error) {
    if (String(error) === "COTTONTAIL_ZLIB_OUTPUT_LIMIT") {
      const maxOutputLength = Number(options?.maxOutputLength ?? kMaxLengthLimit());
      const rangeError = new RangeError(`Cannot create a Buffer larger than ${maxOutputLength} bytes`);
      rangeError.code = "ERR_BUFFER_TOO_LARGE";
      throw rangeError;
    }
    throw error;
  }
  const output = asBuffer(result);
  const maxOutputLength = options && typeof options === "object" && options.maxOutputLength != null
    ? Number(options.maxOutputLength)
    : kMaxLengthLimit();
  if (output.length > maxOutputLength) {
    const error = new RangeError(`Cannot create a Buffer larger than ${maxOutputLength} bytes`);
    error.code = "ERR_BUFFER_TOO_LARGE";
    throw error;
  }
  return output;
}

function createBrotliEncoder(options) {
  if (typeof cottontail.brotliEncoderCreate !== "function") return null;
  return cottontail.brotliEncoderCreate(options);
}

function writeBrotliEncoder(handle, data, operation) {
  if (typeof cottontail.brotliEncoderWrite !== "function") {
    throw new Error("native Brotli streaming support is unavailable");
  }
  return asBuffer(cottontail.brotliEncoderWrite(handle, bytesFromData(data), operation));
}

function computeConsumedSync(mode, options, input, fullOutput) {
  // Appending junk that cannot continue the stream distinguishes "engine
  // already saw end-of-stream at offset L" (junk is ignored, output is
  // unchanged) from "stream still open at L" (junk corrupts the stream).
  const junk = new Uint8Array([0xde, 0xad, 0x01, 0xff, 0xfe, 0x80, 0x7f]);
  const outputEquals = (candidate) => {
    const a = candidate instanceof Uint8Array ? candidate : new Uint8Array(candidate);
    if (a.byteLength !== fullOutput.byteLength) return false;
    for (let i = 0; i < a.byteLength; i += 1) {
      if (a[i] !== fullOutput[i]) return false;
    }
    return true;
  };
  const endedAt = (length) => {
    const probe = new Uint8Array(length + junk.length);
    probe.set(input.subarray(0, length), 0);
    probe.set(junk, length);
    try {
      return outputEquals(transformSync(mode, probe, options));
    } catch {
      return false;
    }
  };
  if (!endedAt(input.byteLength)) return input.byteLength;
  let low = 0;
  let high = input.byteLength;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (endedAt(middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

// gzip members and zstd frames concatenate into a single valid stream;
// Node's sync decompressors keep decoding subsequent members, so loop over
// any input remaining after each member ends.
function zstdFrameBoundaries(input) {
  const positions = [];
  for (let i = 1; i + 3 < input.byteLength; i += 1) {
    if (input[i] === 0x28 && input[i + 1] === 0xb5 && input[i + 2] === 0x2f && input[i + 3] === 0xfd) positions.push(i);
  }
  return positions;
}

function decompressMembersSync(mode, data, options) {
  const input = bytesFromData(data);
  let first;
  try {
    first = transformSync(mode, input, options);
  } catch (error) {
    // The native zstd decoder rejects inputs with data trailing the first
    // frame instead of decoding it; split on frame magics and decode each
    // candidate frame separately (Node concatenates all frames).
    if (mode !== "zstdDecompress") throw error;
    const boundaries = zstdFrameBoundaries(input);
    if (boundaries.length === 0) throw error;
    const parts = [];
    let start = 0;
    for (const boundary of boundaries) {
      try {
        const piece = transformSync(mode, input.subarray(start, boundary), options);
        parts.push(piece instanceof Uint8Array ? piece : new Uint8Array(piece));
        start = boundary;
      } catch {
        // Magic bytes occurred inside compressed payload; keep scanning.
      }
    }
    if (start === 0) throw error;
    const last = transformSync(mode, input.subarray(start), options);
    parts.push(last instanceof Uint8Array ? last : new Uint8Array(last));
    const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.byteLength;
    }
    return asBuffer(combined);
  }
  const firstBytes = first instanceof Uint8Array ? first : new Uint8Array(first);
  const consumed = computeConsumedSync(mode, options, input, firstBytes);
  if (consumed <= 0 || consumed >= input.byteLength) return asBuffer(firstBytes);
  const parts = [firstBytes];
  let remaining = input.subarray(consumed);
  while (remaining.byteLength > 0) {
    let memberOutput;
    try {
      const raw = transformSync(mode, remaining, options);
      memberOutput = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    } catch {
      break;
    }
    parts.push(memberOutput);
    const memberConsumed = computeConsumedSync(mode, options, remaining, memberOutput);
    if (memberConsumed <= 0) break;
    remaining = remaining.subarray(memberConsumed);
  }
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return asBuffer(combined);
}

function defaultStreamFinishFlush(mode) {
  return mode === "inflate" || mode === "inflateRaw" || mode === "gunzip" || mode === "unzip"
    ? constants.Z_SYNC_FLUSH
    : constants.Z_FINISH;
}

function combineBytes(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return combined;
}

function zstdFrameLength(input, start = 0) {
  if (input.byteLength - start < 4) return null;
  const magic = input[start] | (input[start + 1] << 8) | (input[start + 2] << 16) | (input[start + 3] << 24);
  if ((magic >>> 4) === 0x0184d2a5) {
    if (input.byteLength - start < 8) return null;
    const size = input[start + 4] | (input[start + 5] << 8) | (input[start + 6] << 16) | (input[start + 7] << 24);
    return input.byteLength - start >= 8 + (size >>> 0) ? 8 + (size >>> 0) : null;
  }
  if ((magic >>> 0) !== 0xfd2fb528) return -1;

  let offset = start + 4;
  if (offset >= input.byteLength) return null;
  const descriptor = input[offset++];
  if ((descriptor & 0x08) !== 0) return -1;
  const frameContentSizeFlag = descriptor >>> 6;
  const singleSegment = (descriptor & 0x20) !== 0;
  const checksum = (descriptor & 0x04) !== 0;
  const dictionaryIdSize = [0, 1, 2, 4][descriptor & 0x03];
  const frameContentSizeSize = frameContentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : frameContentSizeFlag === 1 ? 2 : frameContentSizeFlag === 2 ? 4 : 8;
  const remainingHeaderSize = (singleSegment ? 0 : 1) + dictionaryIdSize + frameContentSizeSize;
  if (input.byteLength - offset < remainingHeaderSize) return null;
  offset += remainingHeaderSize;

  while (true) {
    if (input.byteLength - offset < 3) return null;
    const header = input[offset] | (input[offset + 1] << 8) | (input[offset + 2] << 16);
    offset += 3;
    const lastBlock = (header & 1) !== 0;
    const blockType = (header >>> 1) & 0x03;
    const blockSize = header >>> 3;
    if (blockType === 3) return -1;
    const payloadSize = blockType === 1 ? 1 : blockSize;
    if (input.byteLength - offset < payloadSize) return null;
    offset += payloadSize;
    if (lastBlock) break;
  }

  if (checksum) {
    if (input.byteLength - offset < 4) return null;
    offset += 4;
  }
  return offset - start;
}

function decodeCompletedInput(mode, input, options) {
  const strictOptions = { ...options, finishFlush: constants.Z_FINISH };
  if (mode === "zstdDecompress") {
    const parts = [];
    let consumed = 0;
    while (consumed < input.byteLength) {
      const frameLength = zstdFrameLength(input, consumed);
      if (frameLength == null) return null;
      if (frameLength < 0) break;
      const output = transformSync(mode, input.subarray(consumed, consumed + frameLength), strictOptions);
      parts.push(output instanceof Uint8Array ? output : new Uint8Array(output));
      consumed += frameLength;
    }
    return parts.length === 0 ? null : { bytes: combineBytes(parts), consumed };
  }

  let output;
  try {
    output = transformSync(mode, input, strictOptions);
  } catch {
    return null;
  }
  const bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
  return {
    bytes,
    consumed: computeConsumedSync(mode, strictOptions, input, bytes),
  };
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

const decompressModes = new Set(["inflate", "inflateRaw", "gunzip", "unzip", "brotliDecompress", "zstdDecompress"]);

class Zlib extends Transform {
  constructor(mode, options = {}) {
    super();
    this._mode = mode;
    this._options = mode === "deflate" || mode === "deflateRaw" || mode === "gzip"
      ? validateZlibOptions(options)
      : options ?? {};
    this._chunks = [];
    this._inputBytes = 0;
    this._consumedBytes = null;
    this._finalInput = null;
    this._finalOutput = null;
    this._isDecompress = decompressModes.has(mode);
    this._completionScheduled = false;
    this._readableCompleted = false;
    this._emittedMember = false;
    this._brotliEncoder = mode === "brotliCompress" ? createBrotliEncoder(this._options) : null;
  }

  // Node's zlib streams expose bytesWritten as the number of input bytes the
  // engine consumed. For decompressors fed trailing garbage, that stops at
  // the end of the compressed stream, which we recover lazily by probing the
  // one-shot native transform (there is no incremental native handle yet).
  get bytesWritten() {
    if (!this._isDecompress) return this._inputBytes;
    if (this._consumedBytes !== null) return this._consumedBytes;
    if (this._finalInput === null) return this._inputBytes;
    this._consumedBytes = this._computeConsumed(this._finalInput, this._finalOutput);
    this._finalInput = null;
    this._finalOutput = null;
    return this._consumedBytes;
  }

  set bytesWritten(value) {
    this._inputBytes = value;
    this._consumedBytes = null;
    this._finalInput = null;
  }

  get bytesRead() {
    return this.bytesWritten;
  }

  set bytesRead(value) {
    this.bytesWritten = value;
  }

  _transformOptions() {
    return {
      finishFlush: defaultStreamFinishFlush(this._mode),
      ...this._options,
    };
  }

  _computeConsumed(input, fullOutput) {
    return computeConsumedSync(this._mode, this._transformOptions(), input, fullOutput);
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

  _peekChunks() {
    const inputLength = this._chunks.reduce((sum, item) => sum + item.byteLength, 0);
    const input = new Uint8Array(inputLength);
    let offset = 0;
    for (const chunkBytes of this._chunks) {
      input.set(chunkBytes, offset);
      offset += chunkBytes.byteLength;
    }
    return input;
  }

  _pushOutput(bytes) {
    if (bytes.byteLength === 0) return;
    const maxOutputLength = this._options.maxOutputLength ?? kMaxLengthLimit();
    if (bytes.byteLength > maxOutputLength) {
      const error = new RangeError(`Cannot create a Buffer larger than ${maxOutputLength} bytes`);
      error.code = "ERR_BUFFER_TOO_LARGE";
      throw error;
    }
    const chunkSize = Number(this._options.chunkSize) > 0 ? Number(this._options.chunkSize) : 16 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      this.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
    }
  }

  _tryCompleteDecompressor() {
    if (!this._isDecompress || this._readableCompleted || this._chunks.length === 0) return;
    const input = this._peekChunks();
    const completed = decodeCompletedInput(this._mode, input, this._transformOptions());
    if (completed === null) return;
    this._chunks = [];
    this._consumedBytes = completed.consumed;
    this._finalInput = null;
    this._finalOutput = null;
    this._pushOutput(completed.bytes);
    this._readableCompleted = true;
    this.push(null);
  }

  _emitBuffered() {
    if (this._readableCompleted) return false;
    if (this._mode === "zstdCompress" && this._emittedMember && this._chunks.length === 0) return false;
    // Compressors must emit a valid (possibly empty) stream even when no
    // input was ever written; decompressors with no input emit nothing.
    if (this._chunks.length === 0 && this._isDecompress) return false;
    const input = this._consumeChunks();
    let completed = null;
    if (this._mode === "zstdDecompress") {
      completed = decodeCompletedInput(this._mode, input, this._transformOptions());
    }
    const output = completed === null ? transformSync(this._mode, input, this._transformOptions()) : completed.bytes;
    let bytes = output instanceof Uint8Array ? output : new Uint8Array(output);
    if (this._isDecompress) {
      if (completed !== null) {
        this._finalInput = null;
        this._finalOutput = null;
        this._consumedBytes = completed.consumed;
      } else {
        this._finalInput = input;
        this._finalOutput = bytes;
        this._consumedBytes = null;
      }
      // gzip members and zstd frames concatenate; Node's decompressors keep
      // decoding subsequent members, so loop over the remaining input.
      if (this._mode === "gunzip" || this._mode === "unzip" || this._mode === "zstdDecompress") {
        let consumed = this._computeConsumed(input, bytes);
        if (consumed > 0 && consumed < input.byteLength) {
          const parts = [bytes];
          let remaining = input.subarray(consumed);
          let totalConsumed = consumed;
          while (remaining.byteLength > 0) {
            let memberOutput;
            try {
              const raw = transformSync(this._mode, remaining, this._transformOptions());
              memberOutput = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
            } catch {
              break;
            }
            parts.push(memberOutput);
            const memberConsumed = this._computeConsumed(remaining, memberOutput);
            if (memberConsumed <= 0) {
              totalConsumed += remaining.byteLength;
              break;
            }
            totalConsumed += memberConsumed;
            remaining = remaining.subarray(memberConsumed);
          }
          const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
          const combined = new Uint8Array(totalLength);
          let offset = 0;
          for (const part of parts) {
            combined.set(part, offset);
            offset += part.byteLength;
          }
          bytes = combined;
          this._finalInput = null;
          this._finalOutput = null;
          this._consumedBytes = totalConsumed;
        }
      }
    }
    this._pushOutput(bytes);
    if (this._mode === "zstdCompress") this._emittedMember = true;
    return true;
  }

  write(chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") {
      callback = encoding;
      encoding = undefined;
    }
    const bytes = bytesFromData(typeof chunk === "string" && encoding ? globalThis.Buffer?.from(chunk, encoding) ?? chunk : chunk);
    this._inputBytes += bytes.byteLength;
    if (this._brotliEncoder !== null) {
      try {
        const output = writeBrotliEncoder(this._brotliEncoder, bytes, constants.BROTLI_OPERATION_PROCESS);
        this._pushOutput(output);
      } catch (error) {
        callback?.(error);
        this.emit("error", error);
        this.destroy();
        return false;
      }
    } else if (this._mode === "zstdCompress") {
      try {
        const output = transformSync(this._mode, bytes, this._transformOptions());
        this._pushOutput(output instanceof Uint8Array ? output : new Uint8Array(output));
        this._emittedMember = true;
      } catch (error) {
        callback?.(error);
        this.emit("error", error);
        this.destroy();
        return false;
      }
    } else {
      this._chunks.push(bytes);
    }
    if (this._isDecompress && !this._completionScheduled && !this._readableCompleted) {
      this._completionScheduled = true;
      queueMicrotask(() => {
        this._completionScheduled = false;
        try {
          this._tryCompleteDecompressor();
        } catch (error) {
          this.emit("error", error);
          this.destroy();
        }
      });
    }
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
      if (this._brotliEncoder !== null) {
        const output = writeBrotliEncoder(
          this._brotliEncoder,
          new Uint8Array(0),
          constants.BROTLI_OPERATION_FINISH,
        );
        this._pushOutput(output);
        this._closeBrotliEncoder();
      } else {
        this._emitBuffered();
      }
      if (!this._readableCompleted) {
        this._readableCompleted = true;
        this.push(null);
      }
      // Our write()/end() bypass Writable's state machine, so mark the
      // writable side complete manually; eos()/finished() reads these flags
      // when 'close' arrives to distinguish completion from premature close.
      const writableState = this._writableState;
      if (writableState) {
        writableState.ending = true;
        writableState.ended = true;
        writableState.finished = true;
      }
      this.emit("finish");
      // Node's zlib streams autoDestroy once both sides complete, emitting
      // 'close'; finished()/eos() waits for it (willEmitClose), so destroy
      // after the readable side has fully drained.
      this.once("end", () => this.destroy());
      callback?.();
    } catch (error) {
      this.emit("error", error);
      this.destroy();
      callback?.(error);
    }
  }

  flush(kind = undefined, callback = undefined) {
    if (typeof kind === "function") {
      callback = kind;
      kind = undefined;
    }
    if (this._brotliEncoder !== null) {
      try {
        const operation = kind === undefined ? constants.BROTLI_OPERATION_FLUSH : Number(kind);
        const output = writeBrotliEncoder(this._brotliEncoder, new Uint8Array(0), operation);
        this._pushOutput(output);
      } catch (error) {
        if (callback) {
          queueMicrotask(() => callback(error));
          return;
        }
        this.emit("error", error);
        return;
      }
      if (callback) queueMicrotask(callback);
      return;
    }
    void kind;
    // COTTONTAIL-COMPAT: node:zlib flush - no incremental native handle yet.
    // gzip members and zstd frames concatenate into valid streams, so those
    // modes can emit a complete member per flush (Node-visible behavior);
    // deflate/brotli output cannot be segmented safely, so they keep
    // buffering until end().
    if (this._mode === "gzip" || this._mode === "zstdCompress") {
      try {
        this._emitBuffered();
      } catch (error) {
        if (callback) {
          queueMicrotask(() => callback(error));
          return;
        }
        this.emit("error", error);
        return;
      }
    }
    if (callback) queueMicrotask(callback);
  }

  close(callback = undefined) {
    this._closeBrotliEncoder();
    callback?.();
    this.emit("close");
  }

  _closeBrotliEncoder() {
    if (this._brotliEncoder === null) return;
    cottontail.brotliEncoderClose?.(this._brotliEncoder);
    this._brotliEncoder = null;
  }

  _destroy(error, callback) {
    this._closeBrotliEncoder();
    callback(error);
  }

  reset() {
    this._closeBrotliEncoder();
    this._chunks = [];
    this._inputBytes = 0;
    this._consumedBytes = null;
    this._finalInput = null;
    this._finalOutput = null;
    this._completionScheduled = false;
    this._readableCompleted = false;
    this._emittedMember = false;
    this._brotliEncoder = this._mode === "brotliCompress" ? createBrotliEncoder(this._options) : null;
  }
}

function kMaxLengthLimit() {
  const limit = bufferModule.kMaxLength;
  return typeof limit === "number" && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
}

class Brotli extends Zlib {}
class Zstd extends Zlib {}

function makeCallableZlibConstructor(name, Parent, mode) {
  const Constructor = {
    [name]: function(options = {}) {
      return Reflect.construct(Parent, [mode, options], new.target ?? Constructor);
    },
  }[name];
  Object.setPrototypeOf(Constructor, Parent);
  Object.setPrototypeOf(Constructor.prototype, Parent.prototype);
  return Constructor;
}

export const Deflate = makeCallableZlibConstructor("Deflate", Zlib, "deflate");
export const DeflateRaw = makeCallableZlibConstructor("DeflateRaw", Zlib, "deflateRaw");
export const Gzip = makeCallableZlibConstructor("Gzip", Zlib, "gzip");
export const Gunzip = makeCallableZlibConstructor("Gunzip", Zlib, "gunzip");
export const Inflate = makeCallableZlibConstructor("Inflate", Zlib, "inflate");
export const InflateRaw = makeCallableZlibConstructor("InflateRaw", Zlib, "inflateRaw");
export const Unzip = makeCallableZlibConstructor("Unzip", Zlib, "unzip");
export const BrotliCompress = makeCallableZlibConstructor("BrotliCompress", Brotli, "brotliCompress");
export const BrotliDecompress = makeCallableZlibConstructor("BrotliDecompress", Brotli, "brotliDecompress");
export class ZstdCompress extends Zstd { constructor(options = {}) { super("zstdCompress", options); } }
export class ZstdDecompress extends Zstd { constructor(options = {}) { super("zstdDecompress", options); } }

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
export function gunzipSync(data, options = undefined) { return decompressMembersSync("gunzip", data, options); }
export function unzipSync(data, options = undefined) { return decompressMembersSync("unzip", data, options); }
export function brotliCompressSync(data, options = undefined) { return transformSync("brotliCompress", data, options); }
export function brotliDecompressSync(data, options = undefined) {
  try {
    return transformSync("brotliDecompress", data, options);
  } catch (error) {
    // One-byte empty-stream encodings (0x3b: Node/libbrotli's empty output;
    // 0x06: an empty last metablock) are valid brotli, but the native decoder
    // rejects them. Node decodes both to an empty buffer.
    const input = bytesFromData(data);
    if (input.byteLength === 1 && (input[0] === 0x3b || input[0] === 0x06)) return asBuffer(new Uint8Array(0));
    throw error;
  }
}
const ZSTD_MIN_LEVEL = 1;
const ZSTD_MAX_LEVEL = 22;

function validateZstdCompressOptions(options) {
  if (options && typeof options === "object" && options.level != null) {
    const level = Number(options.level);
    if (!Number.isFinite(level) || level < ZSTD_MIN_LEVEL || level > ZSTD_MAX_LEVEL) {
      throw new RangeError(`Compression level must be between ${ZSTD_MIN_LEVEL} and ${ZSTD_MAX_LEVEL}`);
    }
  }
}

export function zstdCompressSync(data, options = undefined) {
  validateZstdCompressOptions(options);
  return transformSync("zstdCompress", data, options);
}
export function zstdDecompressSync(data, options = undefined) { return decompressMembersSync("zstdDecompress", data, options); }

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

// COTTONTAIL-COMPAT: node:zlib native stream state - incremental zlib flush semantics and one-shot native allocation reuse are still required for Bun's RSS leak thresholds.

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
