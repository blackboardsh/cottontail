function textInput(value) {
  if (value == null) throw new TypeError("Expected a string to parse");
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return String(value);
}

function syntax(message) {
  return new SyntaxError(`JSON5 Parse error: ${message}`);
}

function isHex(char) {
  return /^[0-9a-fA-F]$/.test(char ?? "");
}

function hexValue(char) {
  return Number.parseInt(char, 16);
}

function isWhitespace(char) {
  return char === " " || char === "\t" || char === "\n" || char === "\r" ||
    char === "\v" || char === "\f" || char === "\u00a0" || char === "\ufeff" ||
    char === "\u1680" || char === "\u2028" || char === "\u2029" ||
    char === "\u202f" || char === "\u205f" || char === "\u3000" ||
    (char >= "\u2000" && char <= "\u200a");
}

const identifierStartPattern = /^[$_\p{ID_Start}]$/u;
const identifierPartPattern = /^[$_\u200c\u200d\p{ID_Continue}]$/u;

function isIdentifierStart(char) {
  return identifierStartPattern.test(char);
}

function isIdentifierPart(char) {
  return identifierPartPattern.test(char);
}

function isIdentifierName(value) {
  const text = String(value);
  if (text.length === 0) return false;
  let index = 0;
  let first = true;
  while (index < text.length) {
    const codePoint = text.codePointAt(index);
    const char = String.fromCodePoint(codePoint);
    if (first ? !isIdentifierStart(char) : !isIdentifierPart(char)) return false;
    index += char.length;
    first = false;
  }
  return true;
}

class JSON5Parser {
  constructor(source) {
    this.source = String(source);
    this.pos = 0;
    this.token = { type: "eof", value: undefined };
  }

  current() {
    return this.source[this.pos];
  }

  readChar() {
    if (this.pos >= this.source.length) return null;
    const codePoint = this.source.codePointAt(this.pos);
    const char = String.fromCodePoint(codePoint);
    return { char, codePoint, length: char.length };
  }

  skipWhitespaceAndComments() {
    while (this.pos < this.source.length) {
      const char = this.current();
      if (isWhitespace(char)) {
        this.pos += 1;
        continue;
      }
      if (char === "/" && this.source[this.pos + 1] === "/") {
        this.pos += 2;
        while (this.pos < this.source.length) {
          const next = this.current();
          if (next === "\n" || next === "\r" || next === "\u2028" || next === "\u2029") break;
          this.pos += 1;
        }
        continue;
      }
      if (char === "/" && this.source[this.pos + 1] === "*") {
        this.pos += 2;
        const end = this.source.indexOf("*/", this.pos);
        if (end < 0) throw syntax("Unterminated multi-line comment");
        this.pos = end + 2;
        continue;
      }
      break;
    }
  }

  scan() {
    this.skipWhitespaceAndComments();
    const char = this.current();
    if (char === undefined) return this.token = { type: "eof" };
    this.pos += 1;
    switch (char) {
      case "{": return this.token = { type: "left_brace" };
      case "}": return this.token = { type: "right_brace" };
      case "[": return this.token = { type: "left_bracket" };
      case "]": return this.token = { type: "right_bracket" };
      case ":": return this.token = { type: "colon" };
      case ",": return this.token = { type: "comma" };
      case "\"":
      case "'":
        this.pos -= 1;
        return this.token = { type: "string", value: this.scanString() };
      case "+":
        return this.token = { type: "number", value: this.scanSignedValue(false) };
      case "-":
        return this.token = { type: "number", value: this.scanSignedValue(true) };
      case ".":
        this.pos -= 1;
        return this.token = { type: "number", value: this.scanNumber() };
      case "/":
        throw syntax("Unexpected character");
      default:
        if (char >= "0" && char <= "9") {
          this.pos -= 1;
          return this.token = { type: "number", value: this.scanNumber() };
        }
        this.pos -= 1;
        if (char === "\\" || isIdentifierStart(char)) {
          const identifier = this.scanIdentifier();
          if (identifier === "true") return this.token = { type: "boolean", value: true };
          if (identifier === "false") return this.token = { type: "boolean", value: false };
          if (identifier === "null") return this.token = { type: "null", value: null };
          return this.token = { type: "identifier", value: identifier };
        }
        throw syntax(char === undefined ? "Unexpected end of input" : "Unexpected character");
    }
  }

