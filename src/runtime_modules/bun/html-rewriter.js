const HTML_REWRITER_SELECTOR_PATTERN = (() => {
  const ident = String.raw`(?:\\.|[A-Za-z0-9_\u00A0-\uFFFF-])+`;
  const quoted = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'`;
  const attr = String.raw`\[\s*${ident}\s*(?:[~^$*|]?=\s*(?:${quoted}|${ident})\s*(?:[iIsS]\s*)?)?\]`;
  const pseudo = String.raw`::?${ident}(?:\((?:${quoted}|[^()"'])*\))?`;
  const part = String.raw`(?:[.#]${ident}|${attr}|${pseudo})`;
  const compound = String.raw`(?:(?:\*|${ident})${part}*|${part}+)`;
  const complex = String.raw`${compound}(?:(?:\s*[>+~]\s*|\s+)${compound})*`;
  return new RegExp(String.raw`^\s*${complex}\s*(?:,\s*${complex}\s*)*$`);
})();

const escapeHTML = (...args) => globalThis.Cottontail.text.escapeHTML(...args);

function validateHTMLRewriterSelector(selector) {
  const text = String(selector);
  if (!HTML_REWRITER_SELECTOR_PATTERN.test(text)) {
    throw new TypeError(`Invalid selector: '${text}'`);
  }
  return text;
}

function runHTMLRewriterHandler(handler, ...args) {
  const result = handler(...args);
  if (result == null || typeof result.then !== "function") return result;
  let status = cottontail.promiseStatus(result);
  if (status === 0) {
    // COTTONTAIL-COMPAT: Attach the rejection observer before pumping the
    // event loop so a synchronously rethrown handler error is not also
    // reported as an unhandled rejection by bun:test.
    result.catch(() => {});
    status = cottontail.waitForPromise(result);
  }
  if (status === 2) {
    const reason = cottontail.promiseResult(result);
    result.catch(() => {});
    throw reason;
  }
  return status === 1 ? cottontail.promiseResult(result) : result;
}

class HTMLRewriterTextChunk {
  constructor(state) {
    this._state = state;
  }
  get text() {
    const state = this._state;
    return state.valid ? state.text : undefined;
  }
  get removed() {
    const state = this._state;
    return state.valid ? state.removed : undefined;
  }
  get lastInTextNode() {
    const state = this._state;
    return state.valid ? state.last : undefined;
  }
  before(content, options = undefined) {
    const state = this._state;
    if (state.valid) state.before += options?.html ? String(content) : escapeHTML(String(content));
    return this;
  }
  after(content, options = undefined) {
    const state = this._state;
    if (state.valid) state.after = (options?.html ? String(content) : escapeHTML(String(content))) + state.after;
    return this;
  }
  replace(content, options = undefined) {
    const state = this._state;
    if (state.valid) {
      state.text = String(content);
      state.html = Boolean(options?.html);
      state.replaced = true;
      state.removed = false;
    }
    return this;
  }
  remove() {
    const state = this._state;
    if (state.valid) {
      state.removed = true;
      state.replaced = false;
      state.text = "";
    }
    return this;
  }
}

function rewriteTextChunks(inner, handler, liveStates) {
  const emitTextNode = (text) => {
    let result = "";
    const emit = (chunkText, last) => {
      const state = {
        valid: true,
        text: chunkText,
        removed: false,
        replaced: false,
        html: false,
        last,
        before: "",
        after: "",
      };
      liveStates.push(state);
      runHTMLRewriterHandler(handler, new HTMLRewriterTextChunk(state));
      const body = state.removed ? "" : state.replaced ? (state.html ? state.text : escapeHTML(state.text)) : chunkText;
      return state.before + body + state.after;
    };
    result += emit(text, false);
    result += emit("", true);
    return result;
  };

  let output = "";
  let index = 0;
  const tagPattern = /<[^>]*>/g;
  let match;
  while ((match = tagPattern.exec(inner))) {
    const text = inner.slice(index, match.index);
    if (text) output += emitTextNode(text);
    output += match[0];
    index = match.index + match[0].length;
  }
  const tail = inner.slice(index);
  if (tail) output += emitTextNode(tail);
  return output;
}

const HTML_REWRITER_VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame",
  "hr", "img", "input", "keygen", "link", "meta", "param", "source",
  "track", "wbr",
]);

