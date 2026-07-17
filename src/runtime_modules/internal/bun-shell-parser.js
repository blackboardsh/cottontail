// Source-led JavaScript port of the grammar in src/compiler/src/shell/shell.zig.
// The AST is intentionally runtime-oriented: quote information remains on words
// so expansion happens against the shell state immediately before execution.

function syntax(message, position) {
  const error = new SyntaxError(message);
  error.position = position;
  return error;
}

function decodeAnsiCString(source) {
  let output = "";
  for (let index = 0; index < source.length;) {
    if (source[index] !== "\\") {
      output += source[index++];
      continue;
    }

    const escaped = source[index + 1];
    if (escaped == null) {
      output += "\\";
      break;
    }
    index += 2;
    if (escaped === "x") {
      const match = /^[\da-fA-F]{1,2}/.exec(source.slice(index));
      if (!match) {
        output += "\\x";
        continue;
      }
      output += String.fromCharCode(Number.parseInt(match[0], 16));
      index += match[0].length;
      continue;
    }
    if (escaped === "u" || escaped === "U") {
      const width = escaped === "u" ? 4 : 8;
      const match = new RegExp(`^[\\da-fA-F]{${width}}`).exec(source.slice(index));
      if (!match) {
        output += `\\${escaped}`;
        continue;
      }
      const codePoint = Number.parseInt(match[0], 16);
      output += codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : "\ufffd";
      index += width;
      continue;
    }
    if (/[0-7]/.test(escaped)) {
      const tail = /^[0-7]{0,2}/.exec(source.slice(index))?.[0] ?? "";
      output += String.fromCharCode(Number.parseInt(escaped + tail, 8));
      index += tail.length;
      continue;
    }
    if (escaped === "c" && source[index] != null) {
      output += String.fromCharCode(source.charCodeAt(index++) & 0x1f);
      continue;
    }
    output += ({
      a: "\x07",
      b: "\b",
      e: "\x1b",
      E: "\x1b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
      "?": "?",
    })[escaped] ?? escaped;
  }
  return output;
}

function appendPart(parts, text, quote, expand = quote !== "single") {
  const previous = parts[parts.length - 1];
  if (previous && previous.quote === quote && previous.expand === expand) previous.text += text;
  else parts.push({ text, quote, expand });
}

function readBalancedSubstitution(source, start) {
  let index = start + 2;
  let depth = 1;
  let quote = null;
  let escaped = false;
  while (index < source.length) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return index + 1;
    index += 1;
  }
  throw syntax("Unclosed command substitution", start);
}

function readBacktick(source, start) {
  let index = start + 1;
  let escaped = false;
  while (index < source.length) {
    const char = source[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === "`") return index + 1;
    index += 1;
  }
  throw syntax("Unclosed command substitution", start);
}

function operatorAt(source, index, atWordStart) {
  for (const operator of ["2>&1", "1>&2", ">&2", ">&1", "0<<", "0>>", "0<", "0>", "&>>", "&>", "2>>", "1>>", ">>", "2>", "1>", "<<", "&&", "||", ";;", "|&"]) {
    if (source.startsWith(operator, index)) return operator;
  }
  const char = source[index];
  if (";|()<>&".includes(char)) return char;
  if (char === "\n") return ";";
  if (atWordStart && char === "!" && " \t\r\n({[".includes(source[index + 1] ?? " ")) return "!";
  if (atWordStart && char === "{" && /\s/.test(source[index + 1] ?? " ")) return "{";
  if (atWordStart && char === "}" && /(?:\s|[;&|<>])/.test(source[index + 1] ?? " ")) return "}";
  if (atWordStart && /[012]/.test(char) && source[index + 1] === ">") return `${char}>`;
  return null;
}

