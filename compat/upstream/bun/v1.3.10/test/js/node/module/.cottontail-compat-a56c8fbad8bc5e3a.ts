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
async function __ctImportDynamic(specifier, options) {
  const __ctText = String(specifier);
  const __ctMarker = __ctText.search(/[?#]/);
  const __ctBare = __ctMarker < 0 ? __ctText : __ctText.slice(0, __ctMarker);
  if (typeof globalThis.__cottontailImportModule === "function") {
    try { return await globalThis.__cottontailImportModule(__ctText, "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/node/module/", options); }
    catch (error) { throw __ctNormalizeImportError(error); }
  }
  throw new Error(`Cannot find module '${__ctText}'`);
}
const __ctRuntimeRequire = __ctCreateRequire("/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/js/node/module/");
import assert from "assert";
import { expect, mock, test } from "bun:test";
import { tempDirWithFiles } from "harness";
import path from "path";

test("require.extensions shape makes sense", () => {
  const extensions = require.extensions;
  expect(extensions).toBeDefined();
  expect(typeof extensions).toBe("object");
  expect(extensions[".js"]).toBeFunction();
  expect(extensions[".json"]).toBeFunction();
  expect(extensions[".node"]).toBeFunction();
  // When --experimental-strip-types is passed, TypeScript files can be loaded.
  expect(extensions[".cts"]).toBeFunction();
  expect(extensions[".ts"]).toBeFunction();
  expect(extensions[".mjs"]).toBeFunction();
  expect(extensions[".mts"]).toBeFunction();
  expect(require("module")._extensions === require.extensions).toBe(true);
});
test("custom require extension 1", () => {
  const custom = (require.extensions[".custom"] = mock(function (module, filename) {
    expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "c.custom"));
    (module as any)._compile(`module.exports = 'custom';`, filename);
  }));
  const mod = require("./extensions-fixture/c");
  expect(mod).toBe("custom");
  expect(custom.mock.calls.length).toBe(1);
  delete require.extensions[".custom"];
  expect(() => require("./extensions-fixture/c")).toThrow(/Cannot find module/);
  expect(require("./extensions-fixture/c.custom")).toBe("custom"); // already loaded
  delete require.cache[__ctRuntimeRequire.resolve("./extensions-fixture/c.custom")];
  expect(custom.mock.calls.length).toBe(1);
  expect(require("./extensions-fixture/c.custom")).toBe("c dot custom"); // use js loader
});
test("custom require extension overwrite default loader", () => {
  const original = require.extensions[".js"];
  try {
    const custom = (require.extensions[".js"] = mock(function (module, filename) {
      expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "d.js"));
      (module as any)._compile(`module.exports = 'custom';`, filename);
    }));
    const mod = require("./extensions-fixture/d");
    expect(mod).toBe("custom");
    expect(custom.mock.calls.length).toBe(1);
    require.extensions[".js"] = original;
    expect(require("./extensions-fixture/d")).toBe("custom"); // already loaded
    delete require.cache[__ctRuntimeRequire.resolve("./extensions-fixture/d")];
    expect(custom.mock.calls.length).toBe(1);
    expect(require("./extensions-fixture/d")).toBe("d.js"); // use js loader
  } finally {
    require.extensions[".js"] = original;
  }
});
test("custom require extension overwrite default loader with other default loader", () => {
  const original = require.extensions[".js"];
  try {
    require.extensions[".js"] = require.extensions[".ts"]!;
    const mod = require("./extensions-fixture/e.js"); // should not enter JS
    expect(mod).toBe("hello world");
  } finally {
    require.extensions[".js"] = original;
  }
});
test("test that assigning properties weirdly wont do anything bad", () => {
  const original = require.extensions[".js"];
  try {
    function f1() {}
    function f2() {}
    require.extensions[".js"] = f1;
    require.extensions[".abc"] = f2;
    require.extensions[".js"] = f2;
    require.extensions[".js"] = undefined!;
    require.extensions[".abc"] = undefined!;
    require.extensions[".abc"] = f1;
    require.extensions[".js"] = f2;
  } finally {
    require.extensions[".js"] = original;
  }
});
test("wrapping an existing extension with no logic", () => {
  const original = require.extensions[".js"];
  try {
    delete require.cache[__ctRuntimeRequire.resolve("./extensions-fixture/d")];
    const mocked = (require.extensions[".js"] = mock(function (module, filename) {
      expect(module).toBeDefined();
      expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "d.js"));
      original(module, filename);
    }));
    const mod = require("./extensions-fixture/d");
    expect(mod).toBe("d.js");
    expect(mocked).toBeCalled();
  } finally {
    require.extensions[".js"] = original;
  }
});
test("wrapping an existing extension with mutated compile function", () => {
  const original = require.extensions[".js"];
  try {
    delete require.cache[__ctRuntimeRequire.resolve("./extensions-fixture/d")];
    const mocked = (require.extensions[".js"] = mock(function (module, filename) {
      expect(module).toBeDefined();
      expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "d.js"));
      const originalCompile = module._compile;
      module._compile = function (code, filename) {
        expect(code).toBe('\n  module.exports = \"d.js\";\n');
        expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "d.js"));
        originalCompile.call(module, 'module.exports = "new";', filename);
      };
      original(module, filename);
    }));
    const mod = require("./extensions-fixture/d");
    expect(mod).toBe("new");
    expect(mocked).toBeCalled();
  } finally {
    require.extensions[".js"] = original;
  }
});
test("wrapping an existing extension with mutated compile function ts", () => {
  const original = require.extensions[".ts"];
  assert(original);
  try {
    delete require.cache[__ctRuntimeRequire.resolve("./extensions-fixture/e.js")];
    const mocked = (require.extensions[".js"] = mock(function (module, filename) {
      expect(module).toBeDefined();
      expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "e.js"));
      const originalCompile = module._compile;
      module._compile = function (code, filename) {
        expect(code).toBe(
          '\n  var J;\n  ((J) => J.x = \"hello\")(J ||= {});\n  const hello = \" world\";\n  module.exports = \"hello world\";\n',
        );
        expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "e.js"));
        originalCompile.call(module, 'module.exports = "new";', filename);
      };
      original(module, filename);
    }));
    const mod = require("./extensions-fixture/e");
    expect(mod).toBe("new");
    expect(mocked).toBeCalled();
  } finally {
    require.extensions[".js"] = original;
  }
});
test("wrapping an existing extension but it's secretly sync esm", () => {
  const original = require.extensions[".ts"];
  assert(original);
  try {
    delete require.cache[__ctRuntimeRequire.resolve("./extensions-fixture/secretly_esm.cjs")];
    let called = false;
    const mocked = (require.extensions[".cjs"] = mock(function (module, filename) {
      expect(module).toBeDefined();
      expect(filename).toBe(path.join(import.meta.dir, "extensions-fixture", "secretly_esm.cjs"));
      module._compile = function (code, filename) {
        called = true;
        throw new Error("should not be called");
      };
      original(module, filename);
    }));
    const mod = require("./extensions-fixture/secretly_esm");
    expect(mod).toEqual({ default: 1 });
    expect(mocked).toBeCalled();
  } finally {
    require.extensions[".cjs"] = original;
  }
});
test("mutating extensions is banned by some files", () => {
  // vercel is not allowed to mutate require.extensions
  const files = ["node_modules/next/dist/build/next-config-ts/index.js", "node_modules/@meteorjs/babel/index.js"];
  const fixture = tempDirWithFiles(
    "extensions-fixture",
    Object.fromEntries(
      files.map(file => [
        file,
        `
      const assert = require('assert');
      const mock = function (module, filename) {
        throw new Error('should not be called');
      };
      require.extensions['.js'] = mock;
      assert(require.extensions['.js'] !== mock);
      globalThis.pass += 1;
    `,
      ]),
    ),
  );
  globalThis.pass = 0;

  let n = 0;
  for (const file of files) {
    require(path.join(fixture, file));
    n++;
    expect(globalThis.pass).toBe(n);
  }
});
