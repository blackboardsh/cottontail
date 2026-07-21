import { Buffer } from "./buffer.js";
import * as querystringNamespace from "./querystring.js";

const hexTable = new Array(256);
for (let index = 0; index < hexTable.length; index += 1) {
  hexTable[index] = `%${index.toString(16).padStart(2, "0").toUpperCase()}`;
}

const noEscape = new Uint8Array(128);
for (const char of "!'()*-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz~") {
  noEscape[char.charCodeAt(0)] = 1;
}

const QueryString = {};

function invalidUriError() {
  const error = new URIError("URI malformed");
  error.code = "ERR_INVALID_URI";
  return error;
}

function encodeString(value) {
  const length = value.length;
  if (length === 0) return "";

  let output = "";
  let lastPosition = 0;
  let index = 0;

  outer: for (; index < length; index += 1) {
    let code = value.charCodeAt(index);

    while (code < 0x80) {
      if (noEscape[code] !== 1) {
        if (lastPosition < index) output += value.slice(lastPosition, index);
        lastPosition = index + 1;
        output += hexTable[code];
      }

      index += 1;
      if (index === length) break outer;
      code = value.charCodeAt(index);
    }

    if (lastPosition < index) output += value.slice(lastPosition, index);

    if (code < 0x800) {
      lastPosition = index + 1;
      output += hexTable[0xc0 | (code >> 6)] + hexTable[0x80 | (code & 0x3f)];
      continue;
    }

    if (code < 0xd800 || code >= 0xe000) {
      lastPosition = index + 1;
      output +=
        hexTable[0xe0 | (code >> 12)] +
        hexTable[0x80 | ((code >> 6) & 0x3f)] +
        hexTable[0x80 | (code & 0x3f)];
      continue;
    }

    index += 1;
    if (index >= length) throw invalidUriError();

    const second = value.charCodeAt(index) & 0x3ff;
    lastPosition = index + 1;
    code = 0x10000 + (((code & 0x3ff) << 10) | second);
    output +=
      hexTable[0xf0 | (code >> 18)] +
      hexTable[0x80 | ((code >> 12) & 0x3f)] +
      hexTable[0x80 | ((code >> 6) & 0x3f)] +
      hexTable[0x80 | (code & 0x3f)];
  }

  if (lastPosition === 0) return value;
  return lastPosition < length ? output + value.slice(lastPosition) : output;
}

function hexValue(code) {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

export function unescapeBuffer(value, decodeSpaces = false) {
  const output = Buffer.allocUnsafe(value.length);
  const maximum = value.length - 2;
  let hasHex = false;
  let inputIndex = 0;
  let outputIndex = 0;

  while (inputIndex < value.length) {
    let code = value.charCodeAt(inputIndex);
    if (code === 43 && decodeSpaces) {
      output[outputIndex++] = 32;
      inputIndex += 1;
      continue;
    }

    if (code === 37 && inputIndex < maximum) {
      code = value.charCodeAt(++inputIndex);
      const high = hexValue(code);
      if (high < 0) {
        output[outputIndex++] = 37;
        continue;
      }

      const low = hexValue(value.charCodeAt(++inputIndex));
      if (low < 0) {
        output[outputIndex++] = 37;
        inputIndex -= 1;
      } else {
        hasHex = true;
        code = high * 16 + low;
      }
    }

    output[outputIndex++] = code;
    inputIndex += 1;
  }

  return hasHex ? output.slice(0, outputIndex) : output;
}

export function unescape(value, decodeSpaces = false) {
  try {
    return decodeURIComponent(value);
  } catch {
    return QueryString.unescapeBuffer(value, decodeSpaces).toString();
  }
}

export function escape(value) {
  if (typeof value !== "string") {
    if (typeof value === "object") value = String(value);
    else value += "";
  }
  return encodeString(value);
}

function stringifyPrimitive(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return `${value}`;
  if (typeof value === "bigint") return `${value}`;
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function encodeStringified(value, encode) {
  if (typeof value === "string") return value.length > 0 ? encode(value) : "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 1e21 ? `${value}` : encode(`${value}`);
  }
  if (typeof value === "bigint") return `${value}`;
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

function encodeStringifiedCustom(value, encode) {
  return encode(stringifyPrimitive(value));
}

export function stringify(object, separator, equals, options) {
  separator ||= "&";
  equals ||= "=";

  let encode = QueryString.escape;
  if (options && typeof options.encodeURIComponent === "function") {
    encode = options.encodeURIComponent;
  }
  const convert = encode === escape ? encodeStringified : encodeStringifiedCustom;

  if (object === null || typeof object !== "object") return "";

  const keys = Object.keys(object);
  let fields = "";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const value = object[key];
    const encodedKey = `${convert(key, encode)}${equals}`;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (fields) fields += separator;
      for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
        if (valueIndex > 0) fields += separator;
        fields += encodedKey + convert(value[valueIndex], encode);
      }
    } else {
      if (fields) fields += separator;
      fields += encodedKey + convert(value, encode);
    }
  }
  return fields;
}

export const encode = stringify;

function characterCodes(value) {
  if (value.length === 0) return [];
  if (value.length === 1) return [value.charCodeAt(0)];
  const codes = new Array(value.length);
  for (let index = 0; index < value.length; index += 1) codes[index] = value.charCodeAt(index);
  return codes;
}