export function lexShell(source) {
  source = String(source);
  const tokens = [];
  let index = 0;
  let wordStart = true;

  while (index < source.length) {
    const char = source[index];
    if (char === " " || char === "\t" || char === "\r") {
      index += 1;
      wordStart = true;
      continue;
    }
    if (char === "#" && wordStart) {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    const operator = operatorAt(source, index, true);
    if (operator) {
      tokens.push({ type: "op", value: operator, position: index });
      index += char === "\n" ? 1 : operator.length;
      wordStart = true;
      continue;
    }

    const position = index;
    const parts = [];
    const raw = [];
    while (index < source.length) {
      const current = source[index];
      if (/\s/.test(current) || operatorAt(source, index, false)) break;
      if (current === "\\") {
        if (source[index + 1] === "\n") {
          index += 2;
          continue;
        }
        const next = source[index + 1];
        if (next == null) {
          appendPart(parts, "\\", "literal", false);
          raw.push("\\");
          index += 1;
        } else {
          appendPart(parts, next, "literal", false);
          raw.push(source.slice(index, index + 2));
          index += 2;
        }
        continue;
      }
      if (current === "'" || current === '"') {
        const quote = current;
        const quoteName = quote === "'" ? "single" : "double";
        const quoteStart = index++;
        raw.push(quote);
        const text = [];
        let emitted = false;
        const flushQuotedText = () => {
          if (text.length === 0) return;
          appendPart(parts, text.join(""), quoteName, quoteName !== "single");
          text.length = 0;
          emitted = true;
        };
        while (index < source.length && source[index] !== quote) {
          if (quote === '"' && source[index] === "\\" && /[$`"\\\n]/.test(source[index + 1] ?? "")) {
            flushQuotedText();
            if (source[index + 1] !== "\n") {
              appendPart(parts, source[index + 1], quoteName, false);
              emitted = true;
            }
            raw.push(source.slice(index, index + 2));
            index += 2;
            continue;
          }
          if (quote === '"' && source.startsWith("$(", index)) {
            const end = readBalancedSubstitution(source, index);
            const chunk = source.slice(index, end);
            text.push(chunk);
            raw.push(chunk);
            index = end;
            continue;
          }
          if (quote === '"' && source[index] === "`") {
            const end = readBacktick(source, index);
            const chunk = source.slice(index, end);
            text.push(chunk);
            raw.push(chunk);
            index = end;
            continue;
          }
          const chunkStart = index;
          while (index < source.length && source[index] !== quote) {
            if (quote === '"' && source[index] === "\\" && /[$`"\\\n]/.test(source[index + 1] ?? "")) break;
            if (quote === '"' && (source.startsWith("$(", index) || source[index] === "`")) break;
            index += 1;
          }
          const chunk = source.slice(chunkStart, index);
          text.push(chunk);
          raw.push(chunk);
        }
        if (index >= source.length) throw syntax(`Unterminated ${quoteName} quote`, quoteStart);
        raw.push(source[index++]);
        flushQuotedText();
        if (!emitted) appendPart(parts, "", quoteName, quoteName !== "single");
        continue;
      }
      if (current === "$" && source[index + 1] === "'") {
        const quoteStart = index;
        index += 2;
        const text = [];
        while (index < source.length && source[index] !== "'") {
          if (source[index] === "\\" && index + 1 < source.length) {
            text.push(source.slice(index, index + 2));
            index += 2;
            continue;
          }
          const chunkStart = index;
          while (index < source.length && source[index] !== "'" && source[index] !== "\\") index += 1;
          text.push(source.slice(chunkStart, index));
        }
        if (index >= source.length) throw syntax("Unterminated ANSI-C quote", quoteStart);
        index += 1;
        raw.push(source.slice(quoteStart, index));
        appendPart(parts, decodeAnsiCString(text.join("")), "single", false);
        continue;
      }
      if (source.startsWith("$(", index)) {
        const end = readBalancedSubstitution(source, index);
        const chunk = source.slice(index, end);
        appendPart(parts, chunk, "unquoted", true);
        raw.push(chunk);
        index = end;
        continue;
      }
      if (current === "`") {
        const end = readBacktick(source, index);
        const chunk = source.slice(index, end);
        appendPart(parts, chunk, "unquoted", true);
        raw.push(chunk);
        index = end;
        continue;
      }
      const chunkStart = index;
      while (index < source.length) {
        const chunkCharacter = source[index];
        if (/\s/.test(chunkCharacter) || operatorAt(source, index, false)) break;
        if (chunkCharacter === "\\" || chunkCharacter === "'" || chunkCharacter === '"' || chunkCharacter === "`") break;
        if (chunkCharacter === "$" && (source[index + 1] === "'" || source[index + 1] === "(")) break;
        index += 1;
      }
      const chunk = source.slice(chunkStart, index);
      appendPart(parts, chunk, "unquoted", true);
      raw.push(chunk);
    }
    if (parts.length === 0) {
      if (index > position) continue;
      throw syntax(`Unexpected token: \`${source[index]}\``, index);
    }
    tokens.push({ type: "word", parts, raw: raw.join(""), position });
    wordStart = false;
  }

  tokens.push({ type: "eof", value: "", position: source.length });
  return tokens;
}

const REDIRECTS = new Set(["<", "<<", "0<", "0<<", "0>", "0>>", ">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>", "2>&1", "1>&2", ">&2", ">&1"]);

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }
  peek(offset = 0) { return this.tokens[this.index + offset] ?? this.tokens[this.tokens.length - 1]; }
  take() { return this.tokens[this.index++]; }
  isOp(value) { return this.peek().type === "op" && this.peek().value === value; }
  isWord(value) { return this.peek().type === "word" && this.peek().raw === value; }
  consumeOp(value) { if (!this.isOp(value)) return false; this.index += 1; return true; }
  consumeWord(value) { if (!this.isWord(value)) return false; this.index += 1; return true; }
  skipSeparators() { while (this.consumeOp(";")) {} }

  parse(stopWords = new Set(), stopOperators = new Set()) {
    const items = [];
    this.skipSeparators();
    while (!this.isStop(stopWords, stopOperators)) {
      const item = this.parseAndOr();
      if (this.isOp("&")) {
        const background = this.take();
        throw syntax('Background commands "&" are not supported yet.', background.position);
      }
      items.push(item);
      if (!this.consumeOp(";")) {
        if (!this.isStop(stopWords, stopOperators)) {
          if (this.isOp(")")) throw syntax("Unexpected ')'", this.peek().position);
          throw syntax(`Unexpected token: \`${this.peek().raw ?? this.peek().value}\``, this.peek().position);
        }
      }
      this.skipSeparators();
    }
    return { type: "script", items };
  }

  isStop(stopWords, stopOperators) {
    const token = this.peek();
    return token.type === "eof"
      || (token.type === "op" && stopOperators.has(token.value))
      || (token.type === "word" && stopWords.has(token.raw));
  }

  parseAndOr() {
    let node = this.parsePipeline();
    while (this.isOp("&&") || this.isOp("||")) {
      const operator = this.take().value;
      this.skipSeparators();
      node = { type: "binary", operator, left: node, right: this.parsePipeline() };
    }
    return node;
  }

  parsePipeline() {
    const items = [this.parseNegated()];
    while (this.isOp("|") || this.isOp("|&")) {
      if (this.isOp("|&")) throw new Error("Piping stdout and stderr (`|&`) is not supported yet. Please file an issue on GitHub.");
      this.take();
      this.skipSeparators();
      items.push(this.parseNegated());
    }
    return items.length === 1 ? items[0] : { type: "pipeline", items };
  }

  parseNegated() {
    let inverted = false;
    while (this.consumeOp("!")) {
      inverted = !inverted;
      this.skipSeparators();
    }
    const command = this.parseCommand();
    return inverted ? { type: "negate", command } : command;
  }

  parseCommand() {
    const assignmentStart = this.index;
    const assignments = [];
    while (this.peek().type === "word" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(this.peek().raw)) {
      assignments.push(this.take());
    }
    if (assignments.length && this.consumeWord("[[")) {
      return { type: "assignmentPrefix", assignments, command: this.parseConditional() };
    }
    this.index = assignmentStart;

    if (this.consumeOp("(")) {
      const script = this.parse(new Set(), new Set([")"]));
      if (!this.consumeOp(")")) throw syntax("Unclosed subshell", this.peek().position);
      const redirectPosition = this.peek().position;
      const redirects = this.parseRedirects();
      if (redirects.length > 0) {
        throw syntax("Subshells with redirections are currently not supported. Please open a GitHub issue.", redirectPosition);
      }
      return { type: "subshell", script, redirects };
    }
    if (this.consumeOp("{")) {
      const script = this.parse(new Set(), new Set(["}"]));
      if (!this.consumeOp("}")) throw syntax("Expected `}`", this.peek().position);
      return { type: "group", script, redirects: this.parseRedirects() };
    }
    if (this.consumeWord("if")) return this.parseIf();
    if (this.consumeWord("[[")) {
      const conditional = this.parseConditional();
      conditional.redirects = this.parseRedirects();
      return conditional;
    }
    return this.parseSimple();
  }

  parseIf() {
    const condition = this.parse(new Set(["then"]));
    if (!this.consumeWord("then")) throw syntax("Expected `then`", this.peek().position);
    const consequent = this.parse(new Set(["elif", "else", "fi"]));
    const branches = [{ condition, consequent }];
    while (this.consumeWord("elif")) {
      const branchCondition = this.parse(new Set(["then"]));
      if (!this.consumeWord("then")) throw syntax("Expected `then`", this.peek().position);
      branches.push({ condition: branchCondition, consequent: this.parse(new Set(["elif", "else", "fi"])) });
    }
    const alternate = this.consumeWord("else") ? this.parse(new Set(["fi"])) : null;
    if (!this.consumeWord("fi")) throw syntax("Expected `fi`", this.peek().position);
    return { type: "if", branches, alternate, redirects: this.parseRedirects() };
  }

  parseConditional() {
    const words = [];
    while (!this.isWord("]]")) {
      if (this.peek().type === "eof") throw syntax("Expected `]]`", this.peek().position);
      words.push(this.take());
    }
    this.take();
    return { type: "conditional", words };
  }

  parseRedirects() {
    const redirects = [];
    while (this.peek().type === "op" && REDIRECTS.has(this.peek().value)) {
      const operator = this.take();
      if (["2>&1", "1>&2", ">&2", ">&1"].includes(operator.value)) {
        redirects.push({ operator: operator.value, target: null });
        continue;
      }
      const target = this.peek();
      if (target.type !== "word") throw syntax("Redirection with no file", operator.position);
      redirects.push({ operator: operator.value, target: this.take() });
    }
    return redirects;
  }

  parseSimple() {
    const words = [];
    const redirects = [];
    while (true) {
      const token = this.peek();
      if (token.type === "word") {
        words.push(this.take());
        continue;
      }
      if (token.type === "op" && REDIRECTS.has(token.value)) {
        redirects.push(...this.parseRedirects());
        continue;
      }
      break;
    }
    if (words.length === 0 && redirects.length === 0) {
      if (this.peek().type === "eof") throw syntax("Unexpected EOF", this.peek().position);
      if (this.isOp(")")) throw syntax("Unexpected ')'", this.peek().position);
      throw syntax(`Unexpected token: \`${this.peek().raw ?? this.peek().value}\``, this.peek().position);
    }
    return { type: "command", words, redirects };
  }
}

export function parseShell(source) {
  const parser = new Parser(lexShell(source));
  const script = parser.parse();
  if (parser.peek().type !== "eof") {
    if (parser.isOp(")")) throw syntax("Unexpected ')'", parser.peek().position);
    throw syntax(`Unexpected token: \`${parser.peek().value}\``, parser.peek().position);
  }
  return script;
}

const TEST_JS_OBJECT_PREFIX = "\b__bun_";
const TEST_JS_STRING_PREFIX = "\b__bunstr_";
const TEST_WORD_TOKENS = new Set([
  "Var",
  "VarArgv",
  "Text",
  "SingleQuotedText",
  "DoubleQuotedText",
  "BraceBegin",
  "Comma",
  "BraceEnd",
  "CmdSubstEnd",
  "Asterisk",
  "DoubleAsterisk",
]);

function testingRedirect(overrides = {}) {
  return {
    stdin: false,
    stdout: false,
    stderr: false,
    append: false,
    duplicate_out: false,
    __unused: 0,
    ...overrides,
  };
}

function isTestingObjectReference(value) {
  if (value == null || typeof value !== "object") return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  const constructorName = value.constructor?.name;
  return constructorName === "Blob"
    || constructorName === "Response"
    || constructorName === "ReadableStream";
}

function testingStringNeedsMarker(value) {
  return value.length === 0 || /[~[\]#;\n*{},`$=()0-9|><&'" \\\b]/.test(value);
}

function buildTestingShellSource(strings, values) {
  const raw = strings?.raw ?? strings;
  if (!raw || typeof raw.length !== "number") {
    throw new TypeError("shellInternals expects to be called as a template tag");
  }

  const objectRefs = [];
  const stringRefs = [];
  let source = "";

  const appendString = value => {
    const string = String(value);
    if (string.includes("\0")) {
      throw new TypeError("The shell argument must be a string without null bytes");
    }
    if (!testingStringNeedsMarker(string)) {
      source += string;
      return;
    }
    const index = stringRefs.push(string) - 1;
    source += `${TEST_JS_STRING_PREFIX}${index}`;
  };

  const appendValue = value => {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) source += " ";
        appendValue(value[index]);
      }
      return;
    }
    if (isTestingObjectReference(value)) {
      const index = objectRefs.push(value) - 1;
      source += `${TEST_JS_OBJECT_PREFIX}${index}`;
      return;
    }
    if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "raw") && value.raw) {
      const rawValue = String(value.raw);
      if (rawValue.includes("\0")) {
        throw new TypeError("The shell argument must be a string without null bytes");
      }
      source += rawValue;
      return;
    }
    if (value == null || typeof value !== "object") {
      appendString(value);
      return;
    }
    if (value.toString !== Object.prototype.toString) {
      appendString(value);
      return;
    }
    throw new TypeError("Invalid JS object used in shell, you might need to call `.toString()` on it");
  };

  for (let index = 0; index < raw.length; index += 1) {
    source += String(raw[index]);
    if (index < values.length) appendValue(values[index]);
  }
  return { source, objectRefs, stringRefs };
}