function findHTMLRewriterTagEnd(html, start) {
  let quote = "";
  for (let index = start + 1; index < html.length; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return -1;
}

function parseHTMLRewriterAttributes(source) {
  const attributes = [];
  let index = 0;
  while (index < source.length) {
    const rawStart = index;
    while (index < source.length && /\s/.test(source[index])) index += 1;
    if (index >= source.length || source[index] === "/") break;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index])) index += 1;
    if (index === nameStart) {
      index += 1;
      continue;
    }
    const name = source.slice(nameStart, index);
    while (index < source.length && /\s/.test(source[index])) index += 1;
    let value = "";
    let hadValue = false;
    if (source[index] === "=") {
      hadValue = true;
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      const quote = source[index] === "\"" || source[index] === "'" ? source[index++] : "";
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        while (index < source.length && !/[\s>]/.test(source[index])) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    attributes.push({
      name,
      normalizedName: name.toLowerCase(),
      value,
      hadValue,
      raw: source.slice(rawStart, index),
      changed: false,
      removed: false,
    });
  }
  return attributes;
}

function parseHTMLRewriterTree(html) {
  const root = { type: "root", children: [], parent: null };
  const stack = [root];
  let index = 0;
  const append = (node) => {
    const parent = stack[stack.length - 1];
    node.parent = parent;
    parent.children.push(node);
  };

  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      const stop = end < 0 ? html.length : end + 3;
      append({
        type: "comment",
        text: html.slice(index + 4, end < 0 ? html.length : end),
        raw: html.slice(index, stop),
        before: [],
        after: [],
        replacement: null,
        removed: false,
      });
      index = stop;
      continue;
    }
    if (html[index] !== "<") {
      const next = html.indexOf("<", index);
      const stop = next < 0 ? html.length : next;
      append({ type: "text", raw: html.slice(index, stop) });
      index = stop;
      continue;
    }

    const end = findHTMLRewriterTagEnd(html, index);
    if (end < 0) {
      append({ type: "text", raw: html.slice(index) });
      break;
    }
    const raw = html.slice(index, end + 1);
    const closing = /^<\s*\/\s*([^\s>]+)/.exec(raw);
    if (closing) {
      const tagName = closing[1].toLowerCase();
      let matchIndex = stack.length - 1;
      while (matchIndex > 0 && stack[matchIndex].tagName !== tagName) matchIndex -= 1;
      if (matchIndex > 0) {
        stack[matchIndex].closeRaw = raw;
        stack.length = matchIndex;
      } else {
        append({ type: "raw", raw });
      }
      index = end + 1;
      continue;
    }
    if (/^<\s*!|^<\s*\?/.test(raw)) {
      append({ type: "raw", raw });
      index = end + 1;
      continue;
    }

    const opening = /^<\s*([^\s/>]+)/.exec(raw);
    if (!opening) {
      append({ type: "raw", raw });
      index = end + 1;
      continue;
    }
    const originalTagName = opening[1];
    const tagName = originalTagName.toLowerCase();
    const explicitSelfClosing = /\/\s*>$/.test(raw);
    const parent = stack[stack.length - 1];
    const parentNamespace = parent.type === "element" ? parent.namespace : "html";
    const namespace = tagName === "svg" || (parentNamespace === "svg" && tagName !== "foreignobject")
      ? "svg"
      : "html";
    const attributeEnd = raw.length - 1 - (explicitSelfClosing ? raw.slice(0, -1).match(/\/\s*$/)?.[0].length ?? 0 : 0);
    const attributeSource = raw.slice(opening[0].length, attributeEnd);
    const node = {
      type: "element",
      tagName,
      originalTagName,
      namespace,
      startRaw: raw,
      closeRaw: "",
      attributes: parseHTMLRewriterAttributes(attributeSource),
      attrsChanged: false,
      tagChanged: false,
      selfClosing: explicitSelfClosing,
      isVoid: HTML_REWRITER_VOID_ELEMENTS.has(tagName),
      children: [],
      before: [],
      after: [],
      prepend: [],
      append: [],
      innerOverride: null,
      replacement: null,
      removed: false,
      keepContent: false,
    };
    append(node);
    if (!node.isVoid && !node.selfClosing) stack.push(node);
    index = end + 1;
  }
  return root;
}

