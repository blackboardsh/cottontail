import { asBuffer } from "./web-buffer-utils.js";

const uuidEncodingCodes = {
  hex: 0,
  buffer: 1,
  base64: 2,
  base64url: 3,
};

const uuidv5Namespaces = {
  dns: new Uint8Array([0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
  url: new Uint8Array([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
  oid: new Uint8Array([0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
  x500: new Uint8Array([0x6b, 0xa7, 0xb8, 0x14, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]),
};

function uuidError(ErrorType, code, message) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}
function uuidString(value) {
  if (typeof value === "string") return value;
  if (value == null || typeof value !== "object") return null;
  try {
    return String.prototype.valueOf.call(value);
  } catch {
    return null;
  }
}

function uuidEncoding(value) {
  const string = uuidString(value);
  if (string == null) return uuidEncodingCodes.hex;
  const encoding = uuidEncodingCodes[string.toLowerCase()];
  if (encoding === undefined) {
    throw uuidError(
      TypeError,
      "ERR_UNKNOWN_ENCODING",
      "Encoding must be one of base64, base64url, hex, or buffer",
    );
  }
  return encoding;
}

function uuidNativeResult(result, encoding) {
  return encoding === uuidEncodingCodes.buffer
    ? globalThis.Buffer.from(result)
    : result;
}

function uuidBufferSource(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return asBuffer(value);
  if (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) {
    return asBuffer(value);
  }
  return null;
}

function uuidv7Timestamp(value) {
  if (value != null && typeof value === "object") {
    try {
      const timestamp = Date.prototype.getTime.call(value);
      return Number.isNaN(timestamp) ? 0 : Math.max(0, timestamp);
    } catch {}
  }
  if (typeof value !== "number") {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      `The "timestamp" property must be of type number. Received ${typeof value}`,
    );
  }
  if (Number.isNaN(value)) return 0;
  if (value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw uuidError(
      RangeError,
      "ERR_OUT_OF_RANGE",
      `The value of "timestamp" is out of range. It must be >= 0 and <= 9007199254740991. Received ${String(value)}`,
    );
  }
  if (!Number.isInteger(value)) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "timestamp" property must be of type integer. Received number',
    );
  }
  return value;
}

export function randomUUIDv7(encodingOrTimestamp = undefined, timestampInput = undefined) {
  const encodingString = uuidString(encodingOrTimestamp);
  const encoding = encodingString == null
    ? uuidEncodingCodes.hex
    : uuidEncoding(encodingString);
  const timestampValue = encodingString != null && arguments.length > 1
    ? timestampInput
    : arguments.length === 1 && encodingString == null
      ? encodingOrTimestamp
      : undefined;
  const timestamp = timestampValue === undefined
    ? Date.now()
    : uuidv7Timestamp(timestampValue);
  return uuidNativeResult(
    cottontail.randomUUIDv7Native(timestamp, encoding),
    encoding,
  );
}

function uuidv5NamespaceBytes(namespace) {
  const bufferSource = uuidBufferSource(namespace);
  if (bufferSource != null) {
    const bytes = bufferSource;
    if (bytes.byteLength !== 16) {
      throw uuidError(
        TypeError,
        "ERR_INVALID_ARG_VALUE",
        "Namespace must be exactly 16 bytes",
      );
    }
    return bytes;
  }

  const string = uuidString(namespace);
  if (string == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "namespace" argument must be a string or buffer',
    );
  }
  const alias = uuidv5Namespaces[string.toLowerCase()];
  if (alias) return alias;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(string)) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_VALUE",
      "Invalid UUID format for namespace",
    );
  }
  const compact = string.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export function randomUUIDv5(name, namespace, encodingValue = undefined) {
  if (arguments.length === 0 || name == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "name" argument must be specified',
    );
  }
  if (arguments.length < 2 || namespace == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "namespace" argument must be specified',
    );
  }

  const nameString = uuidString(name);
  const nameValue = nameString ?? uuidBufferSource(name);
  if (nameValue == null) {
    throw uuidError(
      TypeError,
      "ERR_INVALID_ARG_TYPE",
      'The "name" argument must be of type string or BufferSource',
    );
  }

  const encoding = uuidEncoding(encodingValue);
  const result = cottontail.randomUUIDv5Native(
    nameValue,
    uuidv5NamespaceBytes(namespace),
    encoding,
  );
  return uuidNativeResult(result, encoding);
}
