import { asBuffer } from "./web-buffer-utils.js";

const markdownBooleanOptions = [
  "tables",
  "strikethrough",
  "tasklists",
  "permissiveAutolinks",
  "permissiveUrlAutolinks",
  "permissiveWwwAutolinks",
  "permissiveEmailAutolinks",
  "hardSoftBreaks",
  "wikiLinks",
  "underline",
  "latexMath",
  "collapseWhitespace",
  "permissiveAtxHeaders",
  "noIndentedCodeBlocks",
  "noHtmlBlocks",
  "noHtmlSpans",
  "tagFilter",
  "headingIds",
  "autolinkHeadings",
];

function markdownFlags(options = {}) {
  let flags = 0;
  const values = { tables: true, strikethrough: true, tasklists: true };
  if (options && typeof options === "object") Object.assign(values, options);
  if (values.autolinks === true) values.permissiveAutolinks = true;
  else if (values.autolinks && typeof values.autolinks === "object") {
    values.permissiveUrlAutolinks = values.autolinks.url === true;
    values.permissiveWwwAutolinks = values.autolinks.www === true;
    values.permissiveEmailAutolinks = values.autolinks.email === true;
  }
  if (values.headings === true) {
    values.headingIds = true;
    values.autolinkHeadings = true;
  } else if (values.headings && typeof values.headings === "object") {
    values.headingIds = values.headings.ids === true;
    values.autolinkHeadings = values.headings.autolink === true;
  }
  for (let index = 0; index < markdownBooleanOptions.length; index += 1) {
    const camel = markdownBooleanOptions[index];
    const snake = camel.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (values[camel] === true || values[snake] === true) flags += 2 ** index;
  }
  return flags;
}

function markdownInput(value) {
  if (value == null) throw new TypeError("Expected a string or buffer to render");
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return new TextDecoder().decode(asBuffer(value));
  throw new TypeError("Expected a string or buffer to render");
}

const markdownBlockCallbacks = [
  null, "blockquote", "list", "list", "listItem", "hr", "heading", "code", "html", "paragraph",
  "table", "thead", "tbody", "tr", "th", "td",
];
const markdownSpanCallbacks = ["emphasis", "strong", "link", "image", "codespan", "strikethrough"];

function markdownBlockMeta(entry, stack, source, slug) {
  switch (entry.type) {
    case 2: return { ordered: false, depth: stack.filter((item) => item.type === 2 || item.type === 3).length };
    case 3: return { ordered: true, start: entry.data, depth: stack.filter((item) => item.type === 2 || item.type === 3).length };
    case 4: {
      const parent = stack[stack.length - 1];
      const ordered = parent?.type === 3;
      const depth = Math.max(0, stack.filter((item) => item.type === 2 || item.type === 3).length - 1);
      const meta = { index: entry.childIndex, depth, ordered };
      if (ordered) meta.start = parent.data;
      const taskMark = entry.data & 0xff;
      if (taskMark !== 0) meta.checked = taskMark !== 32;
      return meta;
    }
    case 6: return slug == null ? { level: entry.data } : { level: entry.data, id: slug };
    case 7: {
      if ((entry.flags & 0x10) === 0) return undefined;
      let end = entry.data;
      while (end < source.length && !/[\s]/.test(source[end])) end += 1;
      const language = source.slice(entry.data, end);
      return language ? { language } : undefined;
    }
    case 14:
    case 15: {
      const align = [undefined, "left", "center", "right"][entry.data & 3];
      return { align };
    }
    default: return undefined;
  }
}

function renderMarkdownCallbacks(source, callbacks = {}, options = {}) {
  const events = JSON.parse(cottontail.markdownEvents(source, markdownFlags(options)));
  const stack = [{ type: 0, children: "", childIndex: 0 }];
  const appendResult = (result) => {
    if (result != null) stack[stack.length - 1].children += String(result);
  };
  for (const event of events) {
    const [kind, type, first, second] = event;
    if (kind === "b") {
      if (type === 0) continue;
      let childIndex = 0;
      if (type === 4) {
        const parent = stack[stack.length - 1];
        childIndex = parent.childIndex++;
      }
      stack.push({ type, data: first, flags: second, children: "", childIndex });
      continue;
    }
    if (kind === "s") {
      stack.push({ type, detail: { href: first, title: second }, children: "", childIndex: 0 });
      continue;
    }
    if (kind === "t") {
      const content = first;
      if (type === 1 || type === 2 || type === 3 || typeof callbacks.text !== "function") appendResult(content);
      else appendResult(callbacks.text(content));
      continue;
    }
    if (kind === "S") {
      const entry = stack.pop();
      const name = markdownSpanCallbacks[type];
      const callback = callbacks?.[name];
      if (typeof callback !== "function") appendResult(entry.children);
      else {
        let meta;
        if (type === 2) meta = entry.detail.title ? entry.detail : { href: entry.detail.href };
        else if (type === 3) meta = entry.detail.title
          ? { src: entry.detail.href, title: entry.detail.title }
          : { src: entry.detail.href };
        appendResult(meta === undefined ? callback(entry.children) : callback(entry.children, meta));
      }
      continue;
    }
    if (kind === "B") {
      if (type === 0) continue;
      const entry = stack.pop();
      const callback = callbacks?.[markdownBlockCallbacks[type]];
      if (typeof callback !== "function") appendResult(entry.children);
      else {
        const meta = markdownBlockMeta(entry, stack, source, first);
        appendResult(meta === undefined ? callback(entry.children) : callback(entry.children, meta));
      }
    }
  }
  return stack[0].children;
}

