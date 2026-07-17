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
      let item = this.parseAndOr();
      const background = this.consumeOp("&");
      if (background) item = { type: "async", command: item };
      items.push(item);
      if (background) {
        this.skipSeparators();
        continue;
      }
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
      const redirects = this.parseRedirects();
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