class TestingShellLexer {
  constructor(source, objectRefs, stringRefs) {
    this.source = source;
    this.objectRefs = objectRefs;
    this.stringRefs = stringRefs;
    this.tokens = [];
    this.index = 0;
    this.state = "normal";
    this.text = "";
    this.quoteTokenStart = 0;
  }

  emit(tag, value) {
    this.tokens.push(value === undefined ? { tag } : { tag, value });
  }

  lastTag() {
    return this.tokens.at(-1)?.tag;
  }

  appendDelimiter() {
    if (this.lastTag() !== "Delimit") this.emit("Delimit");
  }

  breakWord(addDelimiter, boundary = false, forceEmpty = false) {
    if (this.text.length > 0 || forceEmpty) {
      const tag = this.state === "double"
        ? "DoubleQuotedText"
        : this.state === "single" ? "SingleQuotedText" : "Text";
      this.emit(tag, this.text);
      this.text = "";
      if (addDelimiter) this.appendDelimiter();
      return;
    }
    if (boundary && TEST_WORD_TOKENS.has(this.lastTag())) this.appendDelimiter();
  }

  readMarker(prefix, refs) {
    if (!this.source.startsWith(prefix, this.index)) return null;
    let end = this.index + prefix.length;
    while (/\d/.test(this.source[end] ?? "")) end += 1;
    if (end === this.index + prefix.length) return null;
    const refIndex = Number(this.source.slice(this.index + prefix.length, end));
    if (!Number.isSafeInteger(refIndex) || refIndex < 0 || refIndex >= refs.length) {
      throw syntax(`Invalid ${prefix === TEST_JS_OBJECT_PREFIX ? "JS object" : "JS string"} ref (out of bounds)`, this.index);
    }
    this.index = end;
    return refIndex;
  }