  scanSignedValue(negative) {
    const start = this.current();
    if ((start >= "0" && start <= "9") || start === ".") {
      const value = this.scanNumber();
      return negative ? -value : value;
    }
    if (this.source.startsWith("Infinity", this.pos) && !this.identifierContinuesAt(this.pos + "Infinity".length)) {
      this.pos += "Infinity".length;
      return negative ? -Infinity : Infinity;
    }
    if (this.source.startsWith("NaN", this.pos) && !this.identifierContinuesAt(this.pos + "NaN".length)) {
      this.pos += "NaN".length;
      return negative ? -NaN : NaN;
    }
    if (start === undefined) throw syntax("Unexpected end of input");
    throw syntax("Unexpected character");
  }

  identifierContinuesAt(index) {
    if (index >= this.source.length) return false;
    const info = this.source.codePointAt(index);
    return isIdentifierPart(String.fromCodePoint(info)) || this.source[index] === "\\";
  }

  scanString() {
    const quote = this.current();
    this.pos += 1;
    let out = "";
    while (this.pos < this.source.length) {
      const char = this.current();
      if (char === quote) {
        this.pos += 1;
        return out;
      }
      if (char === "\\") {
        this.pos += 1;
        out += this.parseEscapeSequence();
        continue;
      }
      if (char === "\n" || char === "\r") throw syntax("Unterminated string");
      const read = this.readChar();
      out += read.char;
      this.pos += read.length;
    }
    throw syntax("Unterminated string");
  }

