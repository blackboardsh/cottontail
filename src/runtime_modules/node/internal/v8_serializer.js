import { Buffer } from "../buffer.js";

const wireFormatVersion = 1;
const wireMagic = Uint8Array.of(0x43, 0x54, 0x56, 0x38); // "CTV8"
const maxUint32 = 0xffffffff;
const objectToString = Object.prototype.toString;
const hasOwn = Object.prototype.hasOwnProperty;
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
const storageBunFileBrand = Symbol.for("cottontail.bunJSCStorageBunFile");
const structuredCloneHook = Symbol.for("cottontail.structuredClone");

const tags = Object.freeze({
  undefined: 0x00,
  null: 0x01,
  false: 0x02,
  true: 0x03,
  int32: 0x04,
  double: 0x05,
  bigint: 0x06,
  string: 0x07,
  reference: 0x08,
  object: 0x20,
  array: 0x21,
  date: 0x22,
  regexp: 0x23,
  arrayBuffer: 0x24,
  sharedArrayBuffer: 0x25,
  arrayBufferView: 0x26,
  map: 0x27,
  set: 0x28,
  error: 0x29,
  boxedBoolean: 0x2a,
  boxedNumber: 0x2b,
  boxedString: 0x2c,
  boxedBigInt: 0x2d,
  blob: 0x2e,
  file: 0x2f,
  storageBunFile: 0x30,
  hostObject: 0x31,
  transferredArrayBuffer: 0x32,
});

const viewTypes = Object.freeze({
  Int8Array: 1,
  Uint8Array: 2,
  Uint8ClampedArray: 3,
  Int16Array: 4,
  Uint16Array: 5,
  Int32Array: 6,
  Uint32Array: 7,
  Float32Array: 8,
  Float64Array: 9,
  BigInt64Array: 10,
  BigUint64Array: 11,
  DataView: 12,
  Buffer: 13,
  Float16Array: 14,
});

const errorTypes = Object.freeze({
  Error: 0,
  EvalError: 1,
  RangeError: 2,
  ReferenceError: 3,
  SyntaxError: 4,
  TypeError: 5,
  URIError: 6,
  AggregateError: 7,
});