  handleMarker() {
    const stringIndex = this.readMarker(TEST_JS_STRING_PREFIX, this.stringRefs);
    if (stringIndex != null) {
      this.breakWord(false);
      const value = this.stringRefs[stringIndex];
      if (value.length === 0) this.emit("DoubleQuotedText", "");
      else this.text += value;
      return true;
    }
    const objectIndex = this.readMarker(TEST_JS_OBJECT_PREFIX, this.objectRefs);
    if (objectIndex == null) return false;
    if (this.state === "double") {
      throw syntax("JS object reference not allowed in double quotes", this.index);
    }
    this.breakWord(false);
    this.emit("JSObjRef", objectIndex);
    return true;
  }

  readVariable() {
    const start = this.index + 1;
    const first = this.source[start];
    if (/\d/.test(first ?? "")) {
      this.breakWord(false);
      this.emit("VarArgv", Number(first));
      this.index = start + 1;
      return true;
    }
    if (!/[A-Za-z_]/.test(first ?? "")) return false;
    let end = start + 1;
    while (/[A-Za-z0-9_]/.test(this.source[end] ?? "")) end += 1;
    this.breakWord(false);
    this.emit("Var", this.source.slice(start, end));
    this.index = end;
    return true;
  }

  redirectAt() {
    const rest = this.source.slice(this.index);
    const descriptor = /^([012])>(>?)(?:&([12]))?/.exec(rest);
    if (descriptor) {
      const fd = descriptor[1];
      const duplicate = descriptor[3];
      const flags = testingRedirect({
        stdin: fd === "0",
        stdout: fd === "1",
        stderr: fd === "2",
        append: descriptor[2] === ">",
      });
      if (duplicate) {
        flags.duplicate_out = true;
        if (fd === "1" && duplicate === "2") {
          flags.stdout = false;
          flags.stderr = true;
        } else if (fd === "2" && duplicate === "1") {
          flags.stdout = true;
          flags.stderr = false;
        } else {
          return null;
        }
      }
      return { length: descriptor[0].length, flags };
    }
    if (rest.startsWith("&>>")) return { length: 3, flags: testingRedirect({ stdout: true, stderr: true, append: true }) };
    if (rest.startsWith("&>")) return { length: 2, flags: testingRedirect({ stdout: true, stderr: true }) };
    if (rest.startsWith(">>")) return { length: 2, flags: testingRedirect({ stdout: true, append: true }) };
    if (rest.startsWith("<<")) return { length: 2, flags: testingRedirect({ stdin: true, append: true }) };
    if (rest[0] === ">") return { length: 1, flags: testingRedirect({ stdout: true }) };
    if (rest[0] === "<") return { length: 1, flags: testingRedirect({ stdin: true }) };
    return null;
  }

