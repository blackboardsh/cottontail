function jsonTextInput(value) {
  if (value == null) throw new TypeError("Expected a string or typed array");
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
    return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
    return new TextDecoder().decode(new Uint8Array(value));
  }
  return String(value);
}

function stripJSONCCommentsAndTrailingCommas(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      index -= 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      if (index < source.length) index += 1;
      continue;
    }
    out += char;
  }

  source = out;
  out = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] === "}" || source[cursor] === "]") continue;
    }
    out += char;
  }
  return out;
}

function assertJSONNestingWithinLimit(source, limit) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      if (depth > limit) throw new RangeError("Maximum JSON nesting depth exceeded");
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
}

function isJSONWhitespace(char) {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function isJSONDelimiter(char) {
  return char === undefined || isJSONWhitespace(char);
}

function scanJSONString(source, start) {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") return { status: "complete", end: index + 1 };
    if (char < " ") return { status: "invalid" };
  }
  return { status: "incomplete" };
}

function scanJSONComposite(source, start) {
  const stack = [source[start]];
  let inString = false;
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      else if (char < " ") return { status: "invalid" };
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "\n" || char === "\r") return { status: "invalid" };
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return { status: "invalid" };
      if (stack.length === 0) return { status: "complete", end: index + 1 };
    }
  }
  return { status: "incomplete" };
}

function scanJSONLiteral(source, start, literal) {
  const remaining = source.length - start;
  if (remaining < literal.length && literal.startsWith(source.slice(start))) return { status: "incomplete" };
  if (source.slice(start, start + literal.length) !== literal) return { status: "invalid" };
  const end = start + literal.length;
  if (!isJSONDelimiter(source[end])) return { status: "invalid" };
  return { status: "complete", end };
}

function scanJSONNumber(source, start) {
  let end = start;
  while (end < source.length && !isJSONWhitespace(source[end])) end += 1;
  const token = source.slice(start, end);
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(token)) return { status: "complete", end };
  if (end === source.length && /^-?(?:0|[1-9]\d*)?(?:\.\d*)?(?:[eE][+-]?)?$/.test(token)) return { status: "incomplete" };
  return { status: "invalid" };
}

function scanJSONValue(source, start) {
  const char = source[start];
  if (char === undefined) return { status: "incomplete" };
  if (char === "\"") return scanJSONString(source, start);
  if (char === "{" || char === "[") return scanJSONComposite(source, start);
  if (char === "t") return scanJSONLiteral(source, start, "true");
  if (char === "f") return scanJSONLiteral(source, start, "false");
  if (char === "n") return scanJSONLiteral(source, start, "null");
  if (char === "-" || (char >= "0" && char <= "9")) return scanJSONNumber(source, start);
  return { status: "invalid" };
}

