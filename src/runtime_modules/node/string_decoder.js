import { Buffer } from "./buffer.js";

// Port of Node.js string_decoder semantics (lib/string_decoder.js).

function normalizeEncoding(encoding) {
  const lowered = String(encoding === undefined || encoding === null ? "utf8" : encoding).toLowerCase();
  switch (lowered) {
    case "utf8":
    case "utf-8":
      return "utf8";
    case "ucs2":
    case "ucs-2":
    case "utf16le":
    case "utf-16le":
      return "utf16le";
    case "latin1":
    case "binary":
      return "latin1";
    case "base64":
      return "base64";
    case "base64url":
      return "base64url";
    case "ascii":
      return "ascii";
    case "hex":
      return "hex";
    default: {
      const err = new TypeError(`Unknown encoding: ${encoding}`);
      err.code = "ERR_UNKNOWN_ENCODING";
      throw err;
    }
  }
}

function toBufferView(input) {
  if (Buffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  const err = new TypeError(
    'The "buf" argument must be an instance of Buffer, TypedArray, or DataView. Received ' +
      (input === null ? "null" : `type ${typeof input}`),
  );
  err.code = "ERR_INVALID_ARG_TYPE";
  throw err;
}

// Returns the byte length of a UTF-8 sequence for the given lead byte:
// 0 for ASCII, 2/3/4 for multi-byte leads, -1 for continuation bytes and
// -2 for invalid bytes (0xf8-0xff).
function utf8CheckByte(byte) {
  if (byte <= 0x7f) return 0;
  else if (byte >> 5 === 0x06) return 2;
  else if (byte >> 4 === 0x0e) return 3;
  else if (byte >> 3 === 0x1e) return 4;
  return byte >> 6 === 0x02 ? -1 : -2;
}

// Checks at most 3 bytes at the end of a Buffer to see if there is an
// incomplete multi-byte UTF-8 character. Sets this.lastNeed if so.
function utf8CheckIncomplete(self, buf, i) {
  let j = buf.length - 1;
  if (j < i) return 0;
  let nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 1;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) self.lastNeed = nb - 2;
    return nb;
  }
  if (--j < i || nb === -2) return 0;
  nb = utf8CheckByte(buf[j]);
  if (nb >= 0) {
    if (nb > 0) {
      if (nb === 2) nb = 0;
      else self.lastNeed = nb - 3;
    }
    return nb;
  }
  return 0;
}

// Validates continuation bytes for a (partially buffered) multi-byte
// character. Returns a replacement character when the input is invalid.
function utf8CheckExtraBytes(self, buf) {
  if ((buf[0] & 0xc0) !== 0x80) {
    self.lastNeed = 0;
    return "�";
  }
  if (self.lastNeed > 1 && buf.length > 1) {
    if ((buf[1] & 0xc0) !== 0x80) {
      self.lastNeed = 1;
      return "�";
    }
    if (self.lastNeed > 2 && buf.length > 2) {
      if ((buf[2] & 0xc0) !== 0x80) {
        self.lastNeed = 2;
        return "�";
      }
    }
  }
  return undefined;
}