  parseEscapeSequence() {
    if (this.pos >= this.source.length) throw syntax("Unexpected end of input in escape sequence");
    const char = this.current();
    this.pos += 1;
    switch (char) {
      case "'": return "'";
      case "\"": return "\"";
      case "\\": return "\\";
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "v": return "\v";
      case "0":
        if (this.current() >= "0" && this.current() <= "9") throw syntax("Octal escape sequences are not allowed in JSON5");
        return "\0";
      case "x": {
        const hi = this.current();
        const lo = this.source[this.pos + 1];
        if (!isHex(hi) || !isHex(lo)) throw syntax("Invalid hex escape");
        this.pos += 2;
        return String.fromCharCode((hexValue(hi) << 4) | hexValue(lo));
      }
      case "u": {
        const codePoint = this.readUnicodeEscape();
        if (codePoint >= 0xd800 && codePoint <= 0xdbff && this.source[this.pos] === "\\" && this.source[this.pos + 1] === "u") {
          const save = this.pos;
          this.pos += 2;
          const low = this.readUnicodeEscape();
          if (low >= 0xdc00 && low <= 0xdfff) {
            return String.fromCodePoint(0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00));
          }
          this.pos = save;
        }
        return String.fromCodePoint(codePoint);
      }
      case "\r":
        if (this.current() === "\n") this.pos += 1;
        return "";
      case "\n":
      case "\u2028":
      case "\u2029":
        return "";
      default:
        if (char >= "1" && char <= "9") throw syntax("Octal escape sequences are not allowed in JSON5");
        return char;
    }
  }

  readUnicodeEscape() {
    const hex = this.source.slice(this.pos, this.pos + 4);
    if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) throw syntax("Invalid unicode escape: expected 4 hex digits");
    this.pos += 4;
    return Number.parseInt(hex, 16);
  }

  scanNumber() {
    const start = this.pos;
    if (this.current() === "0") {
      const next = this.source[this.pos + 1];
      if (next === "x" || next === "X") return this.scanHexNumber();
      if (next >= "0" && next <= "9") throw syntax("Leading zeros are not allowed in JSON5");
    }
    let hasDigits = false;
    while (this.current() >= "0" && this.current() <= "9") {
      this.pos += 1;
      hasDigits = true;
    }
    if (this.current() === ".") {
      this.pos += 1;
      let fractionDigits = false;
      while (this.current() >= "0" && this.current() <= "9") {
        this.pos += 1;
        fractionDigits = true;
      }
      if (!hasDigits && !fractionDigits) throw syntax("Invalid number");
      hasDigits = true;
    }
    if (!hasDigits) throw syntax("Invalid number");
    if (this.current() === "e" || this.current() === "E") {
      this.pos += 1;
      if (this.current() === "+" || this.current() === "-") this.pos += 1;
      if (!(this.current() >= "0" && this.current() <= "9")) throw syntax("Invalid number");
      while (this.current() >= "0" && this.current() <= "9") this.pos += 1;
    }
    const value = Number(this.source.slice(start, this.pos));
    if (Number.isNaN(value)) throw syntax("Invalid number");
    return value;
  }

  scanHexNumber() {
    this.pos += 2;
    const start = this.pos;
    while (isHex(this.current())) this.pos += 1;
    if (this.pos === start) throw syntax("Invalid hex number");
    const digits = this.source.slice(start, this.pos);
    const value = BigInt(`0x${digits}`);
    if (value > 0xffffffffffffffffn) throw syntax("Invalid hex number");
    return Number(value);
  }

  scanIdentifier() {
    let out = "";
    const first = this.readIdentifierCodePoint(true);
    out += String.fromCodePoint(first);
    while (this.pos < this.source.length) {
      if (this.current() === "\\") {
        out += String.fromCodePoint(this.readIdentifierCodePoint(false));
        continue;
      }
      const read = this.readChar();
      if (!read || !isIdentifierPart(read.char)) {
        break;
      }
      this.pos += read.length;
      out += read.char;
    }
    return out;
  }

  readIdentifierCodePoint(start) {
    if (this.current() === "\\") {
      this.pos += 1;
      if (this.current() !== "u") throw syntax("Invalid unicode escape: expected 4 hex digits");
      this.pos += 1;
      const codePoint = this.readUnicodeEscape();
      const char = String.fromCodePoint(codePoint);
      if (start ? !isIdentifierStart(char) : !isIdentifierPart(char)) throw syntax("Invalid identifier start character");
      return codePoint;
    }
    const read = this.readChar();
    if (!read) throw syntax("Invalid identifier start character");
    if (start ? !isIdentifierStart(read.char) : !isIdentifierPart(read.char)) throw syntax("Invalid identifier start character");
    this.pos += read.length;
    return read.codePoint;
  }

  parse() {
    this.scan();
    const value = this.parseValue();
    if (this.token.type !== "eof") throw syntax("Unexpected token after JSON5 value");
    return value;
  }

  parseValue() {
    switch (this.token.type) {
      case "left_brace": return this.parseObject();
      case "left_bracket": return this.parseArray();
      case "string": {
        const value = this.token.value;
        this.scan();
        return value;
      }
      case "number": {
        const value = this.token.value;
        this.scan();
        return value;
      }
      case "boolean": {
        const value = this.token.value;
        this.scan();
        return value;
      }
      case "null":
        this.scan();
        return null;
      case "identifier": {
        const name = this.token.value;
        if (name === "NaN") {
          this.scan();
          return NaN;
        }
        if (name === "Infinity") {
          this.scan();
          return Infinity;
        }
        throw syntax("Unexpected token");
      }
      case "eof":
        throw syntax("Unexpected end of input");
      default:
        throw syntax("Unexpected token");
    }
  }

  parseObject() {
    const object = {};
    this.scan();
    while (this.token.type !== "right_brace") {
      const key = this.parseObjectKey();
      if (this.token.type !== "colon") throw syntax("Expected ':' after object key");
      this.scan();
      object[key] = this.parseValue();
      if (this.token.type === "comma") {
        this.scan();
      } else if (this.token.type === "right_brace") {
        break;
      } else if (this.token.type === "eof") {
        throw syntax("Unterminated object");
      } else {
        throw syntax(this.canStartValue(this.token.type) ? "Expected ','" : "Expected '}'");
      }
    }
    this.scan();
    return object;
  }

  parseObjectKey() {
    switch (this.token.type) {
      case "string":
      case "identifier": {
        const value = this.token.value;
        this.scan();
        return String(value);
      }
      case "boolean": {
        const value = String(this.token.value);
        this.scan();
        return value;
      }
      case "null":
        this.scan();
        return "null";
      case "number":
        throw syntax("Invalid identifier start character");
      case "eof":
        throw syntax("Unexpected end of input");
      default:
        throw syntax("Invalid identifier start character");
    }
  }

  parseArray() {
    const array = [];
    this.scan();
    while (this.token.type !== "right_bracket") {
      array.push(this.parseValue());
      if (this.token.type === "comma") {
        this.scan();
      } else if (this.token.type === "right_bracket") {
        break;
      } else if (this.token.type === "eof") {
        throw syntax("Unterminated array");
      } else {
        throw syntax(this.canStartValue(this.token.type) ? "Expected ','" : "Expected ']'");
      }
    }
    this.scan();
    return array;
  }

  canStartValue(type) {
    return type === "string" || type === "number" || type === "boolean" ||
      type === "identifier" || type === "null" || type === "left_brace" || type === "left_bracket";
  }
}

