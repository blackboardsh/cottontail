// WHATWG Encoding Standard implementation: TextEncoder + TextDecoder.
// https://encoding.spec.whatwg.org/
//
// Streaming UTF-8/UTF-16 state remains here. Labels and bulk stateless
// conversions use the native encoding bindings.

const g = globalThis;

const ENCODING_NAMES = Object.freeze([
  "utf-8", "ibm866", "iso-8859-2", "iso-8859-3", "iso-8859-4",
  "iso-8859-5", "iso-8859-6", "iso-8859-7", "iso-8859-8",
  "iso-8859-8-i", "iso-8859-10", "iso-8859-13", "iso-8859-14",
  "iso-8859-15", "iso-8859-16", "koi8-r", "koi8-u", "macintosh",
  "windows-874", "windows-1250", "windows-1251", "windows-1252",
  "windows-1253", "windows-1254", "windows-1255", "windows-1256",
  "windows-1257", "windows-1258", "x-mac-cyrillic", "gbk", "gb18030",
  "big5", "euc-jp", "iso-2022-jp", "shift_jis", "euc-kr", "replacement",
  "utf-16be", "utf-16le", "x-user-defined",
]);

function lookupEncoding(label) {
  const encoding = g.cottontail?.textEncodingLookup?.(String(label));
  if (!Number.isInteger(encoding) || encoding < 0 || encoding >= ENCODING_NAMES.length) {
    const error = new RangeError(`ERR_ENCODING_NOT_SUPPORTED: The "${label}" encoding is not supported`);
    error.code = "ERR_ENCODING_NOT_SUPPORTED";
    throw error;
  }
  return encoding;
}

