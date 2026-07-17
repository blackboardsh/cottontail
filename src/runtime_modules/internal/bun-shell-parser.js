// Source-led JavaScript port of the grammar in src/compiler/src/shell/shell.zig.
// The AST is intentionally runtime-oriented: quote information remains on words
// so expansion happens against the shell state immediately before execution.

function syntax(message, position) {
  const error = new SyntaxError(message);
  error.position = position;
  return error;
}

function decodeAnsiCString(source) {
  return source.replace(/\\(x[\da-fA-F]{1,2}|[0-7]{1,3}|.)/gs, (_, escape) => {
    if (escape[0] === "x") return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (/^[0-7]/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    return ({
      a: "\x07",
      b: "\b",
      e: "\x1b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "\\": "\\",
      "'": "'",
      '"': '"',
    })[escape] ?? escape;
  });
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
  throw syntax("Unterminated command substitution", start);
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
  throw syntax("Unterminated command substitution", start);
}

function operatorAt(source, index, atWordStart) {
  const rest = source.slice(index);
  for (const operator of ["2>&1", "1>&2", ">&2", ">&1", "0<<", "0<", "&>>", "&>", "2>>", "1>>", ">>", "2>", "1>", "<<", "&&", "||", ";;", "|&"]) {
    if (rest.startsWith(operator)) return operator;
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
    let raw = "";
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
          raw += "\\";
          index += 1;
        } else {
          appendPart(parts, next, "literal", false);
          raw += source.slice(index, index + 2);
          index += 2;
        }
        continue;
      }
      if (current === "'" || current === '"') {
        const quote = current;
        const quoteName = quote === "'" ? "single" : "double";
        const quoteStart = index++;
        raw += quote;
        let text = "";
        let emitted = false;
        const flushQuotedText = () => {
          if (text === "") return;
          appendPart(parts, text, quoteName, quoteName !== "single");
          text = "";
          emitted = true;
        };
        while (index < source.length && source[index] !== quote) {
          if (quote === '"' && source[index] === "\\" && /[$`"\\\n]/.test(source[index + 1] ?? "")) {
            flushQuotedText();
            if (source[index + 1] !== "\n") {
              appendPart(parts, source[index + 1], quoteName, false);
              emitted = true;
            }
            raw += source.slice(index, index + 2);
            index += 2;
            continue;
          }
          if (quote === '"' && source.startsWith("$(", index)) {
            const end = readBalancedSubstitution(source, index);
            text += source.slice(index, end);
            raw += source.slice(index, end);
            index = end;
            continue;
          }
          if (quote === '"' && source[index] === "`") {
            const end = readBacktick(source, index);
            text += source.slice(index, end);
            raw += source.slice(index, end);
            index = end;
            continue;
          }
          text += source[index];
          raw += source[index++];
        }
        if (index >= source.length) throw syntax(`Unterminated ${quoteName} quote`, quoteStart);
        raw += source[index++];
        flushQuotedText();
        if (!emitted) appendPart(parts, "", quoteName, quoteName !== "single");
        continue;
      }
      if (current === "$" && source[index + 1] === "'") {
        const quoteStart = index;
        index += 2;
        let text = "";
        while (index < source.length && source[index] !== "'") {
          if (source[index] === "\\" && index + 1 < source.length) {
            text += source.slice(index, Math.min(source.length, index + 4));
            index += 1;
          } else {
            text += source[index++];
          }
        }
        if (index >= source.length) throw syntax("Unterminated ANSI-C quote", quoteStart);
        index += 1;
        raw += source.slice(quoteStart, index);
        appendPart(parts, decodeAnsiCString(text), "single", false);
        continue;
      }
      if (source.startsWith("$(", index)) {
        const end = readBalancedSubstitution(source, index);
        appendPart(parts, source.slice(index, end), "unquoted", true);
        raw += source.slice(index, end);
        index = end;
        continue;
      }
      if (current === "`") {
        const end = readBacktick(source, index);
        appendPart(parts, source.slice(index, end), "unquoted", true);
        raw += source.slice(index, end);
        index = end;
        continue;
      }
      appendPart(parts, current, "unquoted", true);
      raw += current;
      index += 1;
    }
    if (parts.length === 0) {
      if (index > position) continue;
      throw syntax(`Unexpected token: \`${source[index]}\``, index);
    }
    tokens.push({ type: "word", parts, raw, position });
    wordStart = false;
  }

  tokens.push({ type: "eof", value: "", position: source.length });
  return tokens;
}

const REDIRECTS = new Set(["<", "<<", "0<", "0<<", ">", ">>", "1>", "1>>", "2>", "2>>", "&>", "&>>", "2>&1", "1>&2", ">&2", ">&1"]);

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

  parse(stopWords = new Set(), stopOperators = new Set([")"])) {
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
      if (!this.consumeOp(")")) throw syntax("Expected `)`", this.peek().position);
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
      throw syntax(`Unexpected token: \`${this.peek().raw ?? this.peek().value}\``, this.peek().position);
    }
    return { type: "command", words, redirects };
  }
}

export function parseShell(source) {
  const parser = new Parser(lexShell(source));
  const script = parser.parse();
  if (parser.peek().type !== "eof") throw syntax(`Unexpected token: \`${parser.peek().value}\``, parser.peek().position);
  return script;
}
