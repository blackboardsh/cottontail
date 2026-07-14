import { Database as __ctLoaderDatabase } from "bun:sqlite";
import { createRequire as __ctCreateRequire } from "node:module";
import { parse as __ctParseJSON5 } from "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/.cottontail-embedded-runtime/bun/json5.js";
import { parse as __ctParseRuntimeTOML } from "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/.cottontail-embedded-runtime/bun/toml.js";
import { parse as __ctParseRuntimeYAML } from "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/.cottontail-embedded-runtime/bun/yaml.js";
globalThis.Loader ??= { registry: new Map() };
globalThis.__cottontailModuleBindingListeners ??= new Map();
globalThis.__cottontailModuleBindingValues ??= new Map();
globalThis.__cottontailRegisterModuleBindings ??= (key, listener) => {
  key = String(key);
  const listeners = globalThis.__cottontailModuleBindingListeners.get(key) ?? [];
  listeners.push(listener);
  globalThis.__cottontailModuleBindingListeners.set(key, listeners);
  if (globalThis.__cottontailModuleBindingValues.has(key)) listener(globalThis.__cottontailModuleBindingValues.get(key));
};
function __ctNormalizeImportError(error) {
  if (error && error.code === "MODULE_NOT_FOUND") {
    error.code = "ERR_MODULE_NOT_FOUND";
    error.name = "ResolveMessage";
    error.line ??= 0;
    error.column ??= 0;
    error.position ??= { line: error.line, column: error.column };
  }
  return error;
}
function __ctLoaderNamespace(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) return Object.assign({ default: value }, value);
  return { default: value };
}
function __ctCommonJSNamespace(value, packageTypeModule) {
  const namespace = { default: value };
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    if (!packageTypeModule && value.__esModule === true && Object.hasOwn(value, "default")) {
      namespace.default = value.default;
    }
    for (const key of Object.keys(value)) {
      if (key === "default" || (!packageTypeModule && key === "__esModule")) continue;
      namespace[key] = value[key];
    }
  }
  return namespace;
}
function __ctMutableNamespace(value) {
  const namespace = {};
  for (const key of Object.keys(value ?? {})) {
    if (key !== "__esModule") namespace[key] = value[key];
  }
  return namespace;
}
function __ctStripJSONC(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"') { quote = char; output += char; continue; }
    if (char === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      output += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index++;
      index++;
      continue;
    }
    output += char;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}