function splitHTMLRewriterSelectorList(selector) {
  const selectors = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      if (char === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") quote = char;
    else if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      selectors.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selector.slice(start).trim());
  return selectors.filter(Boolean);
}

function parseHTMLRewriterSelectorChain(selector) {
  const compounds = [];
  const combinators = [];
  let buffer = "";
  let depth = 0;
  let quote = "";
  let pendingSpace = false;
  const flush = () => {
    const value = buffer.trim();
    if (value) compounds.push(value);
    buffer = "";
  };
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (quote) {
      buffer += char;
      if (char === quote && selector[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      if (pendingSpace && compounds.length > combinators.length) combinators.push(" ");
      pendingSpace = false;
      quote = char;
      buffer += char;
      continue;
    }
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    if (depth === 0 && char === ">") {
      flush();
      if (combinators.length === compounds.length) combinators[combinators.length - 1] = ">";
      else combinators.push(">");
      pendingSpace = false;
      continue;
    }
    if (depth === 0 && /\s/.test(char)) {
      flush();
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) {
      if (compounds.length > combinators.length) combinators.push(" ");
      pendingSpace = false;
    }
    buffer += char;
  }
  flush();
  return { compounds, combinators };
}

function HTMLRewriterElementSiblings(node) {
  return node.parent?.children?.filter((child) => child.type === "element") ?? [];
}

function matchesHTMLRewriterAttribute(node, source) {
  const match = /^\s*([^\s~|^$*=\]]+)\s*(?:(~=|\|=|\^=|\$=|\*=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))\s*([iIsS])?)?\s*$/.exec(source);
  if (!match) return false;
  const name = match[1].toLowerCase();
  const operation = match[2];
  const expectedRaw = match[3] ?? match[4] ?? match[5] ?? "";
  const insensitive = String(match[6] ?? "").toLowerCase() === "i";
  const attributes = node.attributes.filter((attribute) => !attribute.removed && attribute.normalizedName === name);
  if (!operation) return attributes.length > 0;
  return attributes.some((attribute) => {
    let actual = attribute.value;
    let expected = expectedRaw;
    if (insensitive) {
      actual = actual.toLowerCase();
      expected = expected.toLowerCase();
    }
    if (operation === "=") return actual === expected;
    if (operation === "~=") return actual.split(/\s+/).includes(expected);
    if (operation === "|=") return actual === expected || actual.startsWith(`${expected}-`);
    if (operation === "^=") return actual.startsWith(expected);
    if (operation === "$=") return actual.endsWith(expected);
    return actual.includes(expected);
  });
}

function matchesHTMLRewriterCompound(node, compound) {
  const notSelectors = [];
  let source = compound.replace(/:not\(([^()]*)\)/g, (_match, selector) => {
    notSelectors.push(selector);
    return "";
  });
  const attributes = [];
  source = source.replace(/\[([^\]]*)\]/g, (_match, attribute) => {
    attributes.push(attribute);
    return "";
  });
  const pseudos = [];
  source = source.replace(/:(first-child|first-of-type|nth-child\(\s*\d+\s*\)|nth-of-type\(\s*\d+\s*\))/g, (_match, pseudo) => {
    pseudos.push(pseudo);
    return "";
  });
  const tag = /^(\*|[A-Za-z][\w:-]*)/.exec(source)?.[1];
  if (tag && tag !== "*" && node.tagName !== tag.toLowerCase()) return false;
  for (const id of source.matchAll(/#([\w-]+)/g)) {
    if (!node.attributes.some((attribute) => !attribute.removed && attribute.normalizedName === "id" && attribute.value === id[1])) return false;
  }
  for (const className of source.matchAll(/\.([\w-]+)/g)) {
    const matched = node.attributes.some((attribute) =>
      !attribute.removed && attribute.normalizedName === "class" && attribute.value.split(/\s+/).includes(className[1]));
    if (!matched) return false;
  }
  for (const attribute of attributes) {
    if (!matchesHTMLRewriterAttribute(node, attribute)) return false;
  }
  const siblings = HTMLRewriterElementSiblings(node);
  const childIndex = siblings.indexOf(node);
  const sameType = siblings.filter((sibling) => sibling.tagName === node.tagName);
  const typeIndex = sameType.indexOf(node);
  for (const pseudo of pseudos) {
    if (pseudo === "first-child" && childIndex !== 0) return false;
    if (pseudo === "first-of-type" && typeIndex !== 0) return false;
    const nthChild = /^nth-child\(\s*(\d+)\s*\)$/.exec(pseudo);
    if (nthChild && childIndex + 1 !== Number(nthChild[1])) return false;
    const nthType = /^nth-of-type\(\s*(\d+)\s*\)$/.exec(pseudo);
    if (nthType && typeIndex + 1 !== Number(nthType[1])) return false;
  }
  for (const notSelector of notSelectors) {
    if (matchesHTMLRewriterCompound(node, notSelector)) return false;
  }
  return true;
}

