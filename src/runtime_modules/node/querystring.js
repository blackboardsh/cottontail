export function escape(value) {
  return encodeURIComponent(String(value));
}

export function unescape(value) {
  try {
    return decodeURIComponent(String(value).replace(/\+/g, " "));
  } catch {
    return String(value);
  }
}

export function unescapeBuffer(value, decodeSpaces = true) {
  const text = decodeSpaces ? String(value).replace(/\+/g, " ") : String(value);
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "%" && /^[0-9a-fA-F]{2}$/.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(char.charCodeAt(0) & 0xff);
    }
  }
  return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : new Uint8Array(bytes);
}

export function stringify(object = {}, sep = "&", eq = "=", options = undefined) {
  const encode = options?.encodeURIComponent ?? escape;
  const parts = [];
  for (const key of Object.keys(Object(object))) {
    const value = object[key];
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      parts.push(`${encode(key)}${eq}${encode(item == null ? "" : item)}`);
    }
  }
  return parts.join(sep);
}

export const encode = stringify;

export function parse(str = "", sep = "&", eq = "=", options = undefined) {
  const decode = options?.decodeURIComponent ?? unescape;
  const result = Object.create(null);
  const pairs = String(str).split(sep);
  const maxKeys = options?.maxKeys == null ? 1000 : Number(options.maxKeys);
  const limit = maxKeys > 0 ? Math.min(maxKeys, pairs.length) : pairs.length;
  for (let index = 0; index < limit; index += 1) {
    const part = pairs[index];
    if (!part) continue;
    const marker = part.indexOf(eq);
    const rawKey = marker < 0 ? part : part.slice(0, marker);
    const rawValue = marker < 0 ? "" : part.slice(marker + eq.length);
    const key = decode(rawKey);
    const value = decode(rawValue);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      if (Array.isArray(result[key])) result[key].push(value);
      else result[key] = [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

export const decode = parse;

export default { decode, encode, escape, parse, stringify, unescape, unescapeBuffer };
