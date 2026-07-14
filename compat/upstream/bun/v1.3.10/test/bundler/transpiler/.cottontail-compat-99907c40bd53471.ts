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
    try { return await globalThis.__cottontailImportModule(__ctText, "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/bundler/transpiler/", options); }
    catch (error) { throw __ctNormalizeImportError(error); }
  }
  throw new Error(`Cannot find module '${__ctText}'`);
}
const __ctRuntimeRequire = __ctCreateRequire("/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/bundler/transpiler/");
import { beforeEach, describe, expect, test } from "bun:test";
import { bunEnv, bunExe } from "harness";

test("use strict causes CommonJS", () => {
  const { stdout, exitCode } = Bun.spawnSync({
    cmd: [bunExe(), __ctRuntimeRequire.resolve("./use-strict-fixture.js")],
    env: bunEnv,
  });
  expect(stdout.toString()).toBe("function\n");
  expect(exitCode).toBe(0);
});

test("non-ascii regexp literals", () => {
  var str = "🔴11 54 / 10,000";
  expect(str.replace(/[🔵🔴,]+/g, "")).toBe("11 54 / 10000");
});

test("ascii regex with escapes", () => {
  expect(/^[-#!$@£%^&*()_+|~=`{}\[\]:";'<>?,.\/ ]$/).toBeInstanceOf(RegExp);
});

describe("// @bun", () => {
  beforeEach(() => {
    delete require.cache[require.resolve("./async-transpiler-entry")];
    delete require.cache[require.resolve("./async-transpiler-imported")];
  });

  test("async transpiler", async () => {
    const { default: value, hbs } = await import("./async-transpiler-entry");
    expect(value).toBe(42);
    expect(hbs).toBeString();
  });

  test("require()", async () => {
    const { default: value, hbs } = require("./async-transpiler-entry");
    expect(value).toBe(42);
    expect(hbs).toBeString();
  });

  test("synchronous", async () => {
    const { stdout, exitCode } = Bun.spawnSync({
      cmd: [bunExe(), require.resolve("./async-transpiler-imported")],
      cwd: import.meta.dir,
      env: bunEnv,
      stderr: "inherit",
      stdout: "pipe",
    });
    expect(stdout.toString()).toBe("Hello world!\n");
    expect(exitCode).toBe(0);
  });
});

describe("json imports", () => {
  test("require(*.json)", async () => {
    const {
      name,
      description,
      players,
      version,
      creator,
      default: defaultExport,
      ...other
    } = require("./runtime-transpiler-json-fixture.json");
    const obj = {
      "name": "Spiral 4v4 NS",
      "description": "4v4 unshared map. 4 spawns in a spiral. Preferred to play with 4v4 NS.",
      "version": "1.0",
      "creator": "Grand Homie",
      "players": [8, 8],
      default: { a: 1 },
    };
    expect({
      name,
      description,
      players,
      version,
      creator,
      default: { a: 1 },
    }).toEqual(obj);
    expect(other).toEqual({});

    // This tests that importing and requiring when already in the cache keeps the state the same
    {
      const {
        name,
        description,
        players,
        version,
        creator,
        default: defaultExport,
        // @ts-ignore
      } = await import("./runtime-transpiler-json-fixture.json");
      const obj = {
        "name": "Spiral 4v4 NS",
        "description": "4v4 unshared map. 4 spawns in a spiral. Preferred to play with 4v4 NS.",
        "version": "1.0",
        "creator": "Grand Homie",
        "players": [8, 8],
        default: { a: 1 },
      };
      expect({
        name,
        description,
        players,
        version,
        creator,
        default: { a: 1 },
      }).toEqual(obj);
      // They should be strictly equal
      expect(defaultExport.players).toBe(players);
      expect(defaultExport).toEqual(obj);
    }

    delete require.cache[require.resolve("./runtime-transpiler-json-fixture.json")];
  });

  test("import(*.json)", async () => {
    const {
      name,
      description,
      players,
      version,
      creator,
      default: defaultExport,
      // @ts-ignore
    } = await import("./runtime-transpiler-json-fixture.json");
    delete require.cache[require.resolve("./runtime-transpiler-json-fixture.json")];
    const obj = {
      "name": "Spiral 4v4 NS",
      "description": "4v4 unshared map. 4 spawns in a spiral. Preferred to play with 4v4 NS.",
      "version": "1.0",
      "creator": "Grand Homie",
      "players": [8, 8],
      default: { a: 1 },
    };
    expect({
      name,
      description,
      players,
      version,
      creator,
      default: { a: 1 },
    }).toEqual(obj);
    // They should be strictly equal
    expect(defaultExport.players).toBe(players);
    expect(defaultExport).toEqual(obj);
  });

  test("should support comments in tsconfig.json", async () => {
    // @ts-ignore
    const { buildOptions, default: defaultExport } = await import("./tsconfig.with-commas.json");
    delete require.cache[require.resolve("./tsconfig.with-commas.json")];
    const obj = {
      "buildOptions": {
        "outDir": "dist",
        "baseUrl": ".",
        "paths": {
          "src/*": ["src/*"],
        },
      },
    };
    expect({
      buildOptions,
    }).toEqual(obj);
    // They should be strictly equal
    expect(defaultExport.buildOptions).toBe(buildOptions);
    expect(defaultExport).toEqual(obj);
  });

  test("should handle non-boecjts in tsconfig.json", async () => {
    // @ts-ignore
    const { default: num } = await import("./tsconfig.is-just-a-number.json");
    delete require.cache[require.resolve("./tsconfig.is-just-a-number.json")];
    expect(num).toBe(1);
  });

  test("should handle duplicate keys", async () => {
    // @ts-ignore
    expect((await import("./runtime-transpiler-fixture-duplicate-keys.json")).a).toBe("4");
  });
});

describe("with statement", () => {
  test("works", () => {
    const { exitCode } = Bun.spawnSync({
      cmd: [bunExe(), require.resolve("./with-statement-works.js")],
      cwd: import.meta.dir,
      env: bunEnv,
      stderr: "inherit",
      stdout: "inherit",
      stdin: "inherit",
    });

    expect(exitCode).toBe(0);
  });
});

test("math.pow", () => {
  function foo1(foo) {
    return 10 ** (foo / 20);
  }

  function foo2(foo) {
    return foo ** -0.5;
  }

  expect(foo1(-1) + "").toEqual("0.8912509381337456");
  expect(10 ** (-1 / 20) + "").toEqual("0.8912509381337456");
  expect(foo2(20.4) + "").toEqual("0.22140372138502384");
  expect(20.4 ** -0.5 + "").toEqual("0.22140372138502384");
});