function matchesHTMLRewriterSelectorChain(node, chain, compoundIndex = chain.compounds.length - 1) {
  if (compoundIndex < 0 || !matchesHTMLRewriterCompound(node, chain.compounds[compoundIndex])) return false;
  if (compoundIndex === 0) return true;
  const combinator = chain.combinators[compoundIndex - 1] ?? " ";
  if (combinator === ">") {
    return node.parent?.type === "element" && matchesHTMLRewriterSelectorChain(node.parent, chain, compoundIndex - 1);
  }
  let parent = node.parent;
  while (parent?.type === "element") {
    if (matchesHTMLRewriterSelectorChain(parent, chain, compoundIndex - 1)) return true;
    parent = parent.parent;
  }
  return false;
}

function parseHTMLRewriterSelector(selector) {
  return splitHTMLRewriterSelectorList(selector).map(parseHTMLRewriterSelectorChain);
}

function matchesHTMLRewriterSelector(node, selector) {
  return selector.some((chain) => matchesHTMLRewriterSelectorChain(node, chain));
}

function HTMLRewriterContent(content, options) {
  const text = String(content);
  return options?.html ? text : escapeHTML(text);
}

function makeHTMLRewriterElement(node) {
  const element = {
    get tagName() { return node.tagName; },
    set tagName(value) {
      node.tagName = String(value).toLowerCase();
      node.tagChanged = true;
    },
    get namespaceURI() {
      return node.namespace === "svg" ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml";
    },
    get attributes() {
      return node.attributes.filter((attribute) => !attribute.removed).map((attribute) => [attribute.name, attribute.value]);
    },
    get removed() { return node.removed; },
    get selfClosing() { return node.selfClosing; },
    get canHaveContent() { return !node.isVoid && !(node.namespace !== "html" && node.selfClosing); },
    getAttribute(name) {
      const normalized = String(name).toLowerCase();
      return node.attributes.find((attribute) => !attribute.removed && attribute.normalizedName === normalized)?.value ?? null;
    },
    hasAttribute(name) {
      const normalized = String(name).toLowerCase();
      return node.attributes.some((attribute) => !attribute.removed && attribute.normalizedName === normalized);
    },
    setAttribute(name, value) {
      const nameText = String(name);
      const normalized = nameText.toLowerCase();
      const existing = node.attributes.find((attribute) => !attribute.removed && attribute.normalizedName === normalized);
      if (existing) {
        existing.value = String(value);
        existing.hadValue = true;
        existing.changed = true;
      } else {
        node.attributes.push({ name: nameText, normalizedName: normalized, value: String(value), hadValue: true, raw: "", changed: true, removed: false });
      }
      node.attrsChanged = true;
      return element;
    },
    removeAttribute(name) {
      const normalized = String(name).toLowerCase();
      for (const attribute of node.attributes) {
        if (attribute.normalizedName === normalized) attribute.removed = true;
      }
      node.attrsChanged = true;
      return element;
    },
    before(content, options) {
      node.before.push(HTMLRewriterContent(content, options));
      return element;
    },
    after(content, options) {
      node.after.unshift(HTMLRewriterContent(content, options));
      return element;
    },
    prepend(content, options) {
      node.prepend.unshift(HTMLRewriterContent(content, options));
      return element;
    },
    append(content, options) {
      node.append.push(HTMLRewriterContent(content, options));
      return element;
    },
    replace(content, options) {
      node.replacement = HTMLRewriterContent(content, options);
      node.removed = false;
      return element;
    },
    setInnerContent(content, options) {
      node.innerOverride = HTMLRewriterContent(content, options);
      return element;
    },
    remove() {
      node.removed = true;
      node.keepContent = false;
      return element;
    },
    removeAndKeepContent() {
      node.removed = true;
      node.keepContent = true;
      return element;
    },
  };
  return element;
}