function __ctParseJSONC(source) {
  if (source.trim() === "") return {};
  return JSON.parse(__ctStripJSONC(source));
}
function __ctStripDataComment(source, marker) {
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === marker) return source.slice(0, index);
  }
  return source;
}
function __ctParseDataScalar(source) {
  const value = source.trim().replace(/,$/, "").trim();
  if (value === "") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null" || value === "~") return null;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
  if (value[0] === '"') return JSON.parse(value);
  if (value[0] === "'" && value[value.length - 1] === "'") return value.slice(1, -1).replace(/''/g, "'");
  if (value[0] === "[" || value[0] === "{") return JSON.parse(value);
  return value;
}
function __ctParseTOML(source) {
  const root = {};
  let current = root;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = __ctStripDataComment(rawLine, "#").trim();
    if (!line) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const path = line.slice(1, -1).trim().split(".");
      if (path.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw new SyntaxError("Invalid TOML section");
      current = root;
      for (const part of path) current = current[part] ??= {};
      continue;
    }
    const equals = line.indexOf("=");
    if (equals <= 0) throw new SyntaxError("Invalid TOML assignment");
    const key = line.slice(0, equals).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new SyntaxError("Invalid TOML key");
    current[key] = __ctParseDataScalar(line.slice(equals + 1));
  }
  return root;
}
function __ctYAMLColon(line) {
  let quote = "";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) { if (char === quote && line[index - 1] !== "\\") quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === ":") return index;
  }
  return -1;
}
function __ctParseYAML(source) {
  if (source.trim() === "") return {};
  try {
    const jsonValue = __ctParseJSONC(source);
    if (jsonValue !== null && typeof jsonValue === "object" && !Array.isArray(jsonValue)) {
      for (const line of source.split(/\r?\n/)) {
        const comment = line.match(/\/\/\s*([^,}\r\n]+)\s*[,}]?\s*$/);
        if (comment) jsonValue[`// ${comment[1].trim()}`] = null;
      }
    }
    return jsonValue;
  } catch {}
  const root = {};
  const stack = [{ indent: -1, value: root }];
  let sawMapping = false;
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#") || rawLine.trim() === "---") continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = __ctStripDataComment(rawLine.trim(), "#").trim();
    const colon = __ctYAMLColon(line);
    if (colon <= 0) continue;
    sawMapping = true;
    let key = line.slice(0, colon).trim();
    if ((key[0] === '"' && key.at(-1) === '"') || (key[0] === "'" && key.at(-1) === "'")) key = key.slice(1, -1);
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    const rest = line.slice(colon + 1).trim();
    if (rest === "") {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else parent[key] = __ctParseDataScalar(rest);
  }
  if (sawMapping) return root;
  if (/\r?\n/.test(source)) throw new SyntaxError("Invalid YAML document");
  return source.trim();
}
const __ctPath0 = "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte/hello.svelte";
const __ctURL0 = "file:///Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte/hello.svelte";
async function __ctLoad0(specifier, options) {
  const __ctText = String(specifier);
  const __ctMarker = __ctText.search(/[?#]/);
  const __ctSuffix = __ctMarker < 0 ? "" : __ctText.slice(__ctMarker);
  const __ctInferredType = "file";
  const __ctType = options?.with?.type ?? options?.assert?.type ?? options?.type ?? (__ctSuffix === "?raw" ? "text" : __ctInferredType);
  const __ctKey = __ctPath0 + __ctSuffix + (__ctType == null ? "" : "\\u0000" + __ctType);
  const __ctRegistry = globalThis.Loader.registry;
  if (__ctRegistry.has(__ctKey)) return await __ctRegistry.get(__ctKey);
  const __ctPromise = (async () => {
    const __ctImportMeta = { url: __ctURL0 + __ctSuffix, dir: "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte", dirname: "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte", file: "hello.svelte", path: __ctPath0, filename: __ctPath0, main: false };
    const __ctRaw = "<script>\n  let name = \"world\";\n</script>\n\n<h1>Hello {name}!</h1>\n";
    if (__ctType === "text") return { default: __ctRaw };
    if (__ctType === "file" || __ctType === "css") return { default: __ctPath0 };
    if (__ctType === "html") return { default: { index: __ctPath0 } };
    if (__ctType === "json") return __ctLoaderNamespace(JSON.parse(__ctRaw));
    if (__ctType === "jsonc") return __ctLoaderNamespace(__ctParseJSONC(__ctRaw));
    if (__ctType === "json5") return __ctLoaderNamespace(__ctParseJSON5(__ctRaw));
    if (__ctType === "toml") return __ctLoaderNamespace(__ctParseRuntimeTOML(__ctRaw));
    if (__ctType === "yaml") return __ctLoaderNamespace(__ctRaw.trim() === "" ? {} : __ctParseRuntimeYAML(__ctRaw));
    if (__ctType === "wasm" || __ctType === "base64" || __ctType === "dataurl") {
      if (__ctRaw.length === 0) return { default: __ctPath0 };
    }
    if (__ctType === "sqlite" || __ctType === "sqlite_embedded") {
      const __ctDatabase = new __ctLoaderDatabase(__ctPath0);
      for (const __ctKey of Object.keys(__ctDatabase)) {
        if (__ctKey !== "filename") Object.defineProperty(__ctDatabase, __ctKey, { enumerable: false });
      }
      return { db: __ctDatabase, default: __ctDatabase };
    }
    if (__ctType != null && __ctType !== "js" && __ctType !== "jsx" && __ctType !== "ts" && __ctType !== "tsx") {
      throw new TypeError(`Unsupported loader type: ${__ctType}`);
    }
    { const error = new SyntaxError("Unable to parse module with the selected loader"); error.name = "BuildMessage"; throw error; }
    const module = { exports: {} };
    const exports = module.exports;
    return module.exports;
  })();
  __ctRegistry.set(__ctKey, __ctPromise);
  try { return await __ctPromise; } catch (error) { __ctRegistry.delete(__ctKey); throw __ctNormalizeImportError(error); }
}
async function __ctImportDynamic(specifier, options) {
  const __ctText = String(specifier);
  const __ctMarker = __ctText.search(/[?#]/);
  const __ctBare = __ctMarker < 0 ? __ctText : __ctText.slice(0, __ctMarker);
  if (__ctBare === "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte/hello.svelte" || __ctBare === "file:///Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte/hello.svelte") return __ctLoad0(__ctText, options);
  if (typeof globalThis.__cottontailImportModule === "function") {
    try { return await globalThis.__cottontailImportModule(__ctText, "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte/", options); }
    catch (error) { throw __ctNormalizeImportError(error); }
  }
  throw new Error(`Cannot find module '${__ctText}'`);
}
const __ctRuntimeRequire = __ctCreateRequire("/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/third_party/svelte/");
import { describe, expect, it } from "bun:test";
import { render as svelteRender } from "svelte/server";
import "./bun-loader-svelte";

describe("require", () => {
  it("SSRs `<h1>Hello world!</h1>` with Svelte", () => {
    const { default: App } = require("./hello.svelte");
    const { body } = svelteRender(App);

    expect(body).toBe("<!--[--><h1>Hello world!</h1><!--]-->");
  });

  it("works if you require it 1,000 times", () => {
    const prev = Bun.unsafe.gcAggressionLevel();
    Bun.unsafe.gcAggressionLevel(0);
    for (let i = 0; i < 1000; i++) {
      const { default: App } = (await __ctLoad0("./hello.svelte?r" + i, undefined));
      expect(App).toBeFunction();
    }
    Bun.gc(true);
    Bun.unsafe.gcAggressionLevel(prev);
  });
});

describe("dynamic import", () => {
  it("works if you import it 1,000 times", async () => {
    const prev = Bun.unsafe.gcAggressionLevel();
    Bun.unsafe.gcAggressionLevel(0);
    for (let i = 0; i < 1000; i++) {
      const { default: App } = await __ctLoad0("./hello.svelte?i" + i, { with: { type: "file" } });
      expect(App).toBeFunction();
    }
    Bun.gc(true);
    Bun.unsafe.gcAggressionLevel(prev);
  });
  it("SSRs `<h1>Hello world!</h1>` with Svelte", async () => {
    const { default: App }: any = await __ctLoad0("./hello.svelte", { with: { type: "file" } });

    const { body } = svelteRender(App);
    expect(body).toBe("<!--[--><h1>Hello world!</h1><!--]-->");
  });
});