function parseJSONLString(source) {
  const values = [];
  let position = 0;
  let read = 0;
  if (source.charCodeAt(0) === 0xfeff) position = 1;
  for (;;) {
    while (position < source.length && isJSONWhitespace(source[position])) position += 1;
    if (position >= source.length) return { values, read, done: true, error: null };

    const scan = scanJSONValue(source, position);
    if (scan.status === "incomplete") return { values, read, done: false, error: null };
    if (scan.status === "invalid") return { values, read, done: false, error: new SyntaxError("Invalid JSONL input") };

    const raw = source.slice(position, scan.end);
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { values, read, done: false, error };
    }

    values.push(value);
    read = scan.end;

    let cursor = scan.end;
    while (cursor < source.length && (source[cursor] === " " || source[cursor] === "\t")) cursor += 1;
    if (cursor < source.length && source[cursor] !== "\n" && source[cursor] !== "\r") {
      return { values, read, done: false, error: new SyntaxError("Invalid JSONL input") };
    }

    position = cursor;
    while (position < source.length && (source[position] === "\n" || source[position] === "\r")) position += 1;
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;

function appendCodePoint(out, codePoint) {
  if (codePoint <= 0xffff) return out + String.fromCharCode(codePoint);
  codePoint -= 0x10000;
  return out + String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
}

function decodeJSONLUtf8(bytes) {
  let out = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    if (first < 0x80) {
      out += String.fromCharCode(first);
      index += 1;
      continue;
    }

    let codePoint = 0xfffd;
    let width = 1;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const fourth = bytes[index + 3];
    if (first >= 0xc2 && first <= 0xdf && second >= 0x80 && second <= 0xbf) {
      codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
      width = 2;
    } else if (
      first === 0xe0 && second >= 0xa0 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first >= 0xe1 && first <= 0xec && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first === 0xed && second >= 0x80 && second <= 0x9f && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first >= 0xee && first <= 0xef && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf
    ) {
      codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
      width = 3;
    } else if (
      first === 0xf0 && second >= 0x90 && second <= 0xbf && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    } else if (
      first >= 0xf1 && first <= 0xf3 && second >= 0x80 && second <= 0xbf && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    } else if (
      first === 0xf4 && second >= 0x80 && second <= 0x8f && third >= 0x80 && third <= 0xbf &&
      fourth >= 0x80 && fourth <= 0xbf
    ) {
      codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) | ((third & 0x3f) << 6) | (fourth & 0x3f);
      width = 4;
    }

    out = appendCodePoint(out, codePoint);
    index += width;
  }
  return out;
}

function jsonlTypedArrayView(input, start, end) {
  if (input == null) throw new TypeError("Expected a string or typed array");
  if (!ArrayBuffer.isView(input) || input instanceof DataView) return null;
  if (input.buffer?.detached === true) {
    throw new TypeError("Cannot parse a detached ArrayBuffer");
  }

  const byteLength = typedArrayByteLength.call(input);
  const byteOffset = typedArrayByteOffset.call(input);
  if (byteLength > 512 * 1024 * 1024) throw new RangeError("Input is too large");
  let byteStart = Math.min(Math.max(Number(start) || 0, 0), byteLength);
  const byteEnd = end === undefined ? byteLength : Math.min(Math.max(Number(end) || 0, 0), byteLength);
  if (byteEnd < byteStart) byteStart = byteEnd;
  const viewEnd = byteEnd;
  let view = new Uint8Array(input.buffer, byteOffset + byteStart, viewEnd - byteStart);
  let bomLength = 0;
  if (byteStart === 0 && view.length >= 3 && view[0] === 0xef && view[1] === 0xbb && view[2] === 0xbf) {
    view = view.subarray(3);
    bomLength = 3;
  }
  return { view, byteStart, bomLength };
}

function parseJSONLChunk(input, start = 0, end = undefined) {
  const typed = jsonlTypedArrayView(input, start, end);
  if (typed) {
    const source = decodeJSONLUtf8(typed.view);
    const result = parseJSONLString(source);
    const readBytes = new TextEncoder().encode(source.slice(0, result.read)).byteLength;
    return {
      values: result.values,
      read: typed.byteStart + typed.bomLength + readBytes,
      done: result.done,
      error: result.error,
    };
  }
  const result = parseJSONLString(jsonTextInput(input));
  return {
    values: result.values,
    read: result.read,
    done: result.done,
    error: result.error,
  };
}

export const JSONC = {
  parse(text) {
    const source = stripJSONCCommentsAndTrailingCommas(jsonTextInput(text));
    assertJSONNestingWithinLimit(source, 10_000);
    return JSON.parse(source);
  },
};
export const JSONL = {
  [Symbol.toStringTag]: "JSONL",
  parse(input) {
    const result = parseJSONLChunk(input);
    if (result.error && result.values.length === 0) throw result.error;
    return result.values;
  },
  parseChunk(input, start = 0, end = undefined) {
    return parseJSONLChunk(input, start, end);
  },
};