function runHTMLRewriterCommentHandler(node, handler) {
  const comment = {
    get text() { return node.text; },
    set text(value) { node.text = String(value); },
    get removed() { return node.removed; },
    before(content, options) { node.before.push(HTMLRewriterContent(content, options)); return comment; },
    after(content, options) { node.after.unshift(HTMLRewriterContent(content, options)); return comment; },
    replace(content, options) { node.replacement = HTMLRewriterContent(content, options); node.removed = false; return comment; },
    remove() { node.removed = true; return comment; },
  };
  runHTMLRewriterHandler(handler, comment);
}

function serializeHTMLRewriterStartTag(node) {
  if (!node.attrsChanged && !node.tagChanged) return node.startRaw;
  let output = `<${node.tagName}`;
  for (const attribute of node.attributes) {
    if (attribute.removed) continue;
    if (!attribute.changed && attribute.raw) output += attribute.raw;
    else output += ` ${attribute.name}="${escapeHTML(attribute.value)}"`;
  }
  return `${output}${node.selfClosing ? " /" : ""}>`;
}

function serializeHTMLRewriterNode(node) {
  if (node.type === "text" || node.type === "raw") return node.raw;
  if (node.type === "comment") {
    const body = node.removed ? "" : node.replacement ?? `<!--${node.text}-->`;
    return node.before.join("") + body + node.after.join("");
  }
  if (node.type === "root") return node.children.map(serializeHTMLRewriterNode).join("");
  const content = node.innerOverride ?? node.children.map(serializeHTMLRewriterNode).join("");
  const inner = node.prepend.join("") + content + node.append.join("");
  let body;
  if (node.replacement != null) body = node.replacement;
  else if (node.removed) body = node.keepContent ? inner : "";
  else body = serializeHTMLRewriterStartTag(node) + (node.isVoid || node.selfClosing ? "" : inner + node.closeRaw);
  return node.before.join("") + body + node.after.join("");
}

function rewriteHTMLRewriterElements(html, registrations, documentHandlers, liveTextStates) {
  if (registrations.length === 0 && documentHandlers.length === 0) return html;
  const parsedRegistrations = registrations.map((registration) => ({
    ...registration,
    parsedSelector: parseHTMLRewriterSelector(registration.selector),
  }));
  const root = parseHTMLRewriterTree(html);
  const documentCommentHandlers = documentHandlers.flatMap((handlers) =>
    typeof handlers.comments === "function" ? [handlers.comments.bind(handlers)] : []);
  const documentTextHandlers = documentHandlers.flatMap((handlers) =>
    typeof handlers.text === "function" ? [handlers.text.bind(handlers)] : []);

  const visit = (node, commentHandlers, textHandlers) => {
    if (node.type === "comment") {
      for (const handler of commentHandlers) runHTMLRewriterCommentHandler(node, handler);
      return;
    }
    if (node.type === "text") {
      for (const handler of textHandlers) node.raw = rewriteTextChunks(node.raw, handler, liveTextStates);
      return;
    }
    if (node.type !== "element" && node.type !== "root") return;
    let childCommentHandlers = commentHandlers;
    let childTextHandlers = textHandlers;
    if (node.type === "element") {
      const matches = parsedRegistrations.filter((registration) => matchesHTMLRewriterSelector(node, registration.parsedSelector));
      for (const registration of matches) {
        if (typeof registration.handlers?.element === "function") {
          runHTMLRewriterHandler(registration.handlers.element.bind(registration.handlers), makeHTMLRewriterElement(node));
        }
      }
      const scopedComments = matches.flatMap((registration) =>
        typeof registration.handlers?.comments === "function" ? [registration.handlers.comments.bind(registration.handlers)] : []);
      const scopedText = matches.flatMap((registration) =>
        typeof registration.handlers?.text === "function" ? [registration.handlers.text.bind(registration.handlers)] : []);
      if (scopedComments.length > 0) childCommentHandlers = [...commentHandlers, ...scopedComments];
      if (scopedText.length > 0) childTextHandlers = [...textHandlers, ...scopedText];
      if (node.innerOverride != null) return;
    }
    for (const child of node.children) visit(child, childCommentHandlers, childTextHandlers);
  };
  visit(root, documentCommentHandlers, documentTextHandlers);
  let output = serializeHTMLRewriterNode(root);
  for (const handlers of documentHandlers) {
    if (typeof handlers.end !== "function") continue;
    const additions = [];
    const end = { append(content, options) { additions.push(HTMLRewriterContent(content, options)); return end; } };
    runHTMLRewriterHandler(handlers.end.bind(handlers), end);
    output += additions.join("");
  }
  return output;
}