  scanSubstitution(kind, quoted) {
    this.emit("CmdSubstBegin");
    if (quoted) this.emit("CmdSubstQuoted");
    const outerState = this.state;
    this.state = "normal";
    this.scan(kind);
    this.state = outerState;
    this.emit("CmdSubstEnd");
  }

  closeSubstitution(kind) {
    this.breakWord(true);
    if (kind === "dollar" || kind === "backtick") {
      if (!["Delimit", "Semicolon", "Newline", "Eof"].includes(this.lastTag())) this.appendDelimiter();
    }
  }

  scan(stopKind = null) {
    while (this.index < this.source.length) {
      const char = this.source[this.index];

      if (stopKind === "dollar" && this.state === "normal" && char === ")") {
        this.closeSubstitution(stopKind);
        this.index += 1;
        return;
      }
      if (stopKind === "paren" && this.state === "normal" && char === ")") {
        this.breakWord(true);
        this.index += 1;
        return;
      }
      if (stopKind === "backtick" && this.state !== "single" && char === "`") {
        this.closeSubstitution(stopKind);
        this.index += 1;
        return;
      }

      if (char === "\b" && this.handleMarker()) continue;

      if (char === "\\") {
        const next = this.source[this.index + 1];
        if (next == null) {
          this.text += "\\";
          this.index += 1;
        } else if (next === "\n") {
          this.index += 2;
          if (this.state !== "double") this.breakWord(true, true);
        } else {
          this.text += next;
          this.index += 2;
        }
        continue;
      }

      if (this.state === "single") {
        if (char === "'") {
          const empty = this.tokens.length === this.quoteTokenStart && this.text.length === 0;
          this.breakWord(false, false, empty);
          this.state = "normal";
          this.index += 1;
          if (this.index === this.source.length) this.appendDelimiter();
        } else {
          this.text += char;
          this.index += 1;
        }
        continue;
      }

      if (this.state === "double") {
        if (char === '"') {
          const empty = this.tokens.length === this.quoteTokenStart && this.text.length === 0;
          this.breakWord(false, false, empty);
          this.state = "normal";
          this.index += 1;
          continue;
        }
        if (char === "$" && this.source[this.index + 1] === "(") {
          this.breakWord(false);
          this.index += 2;
          this.scanSubstitution("dollar", true);
          continue;
        }
        if (char === "`" ) {
          this.breakWord(false);
          this.index += 1;
          this.scanSubstitution("backtick", true);
          continue;
        }
        if (char === "$" && this.readVariable()) continue;
        this.text += char;
        this.index += 1;
        continue;
      }

      if (char === " " || char === "\t" || char === "\r") {
        this.breakWord(true, true);
        this.index += 1;
        continue;
      }
      if (char === "\n") {
        this.breakWord(true, true);
        this.emit("Newline");
        this.index += 1;
        continue;
      }
      if (char === "#" && (this.index === 0 || /\s/.test(this.source[this.index - 1]))) {
        this.breakWord(true, true);
        while (this.index < this.source.length && this.source[this.index] !== "\n") this.index += 1;
        continue;
      }
      if (char === "'") {
        this.breakWord(false);
        this.state = "single";
        this.quoteTokenStart = this.tokens.length;
        this.index += 1;
        continue;
      }
      if (char === '"') {
        this.breakWord(false);
        this.state = "double";
        this.quoteTokenStart = this.tokens.length;
        this.index += 1;
        continue;
      }
      if (char === "$" && this.source[this.index + 1] === "(") {
        this.breakWord(false);
        this.index += 2;
        this.scanSubstitution("dollar", false);
        continue;
      }
      if (char === "`") {
        this.breakWord(false);
        this.index += 1;
        this.scanSubstitution("backtick", false);
        continue;
      }
      if (char === "$" && this.readVariable()) continue;

      if (this.source.startsWith("[[", this.index) && /\s/.test(this.source[this.index + 2] ?? " ")) {
        this.breakWord(true, true);
        this.emit("DoubleBracketOpen");
        this.index += 2;
        continue;
      }
      if (this.source.startsWith("]]", this.index) && /(?:\s|[;&|>])/.test(this.source[this.index + 2] ?? " ")) {
        this.breakWord(true, true);
        this.emit("DoubleBracketClose");
        this.index += 2;
        continue;
      }

      const redirect = this.redirectAt();
      if (redirect) {
        this.breakWord(true, true);
        this.emit("Redirect", redirect.flags);
        this.index += redirect.length;
        continue;
      }
      if (this.source.startsWith("&&", this.index)) {
        this.breakWord(true, true);
        this.emit("DoubleAmpersand");
        this.index += 2;
        continue;
      }
      if (this.source.startsWith("||", this.index)) {
        this.breakWord(true, true);
        this.emit("DoublePipe");
        this.index += 2;
        continue;
      }
      if (this.source.startsWith("|&", this.index)) {
        throw syntax("Piping stdout and stderr (`|&`) is not supported yet. Please file an issue on GitHub.", this.index);
      }
      if (char === "|") {
        this.breakWord(true, true);
        this.emit("Pipe");
        this.index += 1;
        continue;
      }
      if (char === "&") {
        this.breakWord(true, true);
        this.emit("Ampersand");
        this.index += 1;
        continue;
      }
      if (char === ";") {
        this.breakWord(true);
        this.emit("Semicolon");
        this.index += 1;
        continue;
      }
      if (char === "(") {
        this.breakWord(true);
        this.emit("OpenParen");
        this.index += 1;
        const outerState = this.state;
        this.state = "normal";
        this.scan("paren");
        this.state = outerState;
        this.emit("CloseParen");
        continue;
      }
      if (char === ")") throw syntax("Unexpected ')'", this.index);
      if (char === "*") {
        this.breakWord(false);
        if (this.source[this.index + 1] === "*") {
          this.emit("DoubleAsterisk");
          this.index += 2;
        } else {
          this.emit("Asterisk");
          this.index += 1;
        }
        continue;
      }
      if (char === "{") {
        this.breakWord(false);
        this.emit("BraceBegin");
        this.index += 1;
        continue;
      }
      if (char === ",") {
        this.breakWord(false);
        this.emit("Comma");
        this.index += 1;
        continue;
      }
      if (char === "}") {
        this.breakWord(false);
        this.emit("BraceEnd");
        this.index += 1;
        continue;
      }

      this.text += char;
      this.index += 1;
    }

    if (this.state === "single" || this.state === "double") {
      throw syntax(`Unterminated ${this.state} quote`, this.index);
    }
    if (stopKind != null) {
      throw syntax(stopKind === "paren" ? "Unclosed subshell" : "Unclosed command substitution", this.index);
    }
    this.breakWord(true);
    this.emit("Eof");
  }
}

