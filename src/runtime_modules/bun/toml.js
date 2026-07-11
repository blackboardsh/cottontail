function textInput(value) {
  if (value == null) throw new TypeError("Expected a string to parse");
  if (typeof value === "string") return value;
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  return String(value);
}

function stripComment(line) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === "\"" && escaped) escaped = false;
      else if (quote === "\"" && char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#") return line.slice(0, index);
  }
  return line;
}

function findEquals(line) {
  let quote = "";
  let escaped = false;
  let square = 0;
  let curly = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (quote === "\"" && escaped) escaped = false;
      else if (quote === "\"" && char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "[") square += 1;
    else if (char === "]") square -= 1;
    else if (char === "{") curly += 1;
    else if (char === "}") curly -= 1;
    else if (char === "=" && square === 0 && curly === 0) return index;
  }
  return -1;
}

class TOMLValueParser {
  constructor(source, depth = 0) {
    this.source = String(source);
    this.pos = 0;
    this.depth = depth;
    if (depth > 10_000) throw new RangeError("Maximum TOML nesting depth exceeded");
  }

  current() {
    return this.source[this.pos];
  }

  skipSpace() {
    while (this.current() === " " || this.current() === "\t" || this.current() === "\r" || this.current() === "\n") this.pos += 1;
  }

  parse() {
    this.skipSpace();
    const value = this.parseValue();
    this.skipSpace();
    if (this.pos < this.source.length) throw new SyntaxError("Invalid TOML value");
    return value;
  }

  parseValue() {
    this.skipSpace();
    const char = this.current();
    if (char === "\"") return this.parseBasicString();
    if (char === "'") return this.parseLiteralString();
    if (char === "[") return this.parseArray();
    if (char === "{") return this.parseInlineTable();
    return this.parseBareValue();
  }

  parseBasicString() {
    const start = this.pos;
    this.pos += 1;
    let escaped = false;
    while (this.pos < this.source.length) {
      const char = this.current();
      this.pos += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") return JSON.parse(this.source.slice(start, this.pos));
    }
    throw new SyntaxError("Unterminated TOML string");
  }

  parseLiteralString() {
    this.pos += 1;
    const start = this.pos;
    while (this.pos < this.source.length) {
      if (this.current() === "'") {
        const value = this.source.slice(start, this.pos);
        this.pos += 1;
        return value;
      }
      this.pos += 1;
    }
    throw new SyntaxError("Unterminated TOML string");
  }

  parseArray() {
    this.pos += 1;
    const out = [];
    for (;;) {
      this.skipSpace();
      if (this.current() === "]") {
        this.pos += 1;
        return out;
      }
      out.push(this.parseValue());
      this.skipSpace();
      if (this.current() === ",") {
        this.pos += 1;
        continue;
      }
      if (this.current() === "]") {
        this.pos += 1;
        return out;
      }
      throw new SyntaxError("Expected ',' or ']'");
    }
  }

  parseInlineTable() {
    this.depth += 1;
    if (this.depth > 10_000) throw new RangeError("Maximum TOML nesting depth exceeded");
    this.pos += 1;
    const out = {};
    try {
      for (;;) {
        this.skipSpace();
        if (this.current() === "}") {
          this.pos += 1;
          return out;
        }
        const key = this.parseKeyPath();
        this.skipSpace();
        if (this.current() !== "=") throw new SyntaxError("Expected '='");
        this.pos += 1;
        assignPath(out, key, this.parseValue());
        this.skipSpace();
        if (this.current() === ",") {
          this.pos += 1;
          continue;
        }
        if (this.current() === "}") {
          this.pos += 1;
          return out;
        }
        throw new SyntaxError("Expected ',' or '}'");
      }
    } finally {
      this.depth -= 1;
    }
  }

  parseKeyPath() {
    const parts = [];
    for (;;) {
      this.skipSpace();
      parts.push(this.parseKeySegment());
      this.skipSpace();
      if (this.current() !== ".") return parts;
      this.pos += 1;
    }
  }

  parseKeySegment() {
    this.skipSpace();
    if (this.current() === "\"") return this.parseBasicString();
    if (this.current() === "'") return this.parseLiteralString();
    const start = this.pos;
    while (this.pos < this.source.length) {
      const char = this.current();
      if (char === "." || char === "=" || char === "," || char === "}" || char === "]" || char === " " || char === "\t") break;
      this.pos += 1;
    }
    const key = this.source.slice(start, this.pos).trim();
    if (!key) throw new SyntaxError("Invalid TOML key");
    return key;
  }

  parseBareValue() {
    const start = this.pos;
    while (this.pos < this.source.length) {
      const char = this.current();
      if (char === "," || char === "]" || char === "}") break;
      this.pos += 1;
    }
    const token = this.source.slice(start, this.pos).trim();
    if (token === "true") return true;
    if (token === "false") return false;
    const normalized = token.replace(/_/g, "");
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized) || /^[+-]?\d+$/.test(normalized)) {
      return Number(normalized);
    }
    throw new SyntaxError(`Invalid TOML value: ${token}`);
  }
}

function parseKeyPath(source) {
  const parser = new TOMLValueParser(source);
  const parts = parser.parseKeyPath();
  parser.skipSpace();
  if (parser.pos !== parser.source.length) throw new SyntaxError("Invalid TOML key");
  return parts;
}

function targetForPath(root, parts) {
  let target = root;
  for (const part of parts) {
    if (Array.isArray(target[part])) {
      if (target[part].length === 0) target[part].push({});
      target = target[part][target[part].length - 1];
      continue;
    }
    if (target[part] == null) target[part] = {};
    if (typeof target[part] !== "object") throw new SyntaxError("TOML key conflicts with existing scalar");
    target = target[part];
  }
  return target;
}

function assignPath(root, parts, value) {
  const target = targetForPath(root, parts.slice(0, -1));
  target[parts[parts.length - 1]] = value;
}

function createArrayTable(root, parts) {
  const parent = targetForPath(root, parts.slice(0, -1));
  const key = parts[parts.length - 1];
  if (parent[key] == null) parent[key] = [];
  if (!Array.isArray(parent[key])) throw new SyntaxError("TOML array table conflicts with existing value");
  const table = {};
  parent[key].push(table);
  return table;
}

export function parse(input) {
  const root = {};
  let current = root;
  for (const rawLine of textInput(input).split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    if (line.startsWith("[[") && line.endsWith("]]")) {
      current = createArrayTable(root, parseKeyPath(line.slice(2, -2).trim()));
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      current = targetForPath(root, parseKeyPath(line.slice(1, -1).trim()));
      continue;
    }
    const equals = findEquals(line);
    if (equals <= 0) throw new SyntaxError("Invalid TOML assignment");
    const key = parseKeyPath(line.slice(0, equals).trim());
    const value = new TOMLValueParser(line.slice(equals + 1), 0).parse();
    assignPath(current, key, value);
  }
  return root;
}

export function stringify(value) {
  return Object.entries(value ?? {}).map(([key, item]) => `${key} = ${JSON.stringify(item)}`).join("\n");
}

export const TOML = {
  parse,
  stringify,
};

export default TOML;