export class HTMLRewriter {
  constructor() {
    this._elementHandlers = [];
    this._documentHandlers = [];
  }
  on(selector, handlers) {
    validateHTMLRewriterSelector(selector);
    if (handlers === null || typeof handlers !== "object") {
      throw new TypeError("Expected object");
    }
    this._elementHandlers.push({ selector: String(selector), handlers });
    return this;
  }
  onDocument(handlers) {
    if (handlers === null || typeof handlers !== "object") {
      throw new TypeError("Expected object");
    }
    for (const name of ["doctype", "comments", "text", "end"]) {
      if (handlers[name] != null && typeof handlers[name] !== "function") {
        throw new TypeError(`${name} must be a function`);
      }
    }
    this._documentHandlers.push(handlers);
    return this;
  }
  transform(response) {
    if (response === null || response === undefined) {
      throw new TypeError("Expected Response or Body");
    }
    if (typeof response === "symbol" || (response instanceof Response && typeof response._body === "symbol")) {
      throw new TypeError("Expected Response or Body");
    }
    if (typeof response === "string") return this._transformText(response);
    if (response instanceof ArrayBuffer || ArrayBuffer.isView(response)) {
      const bytes = response instanceof ArrayBuffer
        ? new Uint8Array(response)
        : new Uint8Array(response.buffer, response.byteOffset, response.byteLength);
      return new TextEncoder().encode(this._transformText(new TextDecoder().decode(bytes))).buffer;
    }
    const source = response instanceof Response || response instanceof Blob || response?.text
      ? response
      : new Response(response);
    // Buffered string/byte bodies are rewritten eagerly (lol-html runs the
    // handlers during transform(), not when the result is consumed).
    const direct = source instanceof Response ? source._body : null;
    if (typeof direct === "string" || direct instanceof ArrayBuffer || ArrayBuffer.isView(direct)) {
      source._bodyUsed = true;
      const text = typeof direct === "string"
        ? direct
        : new TextDecoder().decode(direct instanceof ArrayBuffer ? new Uint8Array(direct) : new Uint8Array(direct.buffer, direct.byteOffset, direct.byteLength));
      return new Response(this._transformText(text), {
        status: response?.status ?? 200,
        headers: response?.headers,
      });
    }
    const rewriter = this;
    const transformedBody = (async function* () {
      yield new TextEncoder().encode(rewriter._transformText(await source.text()));
    })();
    return new Response(transformedBody, {
      status: response?.status ?? 200,
      headers: response?.headers,
    });
  }
  _transformText(input) {
    let html = String(input);
    const liveTextStates = [];
    for (const handlers of this._documentHandlers) {
      if (typeof handlers.doctype === "function") {
        html = html.replace(/<!DOCTYPE\s+([^>]+)>/i, (source, declaration) => {
          const name = /^\s*([^\s]+)/.exec(declaration)?.[1] ?? null;
          const publicMatch = /^\s*[^\s]+\s+PUBLIC\s+["']([^"']*)["'](?:\s+["']([^"']*)["'])?/i.exec(declaration);
          const systemMatch = /^\s*[^\s]+\s+SYSTEM\s+["']([^"']*)["']/i.exec(declaration);
          const state = { valid: true, removed: false };
          const doctype = {
            get name() { return state.valid ? name : undefined; },
            get publicId() { return state.valid ? (publicMatch?.[1] ?? null) : undefined; },
            get systemId() { return state.valid ? (publicMatch?.[2] ?? systemMatch?.[1] ?? null) : undefined; },
            get removed() { return state.valid ? state.removed : undefined; },
            remove() {
              if (state.valid) state.removed = true;
              return this;
            },
          };
          runHTMLRewriterHandler(handlers.doctype.bind(handlers), doctype);
          state.valid = false;
          return state.removed ? "" : source;
        });
      }
    }
    html = rewriteHTMLRewriterElements(html, this._elementHandlers, this._documentHandlers, liveTextStates);
    for (const state of liveTextStates) state.valid = false;
    return html;
  }
}