const defaultSeparatorCodes = [38];
const defaultEqualsCodes = [61];

function decodeString(value, decoder) {
  try {
    return decoder(value);
  } catch {
    return QueryString.unescape(value, true);
  }
}

function addKeyValue(object, key, value, keyEncoded, valueEncoded, decoder) {
  if (key.length > 0 && keyEncoded) key = decodeString(key, decoder);
  if (value.length > 0 && valueEncoded) value = decodeString(value, decoder);

  if (object[key] === undefined) {
    object[key] = value;
  } else {
    const current = object[key];
    if (current.pop) current[current.length] = value;
    else object[key] = [current, value];
  }
}

function isHexCode(code) {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 70) ||
    (code >= 97 && code <= 102)
  );
}

export function parse(value, separator, equals, options) {
  const object = Object.create(null);
  if (typeof value !== "string" || value.length === 0) return object;

  const separatorCodes = !separator ? defaultSeparatorCodes : characterCodes(String(separator));
  const equalsCodes = !equals ? defaultEqualsCodes : characterCodes(String(equals));
  const separatorLength = separatorCodes.length;
  const equalsLength = equalsCodes.length;

  let pairs = 1000;
  if (options && typeof options.maxKeys === "number") {
    pairs = options.maxKeys > 0 ? options.maxKeys : -1;
  }

  let decoder = QueryString.unescape;
  if (options && typeof options.decodeURIComponent === "function") {
    decoder = options.decodeURIComponent;
  }
  const customDecoder = decoder !== unescape;

  let lastPosition = 0;
  let separatorIndex = 0;
  let equalsIndex = 0;
  let key = "";
  let decodedValue = "";
  let keyEncoded = customDecoder;
  let valueEncoded = customDecoder;
  const plusCharacter = customDecoder ? "%20" : " ";
  let encodeCheck = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code === separatorCodes[separatorIndex]) {
      separatorIndex += 1;
      if (separatorIndex === separatorLength) {
        const end = index - separatorIndex + 1;
        if (equalsIndex < equalsLength) {
          if (lastPosition < end) {
            key += value.slice(lastPosition, end);
          } else if (key.length === 0) {
            pairs -= 1;
            if (pairs === 0) return object;
            lastPosition = index + 1;
            separatorIndex = 0;
            equalsIndex = 0;
            continue;
          }
        } else if (lastPosition < end) {
          decodedValue += value.slice(lastPosition, end);
        }

        addKeyValue(object, key, decodedValue, keyEncoded, valueEncoded, decoder);
        pairs -= 1;
        if (pairs === 0) return object;

        keyEncoded = customDecoder;
        valueEncoded = customDecoder;
        key = "";
        decodedValue = "";
        encodeCheck = 0;
        lastPosition = index + 1;
        separatorIndex = 0;
        equalsIndex = 0;
      }
      continue;
    }

    separatorIndex = 0;
    if (equalsIndex < equalsLength) {
      if (code === equalsCodes[equalsIndex]) {
        equalsIndex += 1;
        if (equalsIndex === equalsLength) {
          const end = index - equalsIndex + 1;
          if (lastPosition < end) key += value.slice(lastPosition, end);
          encodeCheck = 0;
          lastPosition = index + 1;
        }
        continue;
      }

      equalsIndex = 0;
      if (!keyEncoded) {
        if (code === 37) {
          encodeCheck = 1;
          continue;
        }
        if (encodeCheck > 0) {
          if (isHexCode(code)) {
            encodeCheck += 1;
            if (encodeCheck === 3) keyEncoded = true;
            continue;
          }
          encodeCheck = 0;
        }
      }

      if (code === 43) {
        if (lastPosition < index) key += value.slice(lastPosition, index);
        key += plusCharacter;
        lastPosition = index + 1;
        continue;
      }
    }

    if (code === 43) {
      if (lastPosition < index) decodedValue += value.slice(lastPosition, index);
      decodedValue += plusCharacter;
      lastPosition = index + 1;
    } else if (!valueEncoded) {
      if (code === 37) {
        encodeCheck = 1;
      } else if (encodeCheck > 0) {
        if (isHexCode(code)) {
          encodeCheck += 1;
          if (encodeCheck === 3) valueEncoded = true;
        } else {
          encodeCheck = 0;
        }
      }
    }
  }

  if (lastPosition < value.length) {
    if (equalsIndex < equalsLength) key += value.slice(lastPosition);
    else if (separatorIndex < separatorLength) decodedValue += value.slice(lastPosition);
  } else if (equalsIndex === 0 && key.length === 0) {
    return object;
  }

  addKeyValue(object, key, decodedValue, keyEncoded, valueEncoded, decoder);
  return object;
}

export const decode = parse;

Object.assign(QueryString, {
  decode,
  encode,
  escape,
  parse,
  stringify,
  unescape,
  unescapeBuffer,
});

// The CommonJS builtin bridge exposes this namespace, while Node's module is mutable.
for (const name of Object.keys(QueryString)) {
  const descriptor = Object.getOwnPropertyDescriptor(querystringNamespace, name);
  if (descriptor?.configurable) {
    Object.defineProperty(querystringNamespace, name, {
      configurable: true,
      enumerable: true,
      get() {
        return QueryString[name];
      },
      set(value) {
        QueryString[name] = value;
      },
    });
  }
}

export default QueryString;