const markdownBlockTags = [
  null, "blockquote", "ul", "ol", "li", "hr", null, "pre", "html", "p",
  "table", "thead", "tbody", "tr", "th", "td",
];
const markdownSpanTags = ["em", "strong", "a", "img", "code", "del", "math", "math", "a", "u"];

function renderMarkdownReact(source, components = {}, options = {}) {
  const events = JSON.parse(cottontail.markdownEvents(source, markdownFlags(options)));
  const elementSymbol = Symbol.for(Number(options?.reactVersion) <= 18 ? "react.element" : "react.transitional.element");
  const createElement = (tag, props) => ({
    $$typeof: elementSymbol,
    type: components?.[tag] && typeof components[tag] !== "boolean" ? components[tag] : tag,
    key: null,
    ref: null,
    props,
  });
  const stack = [{ type: 0, children: [] }];
  for (const event of events) {
    const [kind, type, first, second] = event;
    if (kind === "b") {
      if (type !== 0) stack.push({ type, data: first, flags: second, children: [] });
      continue;
    }
    if (kind === "s") {
      stack.push({ type, detail: { href: first, title: second }, children: [] });
      continue;
    }
    if (kind === "t") {
      if (type === 2) stack[stack.length - 1].children.push(createElement("br", {}));
      else stack[stack.length - 1].children.push(first);
      continue;
    }
    if (kind === "S") {
      const entry = stack.pop();
      const tag = markdownSpanTags[type];
      const props = {};
      if (type === 2) {
        props.href = entry.detail.href;
        if (entry.detail.title) props.title = entry.detail.title;
      } else if (type === 3) {
        props.src = entry.detail.href;
        if (entry.detail.title) props.title = entry.detail.title;
        const alt = entry.children.filter((child) => typeof child === "string").join("");
        if (alt) props.alt = alt;
      } else if (type === 8) {
        props.target = entry.detail.href;
      } else if (type === 7) {
        props.display = true;
        props.children = entry.children;
      }
      if (type !== 3 && props.children === undefined) props.children = entry.children;
      stack[stack.length - 1].children.push(createElement(tag, props));
      continue;
    }
    if (kind === "B") {
      if (type === 0) continue;
      const entry = stack.pop();
      const tag = type === 6 ? `h${Math.min(6, Math.max(1, entry.data))}` : markdownBlockTags[type];
      const props = {};
      if (type === 6 && first != null) props.id = first;
      else if (type === 3) props.start = entry.data;
      else if (type === 4) {
        const taskMark = entry.data & 0xff;
        if (taskMark !== 0) props.checked = taskMark !== 32;
      } else if (type === 7 && (entry.flags & 0x10) !== 0) {
        let end = entry.data;
        while (end < source.length && !/[\s]/.test(source[end])) end += 1;
        const language = source.slice(entry.data, end);
        if (language) props.language = language;
      } else if (type === 14 || type === 15) {
        const align = [undefined, "left", "center", "right"][entry.data & 3];
        if (align) props.align = align;
      }
      if (type !== 5) props.children = entry.children;
      stack[stack.length - 1].children.push(createElement(tag, props));
    }
  }
  return {
    $$typeof: elementSymbol,
    type: Symbol.for("react.fragment"),
    key: null,
    ref: null,
    props: { children: stack[0].children },
  };
}

export const markdown = {
  html(input, options = {}) {
    return cottontail.markdownHtml(markdownInput(input), markdownFlags(options));
  },
  render(input, callbacks = {}, options = {}) {
    return renderMarkdownCallbacks(markdownInput(input), callbacks, options);
  },
  react(input, components = {}, options = {}) {
    return renderMarkdownReact(markdownInput(input), components, options);
  },
};