// Attempts to complete a multi-byte UTF-8 character using bytes from a Buffer.
function utf8FillLast(buf) {
  const p = this.lastTotal - this.lastNeed;
  const r = utf8CheckExtraBytes(this, buf);
  if (r !== undefined) return r;
  if (this.lastNeed <= buf.length) {
    this.lastChar.set(buf.subarray(0, this.lastNeed), p);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  this.lastChar.set(buf, p);
  this.lastNeed -= buf.length;
  return undefined;
}

function utf8Text(buf, i) {
  const total = utf8CheckIncomplete(this, buf, i);
  if (!this.lastNeed) return buf.toString("utf8", i);
  this.lastTotal = total;
  const end = buf.length - (total - this.lastNeed);
  this.lastChar.set(buf.subarray(end), 0);
  return buf.toString("utf8", i, end);
}

// For UTF-8, a replacement character is added for each buffered byte of a
// (partial) character at the end of the Buffer, matching Node.js which
// decodes the leftover bytes with WHATWG replacement semantics.
function utf8End(buf) {
  const r = buf && buf.length ? this.write(buf) : "";
  if (this.lastNeed) {
    const buffered = this.lastTotal - this.lastNeed;
    this.lastNeed = 0;
    this.lastTotal = 0;
    return r + this.lastChar.toString("utf8", 0, buffered);
  }
  return r;
}

function utf8Write(buf) {
  if (typeof buf === "string") return buf;
  buf = toBufferView(buf);
  if (buf.length === 0) return "";
  let r;
  let i;
  if (this.lastNeed) {
    r = this.fillLast(buf);
    if (r === undefined) return "";
    i = this.lastNeed;
    this.lastNeed = 0;
  } else {
    i = 0;
  }
  if (i < buf.length) return r ? r + this.text(buf, i) : this.text(buf, i);
  return r || "";
}

function utf16Text(buf, i) {
  if ((buf.length - i) % 2 === 0) {
    const r = buf.toString("utf16le", i);
    if (r) {
      const c = r.charCodeAt(r.length - 1);
      if (c >= 0xd800 && c <= 0xdbff) {
        this.lastNeed = 2;
        this.lastTotal = 4;
        this.lastChar[0] = buf[buf.length - 2];
        this.lastChar[1] = buf[buf.length - 1];
        return r.slice(0, -1);
      }
    }
    return r;
  }
  this.lastNeed = 1;
  this.lastTotal = 2;
  this.lastChar[0] = buf[buf.length - 1];
  return buf.toString("utf16le", i, buf.length - 1);
}

// For UTF-16LE we do not explicitly append special replacement characters if
// we end on a partial character; we simply let v8 handle that.
function utf16End(buf) {
  const r = buf && buf.length ? this.write(buf) : "";
  if (this.lastNeed) {
    const end = this.lastTotal - this.lastNeed;
    this.lastNeed = 0;
    this.lastTotal = 0;
    return r + this.lastChar.toString("utf16le", 0, end);
  }
  return r;
}

function base64Text(buf, i) {
  const n = (buf.length - i) % 3;
  if (n === 0) return buf.toString(this.encoding, i);
  this.lastNeed = 3 - n;
  this.lastTotal = 3;
  if (n === 1) {
    this.lastChar[0] = buf[buf.length - 1];
  } else {
    this.lastChar[0] = buf[buf.length - 2];
    this.lastChar[1] = buf[buf.length - 1];
  }
  return buf.toString(this.encoding, i, buf.length - n);
}

function base64End(buf) {
  const r = buf && buf.length ? this.write(buf) : "";
  if (this.lastNeed) {
    const partial = 3 - this.lastNeed;
    this.lastNeed = 0;
    this.lastTotal = 0;
    return r + this.lastChar.toString(this.encoding, 0, partial);
  }
  return r;
}

// Pass bytes on through for single-byte encodings (e.g. ascii, latin1, hex).
function simpleWrite(buf) {
  if (typeof buf === "string") return buf;
  buf = toBufferView(buf);
  return buf.toString(this.encoding);
}

function simpleEnd(buf) {
  return buf && buf.length ? this.write(buf) : "";
}

export function StringDecoder(encoding) {
  if (!(this instanceof StringDecoder) && !(this && typeof this === "object")) {
    return new StringDecoder(encoding);
  }
  this.encoding = normalizeEncoding(encoding);
  let nb;
  switch (this.encoding) {
    case "utf16le":
      this.text = utf16Text;
      this.end = utf16End;
      nb = 4;
      break;
    case "utf8":
      this.fillLast = utf8FillLast;
      nb = 4;
      break;
    case "base64":
    case "base64url":
      this.text = base64Text;
      this.end = base64End;
      nb = 3;
      break;
    default:
      this.write = simpleWrite;
      this.end = simpleEnd;
      nb = 4;
      break;
  }
  this.lastNeed = 0;
  this.lastTotal = 0;
  this.lastChar = Buffer.allocUnsafe(nb);
}

StringDecoder.prototype.write = utf8Write;

StringDecoder.prototype.end = utf8End;

StringDecoder.prototype.text = utf8Text;

StringDecoder.prototype.fillLast = function fillLast(buf) {
  const p = this.lastTotal - this.lastNeed;
  if (this.lastNeed <= buf.length) {
    this.lastChar.set(buf.subarray(0, this.lastNeed), p);
    return this.lastChar.toString(this.encoding, 0, this.lastTotal);
  }
  this.lastChar.set(buf, p);
  this.lastNeed -= buf.length;
  return undefined;
};

export default { StringDecoder };