function nodeTypeError(message) {
  const error = new TypeError(message);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function bufferTypeError(name) {
  return nodeTypeError(`${name} must be a TypedArray or a DataView`);
}

function cloneReadError(header = false) {
  return new Error(header
    ? "Unable to deserialize Cottontail cloned data due to an invalid or unsupported version."
    : "Unable to deserialize Cottontail cloned data.");
}

function byteView(value, name, allowArrayBuffer = false) {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (allowArrayBuffer && isArrayBufferObject(value)) return new Uint8Array(value);
  if (allowArrayBuffer && isSharedArrayBufferObject(value)) return new Uint8Array(value);
  throw bufferTypeError(name);
}

function isArrayBufferObject(value) {
  if (value == null || isSharedArrayBufferObject(value)) return false;
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}

function isSharedArrayBufferObject(value) {
  if (typeof SharedArrayBuffer !== "function" || value == null) return false;
  try {
    if (globalThis.__cottontailSharedBufferRegistry?.has(value)) return true;
  } catch {}
  const getter = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")?.get;
  if (typeof getter !== "function") {
    try {
      return value instanceof SharedArrayBuffer;
    } catch {
      return false;
    }
  }
  try {
    getter.call(value);
    return true;
  } catch {
    return false;
  }
}

function isBunFile(value) {
  return value?.[storageBunFileBrand] === true ||
    (typeof value?.exists === "function" && typeof value?.writer === "function");
}

function isBlockList(value) {
  return value?.constructor?.name === "BlockList" &&
    typeof value?.addAddress === "function" &&
    typeof value?.check === "function" &&
    typeof value?.[structuredCloneHook] === "function";
}

function bunFileBytes(value) {
  if (value?._bytes instanceof Uint8Array) return value._bytes.slice();
  if (typeof value?._getBytes === "function") {
    const bytes = value._getBytes();
    if (bytes instanceof Uint8Array) return bytes.slice();
  }
  if (typeof value?._bunFilePath === "string") {
    try {
      return new Uint8Array(cottontail.readFileBuffer(value._bunFilePath));
    } catch {
      return null;
    }
  }
  return null;
}

function storageBunFile(bytes, mime, name, lastModified) {
  const type = String(mime ?? "");
  const blob = {};
  Object.defineProperties(blob, {
    [storageBunFileBrand]: { value: true },
    [Symbol.toStringTag]: { value: "Blob" },
    _bytes: { value: bytes },
    name: { value: String(name ?? "") },
    type: { value: type },
    size: { value: bytes.byteLength },
    lastModified: { value: Number(lastModified ?? 0) },
    arrayBuffer: { value: async () => bytes.slice().buffer },
    bytes: { value: async () => bytes.slice() },
    text: { value: async () => new TextDecoder().decode(bytes) },
    slice: { value: (...args) => new globalThis.Blob([bytes], { type }).slice(...args) },
    stream: { value: () => new globalThis.Blob([bytes], { type }).stream() },
  });
  return blob;
}

function viewTypeCode(value) {
  if (Buffer.isBuffer?.(value)) return viewTypes.Buffer;
  const name = objectToString.call(value).slice(8, -1);
  const code = viewTypes[name];
  if (code === undefined || (name === "Float16Array" && typeof globalThis.Float16Array !== "function")) {
    return 0;
  }
  return code;
}

function viewConstructor(code) {
  switch (code) {
    case viewTypes.Int8Array: return Int8Array;
    case viewTypes.Uint8Array: return Uint8Array;
    case viewTypes.Uint8ClampedArray: return Uint8ClampedArray;
    case viewTypes.Int16Array: return Int16Array;
    case viewTypes.Uint16Array: return Uint16Array;
    case viewTypes.Int32Array: return Int32Array;
    case viewTypes.Uint32Array: return Uint32Array;
    case viewTypes.Float32Array: return Float32Array;
    case viewTypes.Float64Array: return Float64Array;
    case viewTypes.BigInt64Array: return BigInt64Array;
    case viewTypes.BigUint64Array: return BigUint64Array;
    case viewTypes.Float16Array: return globalThis.Float16Array;
    default: return undefined;
  }
}

function errorTypeCode(value) {
  if (typeof AggregateError === "function" && value instanceof AggregateError) return errorTypes.AggregateError;
  if (value instanceof EvalError) return errorTypes.EvalError;
  if (value instanceof RangeError) return errorTypes.RangeError;
  if (value instanceof ReferenceError) return errorTypes.ReferenceError;
  if (value instanceof SyntaxError) return errorTypes.SyntaxError;
  if (value instanceof TypeError) return errorTypes.TypeError;
  if (value instanceof URIError) return errorTypes.URIError;
  return errorTypes.Error;
}

function createError(code, message) {
  switch (code) {
    case errorTypes.EvalError: return new EvalError(message);
    case errorTypes.RangeError: return new RangeError(message);
    case errorTypes.ReferenceError: return new ReferenceError(message);
    case errorTypes.SyntaxError: return new SyntaxError(message);
    case errorTypes.TypeError: return new TypeError(message);
    case errorTypes.URIError: return new URIError(message);
    case errorTypes.AggregateError:
      if (typeof AggregateError === "function") return new AggregateError([], message);
      return new Error(message);
    case errorTypes.Error: return new Error(message);
    default: throw cloneReadError();
  }
}

function defineEnumerable(object, key, value) {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isArrayIndex(key, length) {
  if (key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && index < maxUint32 && String(index) === key;
}

class ByteWriter {
  constructor() {
    this.bytes = new Uint8Array(256);
    this.length = 0;
    this.view = new DataView(this.bytes.buffer);
  }

  ensure(extra) {
    if (!Number.isSafeInteger(extra) || extra < 0 || this.length + extra > maxUint32) {
      throw new RangeError("Cottontail serialization payload is too large");
    }
    const required = this.length + extra;
    if (required <= this.bytes.byteLength) return;
    let capacity = this.bytes.byteLength;
    while (capacity < required) capacity = Math.min(maxUint32, Math.max(required, capacity * 2));
    const next = new Uint8Array(capacity);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  writeByte(value) {
    this.ensure(1);
    this.bytes[this.length++] = Number(value) & 0xff;
  }

  writeUint32(value) {
    let remaining = Number(value) >>> 0;
    do {
      let byte = remaining & 0x7f;
      remaining = Math.floor(remaining / 128);
      if (remaining !== 0) byte |= 0x80;
      this.writeByte(byte);
    } while (remaining !== 0);
  }

  writeUint64(high, low) {
    let remaining = (BigInt(Number(high) >>> 0) << 32n) | BigInt(Number(low) >>> 0);
    do {
      let byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      if (remaining !== 0n) byte |= 0x80;
      this.writeByte(byte);
    } while (remaining !== 0n);
  }

  writeInt32(value) {
    this.ensure(4);
    this.view.setInt32(this.length, Number(value) | 0, true);
    this.length += 4;
  }

  writeDouble(value) {
    this.ensure(8);
    this.view.setFloat64(this.length, Number(value), true);
    this.length += 8;
  }

  writeBytes(value) {
    this.ensure(value.byteLength);
    this.bytes.set(value, this.length);
    this.length += value.byteLength;
  }

  writeString(value) {
    const text = String(value);
    this.writeUint32(text.length);
    this.ensure(text.length * 2);
    for (let index = 0; index < text.length; index += 1) {
      this.view.setUint16(this.length, text.charCodeAt(index), true);
      this.length += 2;
    }
  }

  release() {
    const result = this.bytes.slice(0, this.length);
    this.bytes = new Uint8Array(256);
    this.length = 0;
    this.view = new DataView(this.bytes.buffer);
    return result;
  }
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  require(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.bytes.byteLength - this.offset) {
      throw cloneReadError();
    }
  }

  readByte() {
    this.require(1);
    return this.bytes[this.offset++];
  }

  readUint32() {
    let result = 0;
    let multiplier = 1;
    for (let index = 0; index < 5; index += 1) {
      const byte = this.readByte();
      if (index === 4 && (byte & 0xf0) !== 0) throw cloneReadError();
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) return result >>> 0;
      multiplier *= 128;
    }
    throw cloneReadError();
  }

  readUint64() {
    let result = 0n;
    let shift = 0n;
    for (let index = 0; index < 10; index += 1) {
      const byte = this.readByte();
      if (index === 9 && (byte & 0xfe) !== 0) throw cloneReadError();
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) {
        return [Number((result >> 32n) & 0xffffffffn), Number(result & 0xffffffffn)];
      }
      shift += 7n;
    }
    throw cloneReadError();
  }

  readInt32() {
    this.require(4);
    const result = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return result;
  }

  readDouble() {
    this.require(8);
    const result = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return result;
  }

  readBytes(length) {
    this.require(length);
    const result = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  readString() {
    const length = this.readUint32();
    if (length > Math.floor((this.bytes.byteLength - this.offset) / 2)) throw cloneReadError();
    let result = "";
    const chunkSize = 4096;
    for (let start = 0; start < length; start += chunkSize) {
      const end = Math.min(length, start + chunkSize);
      const characters = new Array(end - start);
      for (let index = start; index < end; index += 1) {
        characters[index - start] = this.view.getUint16(this.offset, true);
        this.offset += 2;
      }
      result += String.fromCharCode(...characters);
    }
    return result;
  }
}

export class Serializer {
  constructor() {
    this._writer = new ByteWriter();
    this._ids = new WeakMap();
    this._nextId = 1;
    this._arrayBuffers = new WeakMap();
    this._headerWritten = false;
    this._forStorage = false;
    this._allowSharedArrayBuffer = false;
    this._treatArrayBufferViewsAsHostObjects = false;
  }

  writeHeader() {
    this._writer.writeBytes(wireMagic);
    this._writer.writeUint32(wireFormatVersion);
    this._headerWritten = true;
  }

  writeValue(value) {
    this._writeValue(value);
    return true;
  }

  releaseBuffer() {
    const result = Buffer.from(this._writer.release());
    this._ids = new WeakMap();
    this._nextId = 1;
    this._headerWritten = false;
    return result;
  }

  transferArrayBuffer(id, arrayBuffer) {
    if (!isArrayBufferObject(arrayBuffer)) {
      throw nodeTypeError("arrayBuffer must be an ArrayBuffer");
    }
    this._arrayBuffers.set(arrayBuffer, Number(id) >>> 0);
  }

  writeUint32(value) {
    this._writer.writeUint32(value);
  }

  writeUint64(high, low) {
    this._writer.writeUint64(high, low);
  }

  writeDouble(value) {
    this._writer.writeDouble(value);
  }

  writeRawBytes(buffer) {
    this._writer.writeBytes(byteView(buffer, "source"));
  }

  _setTreatArrayBufferViewsAsHostObjects() {
    this._treatArrayBufferViewsAsHostObjects = true;
  }

  _getDataCloneError(message) {
    return new Error(message);
  }

  _writeHostObject(_object) {
    return false;
  }

  _cloneError(value) {
    if (this._forStorage && typeof DOMException === "function") {
      return new DOMException("The object can not be cloned.", "DataCloneError");
    }
    let description = "The value";
    try {
      description = typeof value === "symbol" ? String(value) : objectToString.call(value);
    } catch {}
    return this._getDataCloneError(`${description} could not be cloned.`);
  }

  _writeReferenceHeader(value, tag) {
    const existing = this._ids.get(value);
    if (existing !== undefined) {
      this._writer.writeByte(tags.reference);
      this._writer.writeUint32(existing);
      return 0;
    }
    const id = this._nextId++;
    if (id > maxUint32) throw new RangeError("Too many objects in Cottontail serialization payload");
    this._ids.set(value, id);
    this._writer.writeByte(tag);
    this._writer.writeUint32(id);
    return id;
  }

  _writeProperties(value, keys = Object.keys(value)) {
    this._writer.writeUint32(keys.length);
    for (const key of keys) {
      this._writer.writeString(key);
      this._writeValue(value[key]);
    }
  }

  _writeHostObjectValue(value) {
    if (!this._writeReferenceHeader(value, tags.hostObject)) return;
    if (this._writeHostObject(value) === false) throw this._cloneError(value);
  }

  _writeArrayBufferView(value) {
    const code = viewTypeCode(value);
    if (code === 0) throw this._cloneError(value);
    if (!this._writeReferenceHeader(value, tags.arrayBufferView)) return;
    this._writer.writeUint32(code);
    this._writer.writeUint32(value.byteOffset);
    this._writer.writeUint32(code === viewTypes.DataView ? value.byteLength : value.length);
    this._writeValue(value.buffer);
  }

  _writeValue(value) {
    if (value === undefined) {
      this._writer.writeByte(tags.undefined);
      return;
    }
    if (value === null) {
      this._writer.writeByte(tags.null);
      return;
    }
    if (value === false) {
      this._writer.writeByte(tags.false);
      return;
    }
    if (value === true) {
      this._writer.writeByte(tags.true);
      return;
    }

    const type = typeof value;
    if (type === "number") {
      if (Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && !Object.is(value, -0)) {
        this._writer.writeByte(tags.int32);
        this._writer.writeInt32(value);
      } else {
        this._writer.writeByte(tags.double);
        this._writer.writeDouble(value);
      }
      return;
    }
    if (type === "bigint") {
      this._writer.writeByte(tags.bigint);
      this._writer.writeString(value.toString());
      return;
    }
    if (type === "string") {
      this._writer.writeByte(tags.string);
      this._writer.writeString(value);
      return;
    }
    if (type === "symbol" || type === "function") throw this._cloneError(value);

    if (ArrayBuffer.isView(value) && this._treatArrayBufferViewsAsHostObjects) {
      this._writeHostObjectValue(value);
      return;
    }

    if (Array.isArray(value)) {
      if (!this._writeReferenceHeader(value, tags.array)) return;
      const keys = Object.keys(value);
      const indexes = [];
      const properties = [];
      for (const key of keys) (isArrayIndex(key, value.length) ? indexes : properties).push(key);
      this._writer.writeUint32(value.length);
      this._writer.writeUint32(indexes.length);
      for (const key of indexes) {
        this._writer.writeUint32(Number(key));
        this._writeValue(value[key]);
      }
      this._writeProperties(value, properties);
      return;
    }

    if (value instanceof Date) {
      if (!this._writeReferenceHeader(value, tags.date)) return;
      this._writer.writeDouble(value.getTime());
      return;
    }
    if (value instanceof RegExp) {
      if (!this._writeReferenceHeader(value, tags.regexp)) return;
      this._writer.writeString(value.source);
      this._writer.writeString(value.flags);
      return;
    }
    if (isArrayBufferObject(value)) {
      const transferId = this._arrayBuffers.get(value);
      if (transferId !== undefined) {
        if (!this._writeReferenceHeader(value, tags.transferredArrayBuffer)) return;
        this._writer.writeUint32(transferId);
        return;
      }
      if (!this._writeReferenceHeader(value, tags.arrayBuffer)) return;
      const bytes = new Uint8Array(value);
      this._writer.writeUint32(bytes.byteLength);
      this._writer.writeBytes(bytes);
      return;
    }
    if (isSharedArrayBufferObject(value)) {
      if (!this._allowSharedArrayBuffer) throw this._cloneError(value);
      if (!this._writeReferenceHeader(value, tags.sharedArrayBuffer)) return;
      const bytes = new Uint8Array(value);
      this._writer.writeUint32(bytes.byteLength);
      this._writer.writeBytes(bytes);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      this._writeArrayBufferView(value);
      return;
    }
    if (value instanceof Map) {
      if (!this._writeReferenceHeader(value, tags.map)) return;
      const entries = Array.from(value);
      this._writer.writeUint32(entries.length);
      for (const [key, item] of entries) {
        this._writeValue(key);
        this._writeValue(item);
      }
      return;
    }
    if (value instanceof Set) {
      if (!this._writeReferenceHeader(value, tags.set)) return;
      const items = Array.from(value);
      this._writer.writeUint32(items.length);
      for (const item of items) this._writeValue(item);
      return;
    }
    if (value instanceof Error) {
      if (!this._writeReferenceHeader(value, tags.error)) return;
      this._writer.writeUint32(errorTypeCode(value));
      this._writer.writeString(String(value.message ?? ""));
      const hasStack = typeof value.stack === "string";
      this._writer.writeByte(hasStack ? 1 : 0);
      if (hasStack) this._writer.writeString(value.stack);
      const hasCause = hasOwn.call(value, "cause");
      this._writer.writeByte(hasCause ? 1 : 0);
      if (hasCause) this._writeValue(value.cause);
      const hasErrors = typeof AggregateError === "function" && value instanceof AggregateError;
      this._writer.writeByte(hasErrors ? 1 : 0);
      if (hasErrors) this._writeValue(value.errors);
      return;
    }

    const objectTag = objectToString.call(value);
    if (objectTag === "[object Boolean]") {
      if (!this._writeReferenceHeader(value, tags.boxedBoolean)) return;
      this._writer.writeByte(Boolean.prototype.valueOf.call(value) ? 1 : 0);
      this._writeProperties(value);
      return;
    }
    if (objectTag === "[object Number]") {
      if (!this._writeReferenceHeader(value, tags.boxedNumber)) return;
      this._writer.writeDouble(Number.prototype.valueOf.call(value));
      this._writeProperties(value);
      return;
    }
    if (objectTag === "[object String]") {
      if (!this._writeReferenceHeader(value, tags.boxedString)) return;
      this._writer.writeString(String.prototype.valueOf.call(value));
      this._writeProperties(value, Object.keys(value).filter((key) => !isArrayIndex(key, value.length)));
      return;
    }
    if (objectTag === "[object BigInt]") {
      if (!this._writeReferenceHeader(value, tags.boxedBigInt)) return;
      this._writer.writeString(BigInt.prototype.valueOf.call(value).toString());
      this._writeProperties(value);
      return;
    }

    if (this._forStorage && isBlockList(value)) {
      if (!this._writeReferenceHeader(value, tags.object)) return;
      this._writer.writeUint32(0);
      return;
    }
    if (isBunFile(value)) {
      const tag = this._forStorage ? tags.storageBunFile : tags.file;
      if (!this._writeReferenceHeader(value, tag)) return;
      const bytes = bunFileBytes(value);
      if (bytes == null) throw this._cloneError(value);
      this._writer.writeUint32(bytes.byteLength);
      this._writer.writeBytes(bytes);
      this._writer.writeString(String(value.type ?? ""));
      this._writer.writeString(String(value.name ?? ""));
      this._writer.writeDouble(Number(value.lastModified ?? 0));
      return;
    }
    if (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob) {
      const isFile = typeof globalThis.File === "function" && value instanceof globalThis.File;
      if (!this._writeReferenceHeader(value, isFile ? tags.file : tags.blob)) return;
      const bytes = value._bytes instanceof Uint8Array
        ? value._bytes
        : typeof value._getBytes === "function" ? value._getBytes() : null;
      if (!(bytes instanceof Uint8Array)) throw this._cloneError(value);
      this._writer.writeUint32(bytes.byteLength);
      this._writer.writeBytes(bytes);
      this._writer.writeString(String(value.type ?? ""));
      if (isFile) {
        this._writer.writeString(String(value.name ?? ""));
        this._writer.writeDouble(Number(value.lastModified ?? 0));
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null &&
        this._writeHostObject !== Serializer.prototype._writeHostObject &&
        this._writeHostObject !== DefaultSerializer.prototype._writeHostObject) {
      this._writeHostObjectValue(value);
      return;
    }

    if (!this._writeReferenceHeader(value, tags.object)) return;
    this._writeProperties(value);
  }
}

export class DefaultSerializer extends Serializer {
  _writeHostObject(object) {
    if (!ArrayBuffer.isView(object)) return false;
    const code = viewTypeCode(object);
    if (code === 0) return false;
    this.writeUint32(code);
    this.writeUint32(object.byteLength);
    this.writeRawBytes(object);
    return true;
  }
}

export class Deserializer {
  constructor(buffer, allowArrayBuffer = false) {
    this._reader = new ByteReader(byteView(buffer, "buffer", allowArrayBuffer));
    this._refs = new Map();
    this._arrayBuffers = new Map();
    this._wireFormatVersion = 0;
  }

  readHeader() {
    try {
      const magic = this._reader.readBytes(wireMagic.byteLength);
      for (let index = 0; index < wireMagic.byteLength; index += 1) {
        if (magic[index] !== wireMagic[index]) throw cloneReadError(true);
      }
      const version = this._reader.readUint32();
      if (version !== wireFormatVersion) throw cloneReadError(true);
      this._wireFormatVersion = version;
      return true;
    } catch (error) {
      this._wireFormatVersion = 0;
      if (error?.message?.includes("invalid or unsupported version")) throw error;
      throw cloneReadError(true);
    }
  }

  readValue() {
    return this._readValue();
  }

  getWireFormatVersion() {
    return this._wireFormatVersion;
  }

  transferArrayBuffer(id, arrayBuffer) {
    if (!isArrayBufferObject(arrayBuffer)) {
      throw nodeTypeError("arrayBuffer must be an ArrayBuffer");
    }
    this._arrayBuffers.set(Number(id) >>> 0, arrayBuffer);
  }

  readUint32() {
    return this._reader.readUint32();
  }

  readUint64() {
    return this._reader.readUint64();
  }

  readDouble() {
    return this._reader.readDouble();
  }

  readRawBytes(length) {
    const size = Number(length);
    if (!Number.isInteger(size) || size < 0) throw new Error("ReadRawBytes() failed");
    try {
      return Buffer.from(this._reader.readBytes(size));
    } catch {
      throw new Error("ReadRawBytes() failed");
    }
  }

  _readRawBytes(length) {
    return this.readRawBytes(length);
  }

  _readHostObject() {
    throw cloneReadError();
  }

  _remember(id, value) {
    if (id === 0 || this._refs.has(id)) throw cloneReadError();
    this._refs.set(id, value);
    return value;
  }

  _readProperties(object) {
    const count = this._reader.readUint32();
    for (let index = 0; index < count; index += 1) {
      const key = this._reader.readString();
      defineEnumerable(object, key, this._readValue());
    }
  }

  _readArrayBuffer(shared) {
    const length = this._reader.readUint32();
    const source = this._reader.readBytes(length);
    const buffer = shared ? new SharedArrayBuffer(length) : new ArrayBuffer(length);
    new Uint8Array(buffer).set(source);
    return buffer;
  }

  _readArrayBufferView(id) {
    const code = this._reader.readUint32();
    const byteOffset = this._reader.readUint32();
    const length = this._reader.readUint32();
    const buffer = this._readValue();
    if (!isArrayBufferObject(buffer) && !isSharedArrayBufferObject(buffer)) throw cloneReadError();
    let value;
    try {
      if (code === viewTypes.DataView) value = new DataView(buffer, byteOffset, length);
      else if (code === viewTypes.Buffer) value = Buffer.from(buffer, byteOffset, length);
      else {
        const Constructor = viewConstructor(code);
        if (typeof Constructor !== "function") throw cloneReadError();
        value = new Constructor(buffer, byteOffset, length);
      }
    } catch {
      throw cloneReadError();
    }
    return this._remember(id, value);
  }

  _readValue() {
    const tag = this._reader.readByte();
    switch (tag) {
      case tags.undefined: return undefined;
      case tags.null: return null;
      case tags.false: return false;
      case tags.true: return true;
      case tags.int32: return this._reader.readInt32();
      case tags.double: return this._reader.readDouble();
      case tags.bigint: {
        try {
          return BigInt(this._reader.readString());
        } catch {
          throw cloneReadError();
        }
      }
      case tags.string: return this._reader.readString();
      case tags.reference: {
        const id = this._reader.readUint32();
        if (!this._refs.has(id)) throw cloneReadError();
        return this._refs.get(id);
      }
      case tags.object: {
        const object = this._remember(this._reader.readUint32(), {});
        this._readProperties(object);
        return object;
      }
      case tags.array: {
        const id = this._reader.readUint32();
        const length = this._reader.readUint32();
        const array = this._remember(id, new Array(length));
        const elementCount = this._reader.readUint32();
        for (let index = 0; index < elementCount; index += 1) {
          const elementIndex = this._reader.readUint32();
          if (elementIndex >= length) throw cloneReadError();
          defineEnumerable(array, String(elementIndex), this._readValue());
        }
        this._readProperties(array);
        return array;
      }
      case tags.date:
        return this._remember(this._reader.readUint32(), new Date(this._reader.readDouble()));
      case tags.regexp: {
        const id = this._reader.readUint32();
        try {
          return this._remember(id, new RegExp(this._reader.readString(), this._reader.readString()));
        } catch {
          throw cloneReadError();
        }
      }
      case tags.arrayBuffer: {
        const id = this._reader.readUint32();
        return this._remember(id, this._readArrayBuffer(false));
      }
      case tags.sharedArrayBuffer: {
        if (typeof SharedArrayBuffer !== "function") throw cloneReadError();
        const id = this._reader.readUint32();
        return this._remember(id, this._readArrayBuffer(true));
      }
      case tags.transferredArrayBuffer: {
        const id = this._reader.readUint32();
        const transferId = this._reader.readUint32();
        const buffer = this._arrayBuffers.get(transferId);
        if (buffer === undefined) throw cloneReadError();
        return this._remember(id, buffer);
      }
      case tags.arrayBufferView:
        return this._readArrayBufferView(this._reader.readUint32());
      case tags.map: {
        const map = this._remember(this._reader.readUint32(), new Map());
        const size = this._reader.readUint32();
        for (let index = 0; index < size; index += 1) map.set(this._readValue(), this._readValue());
        return map;
      }
      case tags.set: {
        const set = this._remember(this._reader.readUint32(), new Set());
        const size = this._reader.readUint32();
        for (let index = 0; index < size; index += 1) set.add(this._readValue());
        return set;
      }
      case tags.error: {
        const id = this._reader.readUint32();
        const code = this._reader.readUint32();
        const message = this._reader.readString();
        const error = this._remember(id, createError(code, message));
        if (this._reader.readByte()) error.stack = this._reader.readString();
        if (this._reader.readByte()) {
          Object.defineProperty(error, "cause", {
            configurable: true,
            value: this._readValue(),
            writable: true,
          });
        }
        if (this._reader.readByte()) {
          Object.defineProperty(error, "errors", {
            configurable: true,
            value: this._readValue(),
            writable: true,
          });
        }
        return error;
      }
      case tags.boxedBoolean: {
        const object = this._remember(this._reader.readUint32(), new Boolean(Boolean(this._reader.readByte())));
        this._readProperties(object);
        return object;
      }
      case tags.boxedNumber: {
        const object = this._remember(this._reader.readUint32(), new Number(this._reader.readDouble()));
        this._readProperties(object);
        return object;
      }
      case tags.boxedString: {
        const object = this._remember(this._reader.readUint32(), new String(this._reader.readString()));
        this._readProperties(object);
        return object;
      }
      case tags.boxedBigInt: {
        const id = this._reader.readUint32();
        let object;
        try {
          object = Object(BigInt(this._reader.readString()));
        } catch {
          throw cloneReadError();
        }
        this._remember(id, object);
        this._readProperties(object);
        return object;
      }
      case tags.blob: {
        const id = this._reader.readUint32();
        const bytes = this._reader.readBytes(this._reader.readUint32()).slice();
        const mime = this._reader.readString();
        if (typeof globalThis.Blob !== "function") throw cloneReadError();
        return this._remember(id, new globalThis.Blob([bytes], { type: mime }));
      }
      case tags.file: {
        const id = this._reader.readUint32();
        const bytes = this._reader.readBytes(this._reader.readUint32()).slice();
        const mime = this._reader.readString();
        const name = this._reader.readString();
        const lastModified = this._reader.readDouble();
        if (typeof globalThis.File !== "function") throw cloneReadError();
        return this._remember(id, new globalThis.File([bytes], name, { type: mime, lastModified }));
      }
      case tags.storageBunFile: {
        const id = this._reader.readUint32();
        const bytes = this._reader.readBytes(this._reader.readUint32()).slice();
        const mime = this._reader.readString();
        const name = this._reader.readString();
        const lastModified = this._reader.readDouble();
        return this._remember(id, storageBunFile(bytes, mime, name, lastModified));
      }
      case tags.hostObject: {
        const id = this._reader.readUint32();
        return this._remember(id, this._readHostObject());
      }
      default: throw cloneReadError();
    }
  }
}

export class DefaultDeserializer extends Deserializer {
  _readHostObject() {
    const code = this.readUint32();
    const bytes = this.readRawBytes(this.readUint32());
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    if (code === viewTypes.DataView) return new DataView(buffer);
    if (code === viewTypes.Buffer) return Buffer.from(buffer);
    const Constructor = viewConstructor(code);
    if (typeof Constructor !== "function") throw cloneReadError();
    return new Constructor(buffer);
  }
}

export function serialize(value, options = undefined) {
  const serializer = new DefaultSerializer();
  serializer._forStorage = options?.forStorage === true;
  serializer._allowSharedArrayBuffer = serializer._forStorage;
  serializer.writeHeader();
  serializer.writeValue(value);
  return serializer.releaseBuffer();
}

export function deserialize(buffer, options = undefined) {
  const deserializer = new DefaultDeserializer(buffer, options?.allowArrayBuffer === true);
  deserializer.readHeader();
  return deserializer.readValue();
}

export { wireFormatVersion };