function lexTestingShell(strings, values) {
  const built = buildTestingShellSource(strings, values);
  const lexer = new TestingShellLexer(built.source, built.objectRefs, built.stringRefs);
  lexer.scan();
  return lexer.tokens;
}

function serializeTestingToken(token) {
  const tag = token.tag === "SingleQuotedText" ? "Text" : token.tag;
  return { [tag]: token.value === undefined ? {} : token.value };
}

function simpleTestingAtom(tag, value) {
  return { [tag]: value === undefined ? {} : value };
}

function testingAtomParts(atom) {
  return atom.simple ? [atom.simple] : [...atom.compound.atoms];
}

function testingAtomFromParts(parts) {
  if (parts.length === 1) return { simple: parts[0] };
  const tags = parts.map(part => Object.keys(part)[0]);
  return {
    compound: {
      atoms: parts,
      brace_expansion_hint: tags.includes("brace_begin") && tags.includes("brace_end") && tags.includes("comma"),
      glob_hint: tags.includes("asterisk") || tags.includes("double_asterisk"),
    },
  };
}

function mergeTestingAtoms(left, right) {
  return testingAtomFromParts([...testingAtomParts(left), ...testingAtomParts(right)]);
}

class TestingShellParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  peek(offset = 0) {
    return this.tokens[this.index + offset] ?? { tag: "Eof" };
  }

  take() {
    return this.tokens[this.index++];
  }

  is(tag) {
    return this.peek().tag === tag;
  }

  match(tag) {
    if (!this.is(tag)) return false;
    this.index += 1;
    return true;
  }

  isStandaloneWord(word) {
    return this.peek().tag === "Text"
      && this.peek().value === word
      && ["Delimit", "Semicolon", "Newline", "Eof"].includes(this.peek(1).tag);
  }

  consumeStandaloneWord(word) {
    if (!this.isStandaloneWord(word)) return false;
    this.index += 1;
    if (this.is("Delimit")) this.index += 1;
    return true;
  }

  atScriptEnd(stopTags, stopWords) {
    return stopTags.has(this.peek().tag) || [...stopWords].some(word => this.isStandaloneWord(word));
  }

  skipStatementSeparators() {
    while (this.match("Semicolon") || this.match("Newline")) {}
  }

  parseScript(stopTags = new Set(["Eof"]), stopWords = new Set()) {
    const stmts = [];
    this.skipStatementSeparators();
    while (!this.atScriptEnd(stopTags, stopWords)) {
      const expression = this.parseBinary();
      if (this.match("Ampersand")) {
        throw syntax('Background commands "&" are not supported yet.', this.index);
      }
      stmts.push({ exprs: [expression] });
      if (this.atScriptEnd(stopTags, stopWords)) break;
      if (!this.is("Semicolon") && !this.is("Newline")) {
        throw syntax(`Unexpected token: ${this.peek().tag}`, this.index);
      }
      this.skipStatementSeparators();
    }
    return { stmts };
  }

  parseBinary() {
    let left = this.parsePipeline();
    while (this.is("DoubleAmpersand") || this.is("DoublePipe")) {
      const op = this.take().tag === "DoubleAmpersand" ? "And" : "Or";
      left = { binary: { op, left, right: this.parsePipeline() } };
    }
    return left;
  }

  parsePipeline() {
    const first = this.parseCompoundCommand();
    if (!this.is("Pipe")) return first;
    const items = [first];
    while (this.match("Pipe")) items.push(this.parseCompoundCommand());
    return { pipeline: { items } };
  }

  parseCompoundCommand() {
    if (this.is("OpenParen")) return { subshell: this.parseSubshell() };
    if (this.isStandaloneWord("if")) return { if: this.parseIf() };
    if (this.is("DoubleBracketOpen")) return { condexpr: this.parseConditional() };
    const command = this.parseSimpleCommand();
    return command.assignsOnly ? { assign: command.assigns } : { cmd: command };
  }

  parseSubshell() {
    this.take();
    const script = this.parseScript(new Set(["CloseParen", "Eof"]));
    if (!this.match("CloseParen")) throw syntax("Unclosed subshell", this.index);
    const parsed = this.parseRedirect();
    return { script, redirect: parsed.redirect, redirect_flags: parsed.flags };
  }

  parseIfBody(until) {
    return this.parseScript(new Set(["Eof", "CmdSubstEnd", "CloseParen"]), new Set(until)).stmts;
  }

  parseIf() {
    this.consumeStandaloneWord("if");
    const cond = this.parseIfBody(["then"]);
    if (!this.consumeStandaloneWord("then")) throw syntax('Expected "then"', this.index);
    const then = this.parseIfBody(["else", "elif", "fi"]);
    const elseParts = [];

    while (this.consumeStandaloneWord("elif")) {
      elseParts.push(this.parseIfBody(["then"]));
      if (!this.consumeStandaloneWord("then")) throw syntax('Expected "then"', this.index);
      elseParts.push(this.parseIfBody(["else", "elif", "fi"]));
    }
    if (this.consumeStandaloneWord("else")) elseParts.push(this.parseIfBody(["fi"]));
    if (!this.consumeStandaloneWord("fi")) throw syntax('Expected "fi"', this.index);
    return { cond, then, else_parts: elseParts };
  }

  parseConditional() {
    this.take();
    const atoms = [];
    while (!this.is("DoubleBracketClose") && !this.is("Eof")) {
      const atom = this.parseAtom();
      if (atom) atoms.push(atom);
      else if (this.is("Delimit")) this.take();
      else break;
    }
    if (!this.match("DoubleBracketClose")) throw syntax('Expected "]]"', this.index);
    if (atoms.length === 2) {
      const op = Object.values(atoms[0].simple ?? {})[0];
      return { op, args: [atoms[1]] };
    }
    if (atoms.length === 3) {
      const op = Object.values(atoms[1].simple ?? {})[0];
      return { op, args: [atoms[0], atoms[2]] };
    }
    throw syntax("Expected a conditional expression", this.index);
  }

  parseAssignment() {
    const token = this.peek();
    if (token.tag !== "Text") return null;
    const equal = token.value.indexOf("=");
    if (equal <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(token.value.slice(0, equal))) return null;
    const label = token.value.slice(0, equal);
    const value = token.value.slice(equal + 1);
    this.take();

    if (this.is("Delimit") || this.is("Semicolon") || this.is("Newline") || this.is("Eof") || this.is("CmdSubstEnd") || this.is("CloseParen")) {
      if (this.is("Delimit")) this.take();
      return { label, value: { simple: simpleTestingAtom("Text", value) } };
    }

    const right = this.parseAtom();
    if (!right) throw syntax("Expected an atom", this.index);
    if (value.length === 0) return { label, value: right };
    return {
      label,
      value: mergeTestingAtoms({ simple: simpleTestingAtom("Text", value) }, right),
    };
  }

  parseSimpleCommand() {
    const assigns = [];
    while (true) {
      const assignment = this.parseAssignment();
      if (!assignment) break;
      assigns.push(assignment);
    }

    const name = this.parseAtom();
    if (!name) {
      if (assigns.length === 0) {
        throw syntax(`expected a command or assignment but got: "${this.peek().tag}"`, this.index);
      }
      return { assignsOnly: true, assigns };
    }

    const nameAndArgs = [name];
    while (true) {
      const argument = this.parseAtom();
      if (!argument) break;
      nameAndArgs.push(argument);
    }
    const parsed = this.parseRedirect();
    return {
      assigns,
      name_and_args: nameAndArgs,
      redirect: parsed.flags,
      redirect_file: parsed.redirect,
    };
  }

  parseRedirect() {
    if (!this.is("Redirect")) return { flags: testingRedirect(), redirect: null };
    const flags = this.take().value;
    if (this.is("JSObjRef")) return { flags, redirect: { jsbuf: { idx: this.take().value } } };
    if (flags.duplicate_out) return { flags, redirect: null };
    const atom = this.parseAtom();
    if (!atom) throw syntax("Redirection with no file", this.index);
    return { flags, redirect: { atom } };
  }

  parseAtom() {
    const parts = [];
    let hasBraceOpen = false;
    let hasBraceClose = false;
    let hasComma = false;
    let hasGlob = false;

    while (true) {
      const token = this.peek();
      if (token.tag === "Delimit") {
        this.take();
        break;
      }
      if ([
        "Eof",
        "Semicolon",
        "Newline",
        "Pipe",
        "DoublePipe",
        "Ampersand",
        "DoubleAmpersand",
        "Redirect",
        "JSObjRef",
        "CmdSubstEnd",
        "CloseParen",
        "DoubleBracketClose",
      ].includes(token.tag)) break;

      if (token.tag === "Text" || token.tag === "SingleQuotedText" || token.tag === "DoubleQuotedText") {
        this.take();
        let value = token.value;
        if (token.tag === "Text" && value.startsWith("~")) {
          parts.push(simpleTestingAtom("tilde"));
          value = value.slice(1);
        }
        if (value.length === 0 && token.tag !== "Text") parts.push(simpleTestingAtom("quoted_empty"));
        else if (value.length > 0 || token.tag === "Text") parts.push(simpleTestingAtom("Text", value));
        continue;
      }
      if (token.tag === "Var") {
        parts.push(simpleTestingAtom("Var", this.take().value));
        continue;
      }
      if (token.tag === "VarArgv") {
        parts.push(simpleTestingAtom("VarArgv", this.take().value));
        continue;
      }
      if (token.tag === "Asterisk" || token.tag === "DoubleAsterisk") {
        hasGlob = true;
        parts.push(simpleTestingAtom(token.tag === "Asterisk" ? "asterisk" : "double_asterisk"));
        this.take();
        continue;
      }
      if (token.tag === "BraceBegin" || token.tag === "BraceEnd" || token.tag === "Comma") {
        if (token.tag === "BraceBegin") hasBraceOpen = true;
        if (token.tag === "BraceEnd") hasBraceClose = true;
        if (token.tag === "Comma") hasComma = true;
        parts.push(simpleTestingAtom({ BraceBegin: "brace_begin", BraceEnd: "brace_end", Comma: "comma" }[token.tag]));
        this.take();
        continue;
      }
      if (token.tag === "CmdSubstBegin") {
        this.take();
        const quoted = this.match("CmdSubstQuoted");
        const script = this.parseScript(new Set(["CmdSubstEnd", "Eof"]));
        if (!this.match("CmdSubstEnd")) throw syntax("Unclosed command substitution", this.index);
        parts.push(simpleTestingAtom("cmd_subst", { script, quoted }));
        continue;
      }
      if (token.tag === "OpenParen") throw syntax("Unexpected token: `(`", this.index);
      throw syntax(`Unexpected token: ${token.tag}`, this.index);
    }

    if (parts.length === 0) return null;
    if (parts.length === 1) return { simple: parts[0] };
    return {
      compound: {
        atoms: parts,
        brace_expansion_hint: hasBraceOpen && hasBraceClose && hasComma,
        glob_hint: hasGlob,
      },
    };
  }
}

export function serializeShellLex(strings, ...values) {
  return JSON.stringify(lexTestingShell(strings, values).map(serializeTestingToken));
}

export function serializeShellParse(strings, ...values) {
  const tokens = lexTestingShell(strings, values);
  const parser = new TestingShellParser(tokens);
  return JSON.stringify(parser.parseScript());
}