export function parse(value) {
  return new JSON5Parser(textInput(value)).parse();
}

function spaceFromValue(space) {
  if (typeof space === "number" || space instanceof Number) {
    const number = Number(space);
    if (!(number >= 1)) return "";
    return " ".repeat(Math.min(10, Math.trunc(number)));
  }
  if (typeof space === "string" || space instanceof String) {
    return String(space).slice(0, 10);
  }
  return "";
}

function quoteString(value) {
  let out = "'";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x00: out += "\\0"; break;
      case 0x08: out += "\\b"; break;
      case 0x09: out += "\\t"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0b: out += "\\v"; break;
      case 0x0c: out += "\\f"; break;
      case 0x0d: out += "\\r"; break;
      case 0x27: out += "\\'"; break;
      case 0x5c: out += "\\\\"; break;
      case 0x2028: out += "\\u2028"; break;
      case 0x2029: out += "\\u2029"; break;
      default:
        if ((code >= 0x01 && code <= 0x07) || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
          out += `\\x${code.toString(16).padStart(2, "0")}`;
        } else {
          out += value[index];
        }
    }
  }
  return `${out}'`;
}

function stringifyKey(key) {
  return isIdentifierName(key) ? key : quoteString(key);
}

function stringifyValue(value, gap, indent, seen) {
  if (value instanceof Number || value instanceof String || value instanceof Boolean) value = value.valueOf();
  if (value === null) return "null";
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") return undefined;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return quoteString(value);
  if (typeof value === "bigint") throw new TypeError("JSON5.stringify cannot serialize BigInt");
  if (seen.has(value)) throw new TypeError("Converting circular structure to JSON5");
  seen.add(value);
  try {
    if (Array.isArray(value)) return stringifyArray(value, gap, indent, seen);
    return stringifyObject(value, gap, indent, seen);
  } finally {
    seen.delete(value);
  }
}

function stringifyArray(value, gap, indent, seen) {
  if (value.length === 0) return "[]";
  const nextIndent = indent + gap;
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    items.push(stringifyValue(value[index], gap, nextIndent, seen) ?? "null");
  }
  if (!gap) return `[${items.join(",")}]`;
  return `[\n${nextIndent}${items.join(`,\n${nextIndent}`)},\n${indent}]`;
}

function stringifyObject(value, gap, indent, seen) {
  const entries = [];
  for (const key of Object.keys(value)) {
    const item = stringifyValue(value[key], gap, indent + gap, seen);
    if (item !== undefined) entries.push([key, item]);
  }
  if (entries.length === 0) return "{}";
  if (!gap) return `{${entries.map(([key, item]) => `${stringifyKey(key)}:${item}`).join(",")}}`;
  const nextIndent = indent + gap;
  return `{\n${entries.map(([key, item]) => `${nextIndent}${stringifyKey(key)}: ${item}`).join(",\n")},\n${indent}}`;
}

export function stringify(value, replacer = undefined, space = undefined) {
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") return undefined;
  if (replacer != null) throw new TypeError("JSON5.stringify does not support the replacer argument");
  return stringifyValue(value, spaceFromValue(space), "", new Set());
}

export const JSON5 = {
  parse,
  stringify,
};

export default JSON5;