function nativeTextDecode(encoding, bytes, fatal, stripBOM) {
  const decode = g.cottontail?.textDecode;
  if (typeof decode !== "function") return null;
  return decode(encoding, bytes, fatal, stripBOM);
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const EMPTY_BYTES = new Uint8Array(0);

function makeDecodeError(encoding) {
  const error = new TypeError(
    `The encoded data was not valid for encoding ${encoding}`,
  );
  error.code = "ERR_ENCODING_INVALID_ENCODED_DATA";
  return error;
}

function coerceDecodeInput(input, encoding) {
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && input instanceof SharedArrayBuffer)) {
    try {
      return new Uint8Array(input);
    } catch {
      return EMPTY_BYTES; // detached
    }
  }
  if (ArrayBuffer.isView(input)) {
    try {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    } catch {
      return EMPTY_BYTES; // detached
    }
  }
  const error = new TypeError(
    `The "input" argument must be an instance of ArrayBuffer or ArrayBufferView. Received ${input === null ? "null" : typeof input}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
}

// TextDecoderOptions flag conversion. Bun rejects values whose boolean-ness is
// ambiguous (objects, numbers other than 0/1); everything else coerces.
function coerceDecoderFlag(value, name) {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 0) return false;
    if (value === 1) return true;
    throw new TypeError(`TextDecoder option "${name}" must be a boolean`);
  }
  if (typeof value === "object" || typeof value === "function") {
    throw new TypeError(`TextDecoder option "${name}" must be a boolean`);
  }
  return Boolean(value);
}

function codesToString(codes) {
  const length = codes.length;
  if (length === 0) return "";
  if (length <= 8192) return String.fromCharCode.apply(null, codes);
  let result = "";
  for (let i = 0; i < length; i += 8192) {
    result += String.fromCharCode.apply(null, codes.slice(i, i + 8192));
  }
  return result;
}

function codesToUtf16String(codes) {
  if (codes.length === 0) return "";
  if (typeof g.cottontail?.stringFromUtf16 === "function") {
    return g.cottontail.stringFromUtf16(new Uint16Array(codes));
  }
  return codesToString(codes);
}

function concatChunks(chunks) {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// TextDecoder
// ---------------------------------------------------------------------------

const KIND_UTF8 = 0;
const KIND_UTF16LE = 1;
const KIND_UTF16BE = 2;
const KIND_SINGLE_BYTE = 3;
const KIND_X_USER_DEFINED = 4;
const KIND_REPLACEMENT = 5;
const KIND_ICU = 6;

function encodingKind(encoding) {
  if (encoding === 0) return KIND_UTF8;
  if (encoding === 38) return KIND_UTF16LE;
  if (encoding === 37) return KIND_UTF16BE;
  if (encoding === 39) return KIND_X_USER_DEFINED;
  if (encoding === 36) return KIND_REPLACEMENT;
  if (encoding >= 29 && encoding <= 35) return KIND_ICU;
  return KIND_SINGLE_BYTE;
}

function resetStreamState(state) {
  state.bomSeen = false;
  state.u8cp = 0;
  state.u8needed = 0;
  state.u8seen = 0;
  state.u8lower = 0x80;
  state.u8upper = 0xbf;
  state.leadByte = -1;
  state.leadSurrogate = 0;
  state.replacementErrored = false;
  state.pending = null;
}

class TextDecoder {
  constructor(label = "utf-8", options = undefined) {
    const encodingId = lookupEncoding(label === undefined ? "utf-8" : label);
    const name = ENCODING_NAMES[encodingId];
    let fatal = false;
    let ignoreBOM = false;
    if (options !== undefined && options !== null) {
      fatal = coerceDecoderFlag(options.fatal, "fatal");
      ignoreBOM = coerceDecoderFlag(options.ignoreBOM, "ignoreBOM");
    }
    this.encoding = name;
    this.fatal = fatal;
    this.ignoreBOM = ignoreBOM;
    const state = {
      encodingId,
      kind: encodingKind(encodingId),
      doNotFlush: false,
    };
    resetStreamState(state);
    Object.defineProperty(this, "_state", { value: state, writable: true, enumerable: false, configurable: true });
  }

  decode(input = undefined, options = undefined) {
    const state = this._state;
    const wasStreaming = state.doNotFlush;
    if (!wasStreaming) resetStreamState(state);
    const bytes = input === undefined ? EMPTY_BYTES : coerceDecodeInput(input, this.encoding);
    let stream = false;
    if (options !== undefined && options !== null) stream = Boolean(options.stream);
    state.doNotFlush = stream;
    const flush = !stream;

    switch (state.kind) {
      case KIND_UTF8:
        if (flush && !wasStreaming && bytes.length >= 128) {
          return this.#decodeNative(state, bytes, true);
        }
        return this.#finishText(state, this.#decodeUTF8(state, bytes, flush), true);
      case KIND_UTF16LE:
      case KIND_UTF16BE:
        if (flush && !wasStreaming && bytes.length >= 64) {
          return this.#decodeNative(state, bytes, true);
        }
        return this.#finishText(state, this.#decodeUTF16(state, bytes, flush, state.kind === KIND_UTF16BE), true, true);
      case KIND_SINGLE_BYTE:
        return this.#decodeNative(state, bytes, false);
      case KIND_X_USER_DEFINED:
        return this.#decodeNative(state, bytes, false);
      case KIND_REPLACEMENT:
        return this.#decodeReplacement(state, bytes);
      case KIND_ICU:
        return this.#decodeICU(state, bytes, flush);
    }
    return "";
  }

  #decodeNative(state, bytes, stripBOM) {
    try {
      const decoded = nativeTextDecode(state.encodingId, bytes, this.fatal, stripBOM && !this.ignoreBOM);
      if (decoded !== null) return decoded;
    } catch {
      throw makeDecodeError(this.encoding);
    }
    throw new Error(`TextDecoder: the "${this.encoding}" encoding requires native converter support, which is unavailable in this build`);
  }

  #finishText(state, result, checkBOM, forceUtf16 = false) {
    // Fast paths return strings directly (BOM already accounted for).
    if (typeof result === "string") return result;
    if (checkBOM && !this.ignoreBOM && !state.bomSeen && result.length > 0) {
      state.bomSeen = true;
      if (result[0] === 0xfeff) result.shift();
    } else if (result.length > 0) {
      state.bomSeen = true;
    }
    return forceUtf16 ? codesToUtf16String(result) : codesToString(result);
  }

  #decodeUTF8(state, bytes, flush) {
    const length = bytes.length;
    // Fast path: no partial sequence pending and pure ASCII input.
    if (state.u8needed === 0) {
      let ascii = true;
      for (let i = 0; i < length; i++) {
        if (bytes[i] > 0x7f) {
          ascii = false;
          break;
        }
      }
      if (ascii) {
        if (length > 0) state.bomSeen = true;
        return codesToString(bytes);
      }
    }
    const out = [];
    let cp = state.u8cp;
    let needed = state.u8needed;
    let seen = state.u8seen;
    let lower = state.u8lower;
    let upper = state.u8upper;
    const fatal = this.fatal;
    for (let i = 0; i < length; i++) {
      const b = bytes[i];
      if (needed === 0) {
        if (b <= 0x7f) {
          out.push(b);
          continue;
        }
        if (b >= 0xc2 && b <= 0xdf) {
          needed = 1;
          cp = b & 0x1f;
        } else if (b >= 0xe0 && b <= 0xef) {
          if (b === 0xe0) lower = 0xa0;
          if (b === 0xed) upper = 0x9f;
          needed = 2;
          cp = b & 0xf;
        } else if (b >= 0xf0 && b <= 0xf4) {
          if (b === 0xf0) lower = 0x90;
          if (b === 0xf4) upper = 0x8f;
          needed = 3;
          cp = b & 0x7;
        } else {
          if (fatal) {
            this.#resetUTF8(state);
            throw makeDecodeError(this.encoding);
          }
          out.push(0xfffd);
        }
        continue;
      }
      if (b < lower || b > upper) {
        cp = 0;
        needed = 0;
        seen = 0;
        lower = 0x80;
        upper = 0xbf;
        if (fatal) {
          this.#resetUTF8(state);
          throw makeDecodeError(this.encoding);
        }
        out.push(0xfffd);
        i -= 1; // prepend byte to the stream and reprocess it
        continue;
      }
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (b & 0x3f);
      seen += 1;
      if (seen === needed) {
        if (cp <= 0xffff) {
          out.push(cp);
        } else {
          const v = cp - 0x10000;
          out.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
        }
        cp = 0;
        needed = 0;
        seen = 0;
      }
    }
    if (flush && needed !== 0) {
      cp = 0;
      needed = 0;
      seen = 0;
      lower = 0x80;
      upper = 0xbf;
      if (fatal) {
        this.#resetUTF8(state);
        throw makeDecodeError(this.encoding);
      }
      out.push(0xfffd);
    }
    state.u8cp = cp;
    state.u8needed = needed;
    state.u8seen = seen;
    state.u8lower = lower;
    state.u8upper = upper;
    return out;
  }

  #resetUTF8(state) {
    state.u8cp = 0;
    state.u8needed = 0;
    state.u8seen = 0;
    state.u8lower = 0x80;
    state.u8upper = 0xbf;
  }

  #decodeUTF16(state, bytes, flush, bigEndian) {
    const out = [];
    let leadByte = state.leadByte;
    let leadSurrogate = state.leadSurrogate;
    const fatal = this.fatal;
    const fail = () => {
      state.leadByte = -1;
      state.leadSurrogate = 0;
      throw makeDecodeError(this.encoding);
    };
    const length = bytes.length;
    for (let i = 0; i < length; i++) {
      const b = bytes[i];
      if (leadByte < 0) {
        leadByte = b;
        continue;
      }
      let unit = bigEndian ? (leadByte << 8) | b : leadByte | (b << 8);
      leadByte = -1;
      if (leadSurrogate !== 0) {
        if (unit >= 0xdc00 && unit <= 0xdfff) {
          out.push(leadSurrogate, unit);
          leadSurrogate = 0;
          continue;
        }
        leadSurrogate = 0;
        if (fatal) fail();
        out.push(0xfffd);
        // Reprocess the current unit below.
      }
      if (unit >= 0xd800 && unit <= 0xdbff) {
        leadSurrogate = unit;
        continue;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        if (fatal) fail();
        out.push(0xfffd);
        continue;
      }
      out.push(unit);
    }
    if (flush && (leadByte >= 0 || leadSurrogate !== 0)) {
      leadByte = -1;
      leadSurrogate = 0;
      if (fatal) fail();
      out.push(0xfffd);
    }
    state.leadByte = leadByte;
    state.leadSurrogate = leadSurrogate;
    return out;
  }

  #decodeReplacement(state, bytes) {
    if (bytes.length === 0 || state.replacementErrored) return "";
    state.replacementErrored = true;
    if (this.fatal) throw makeDecodeError(this.encoding);
    return "�";
  }

  #decodeICU(state, bytes, flush) {
    if (bytes.length > 0) {
      if (state.pending === null) state.pending = [];
      state.pending.push(Uint8Array.prototype.slice.call(bytes));
    }
    if (!flush) return "";
    const chunks = state.pending;
    state.pending = null;
    if (chunks === null) return "";
    const total = concatChunks(chunks);
    if (total.length === 0) return "";
    let decoded;
    try {
      decoded = nativeTextDecode(state.encodingId, total, this.fatal, false);
    } catch {
      throw makeDecodeError(this.encoding);
    }
    if (decoded === null) {
      throw new Error(`TextDecoder: the "${this.encoding}" encoding requires ICU converter support, which is unavailable in this build`);
    }
    return decoded;
  }

  get [Symbol.toStringTag]() {
    return "TextDecoder";
  }
}

// ---------------------------------------------------------------------------
// TextEncoder
// ---------------------------------------------------------------------------

function utf8EncodeString(text) {
  const length = text.length;
  const out = new Uint8Array(length * 3);
  let w = 0;
  for (let i = 0; i < length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out[w++] = c;
      continue;
    }
    if (c < 0x800) {
      out[w++] = 0xc0 | (c >> 6);
      out[w++] = 0x80 | (c & 0x3f);
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
        out[w++] = 0xf0 | (cp >> 18);
        out[w++] = 0x80 | ((cp >> 12) & 0x3f);
        out[w++] = 0x80 | ((cp >> 6) & 0x3f);
        out[w++] = 0x80 | (cp & 0x3f);
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
    out[w++] = 0xe0 | (c >> 12);
    out[w++] = 0x80 | ((c >> 6) & 0x3f);
    out[w++] = 0x80 | (c & 0x3f);
  }
  return out.slice(0, w);
}

function shouldUseNativeTextEncoder(text) {
  const length = text.length;
  if (length < 1024) return false;

  const sampleWidth = 64;
  const lastStart = Math.max(0, length - sampleWidth);
  for (let sample = 0; sample < 5; sample++) {
    const center = Math.floor(lastStart * sample / 4);
    const end = Math.min(length, center + sampleWidth);
    for (let index = center; index < end; index++) {
      if (text.charCodeAt(index) > 0x7f) return false;
    }
  }
  return true;
}

class TextEncoder {
  constructor() {
    // No options per spec.
  }

  get encoding() {
    return "utf-8";
  }

  encode(input = "") {
    if (input === undefined) return new Uint8Array(0);
    const text = String(input);
    const encode = g.cottontail?.textEncode;
    if (typeof encode === "function" && shouldUseNativeTextEncoder(text)) return encode(text);
    return utf8EncodeString(text);
  }

  encodeInto(source, destination) {
    // Accept Uint8Array from any realm (e.g. vm contexts), not just this one.
    if (!(destination instanceof Uint8Array) && destination?.[Symbol.toStringTag] !== "Uint8Array") {
      const error = new TypeError('The "destination" argument must be an instance of Uint8Array');
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    const text = String(source);
    const capacity = destination.length;
    const length = text.length;
    let read = 0;
    let written = 0;
    for (let i = 0; i < length; i++) {
      const c = text.charCodeAt(i);
      let cp = c;
      let units = 1;
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < length ? text.charCodeAt(i + 1) : -1;
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = 0x10000 + ((c - 0xd800) << 10) + (next - 0xdc00);
          units = 2;
        } else {
          cp = 0xfffd;
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        cp = 0xfffd;
      }
      let size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (written + size > capacity) {
        if (units === 2) {
          // Not enough room for the full pair: fall back to a replacement
          // character for the lead surrogate alone (matches Bun).
          cp = 0xfffd;
          units = 1;
          size = 3;
          if (written + size <= capacity) {
            destination[written] = 0xe0 | (cp >> 12);
            destination[written + 1] = 0x80 | ((cp >> 6) & 0x3f);
            destination[written + 2] = 0x80 | (cp & 0x3f);
            written += 3;
            read += 1;
            continue;
          }
        }
        break;
      }
      if (cp < 0x80) {
        destination[written++] = cp;
      } else if (cp < 0x800) {
        destination[written++] = 0xc0 | (cp >> 6);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else if (cp < 0x10000) {
        destination[written++] = 0xe0 | (cp >> 12);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      } else {
        destination[written++] = 0xf0 | (cp >> 18);
        destination[written++] = 0x80 | ((cp >> 12) & 0x3f);
        destination[written++] = 0x80 | ((cp >> 6) & 0x3f);
        destination[written++] = 0x80 | (cp & 0x3f);
      }
      read += units;
      if (units === 2) i += 1;
    }
    return { read, written };
  }

  get [Symbol.toStringTag]() {
    return "TextEncoder";
  }
}

g.TextEncoder = TextEncoder;
g.TextDecoder = TextDecoder;

export { TextEncoder, TextDecoder };
