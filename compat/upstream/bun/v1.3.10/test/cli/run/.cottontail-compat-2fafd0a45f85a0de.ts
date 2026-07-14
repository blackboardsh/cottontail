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
    try { return await globalThis.__cottontailImportModule(__ctText, "/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/cli/run/", options); }
    catch (error) { throw __ctNormalizeImportError(error); }
  }
  throw new Error(`Cannot find module '${__ctText}'`);
}
const __ctRuntimeRequire = __ctCreateRequire("/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/cli/run/");
import { SyncSubprocess } from "bun";
import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { bunEnv, bunExe, isWindows, tmpdirSync } from "harness";
import { tmpdir } from "os";
import { join, sep } from "path";

for (const flag of ["-e", "--print"]) {
  describe(`bun ${flag}`, () => {
    test("it works", async () => {
      const input = flag === "--print" ? '"hello world"' : 'console.log("hello world")';
      let { stdout } = Bun.spawnSync({
        cmd: [bunExe(), flag, input],
        env: bunEnv,
      });
      expect(stdout.toString("utf8")).toEqual("hello world\n");
    });

    test("import, tsx, require in esm, import.meta", async () => {
      const ref = await __ctImportDynamic("react", undefined);
      const input =
        flag === "--print"
          ? 'import {version} from "react"; console.log(JSON.stringify({version,file:"/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/cli/run/run-eval.test.ts",require:require("react").version})); <hello>world</hello>'
          : 'import {version} from "react"; console.log(JSON.stringify({version,file:"/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/cli/run/run-eval.test.ts",require:require("react").version})); console.log(<hello>world</hello>);';

      let { stdout } = Bun.spawnSync({
        cmd: [bunExe(), flag, input],
        env: bunEnv,
      });
      const json = {
        version: ref.version,
        file: join(process.cwd(), "[eval]"),
        require: ref.version,
      };
      expect(stdout.toString("utf8")).toEqual(JSON.stringify(json) + "\n<hello>world</hello>\n");
    });

    test("error has source map info 1", async () => {
      let { stderr } = Bun.spawnSync({
        cmd: [bunExe(), flag, '(throw new Error("hi" as 2))'],
        env: bunEnv,
      });
      expect(stderr.toString("utf8")).toInclude('"hi" as 2');
      expect(stderr.toString("utf8")).toInclude("Unexpected throw");
    });

    test("process.argv", async () => {
      function testProcessArgv(args: string[], expected: string[]) {
        const input = flag === "--print" ? "process.argv" : "console.log(process.argv)";
        let { stdout, stderr, exitCode } = Bun.spawnSync({
          cmd: [bunExe(), flag, input, ...args],
          env: bunEnv,
        });

        expect(stderr.toString("utf8")).toBe("");
        expect(JSON.parse(stdout.toString("utf8"))).toEqual(expected);
        expect(exitCode).toBe(0);
      }

      // replace the trailin
      const exe = isWindows ? bunExe().replaceAll("/", "\\") : bunExe();
      testProcessArgv([], [exe]);
      testProcessArgv(["abc", "def"], [exe, "abc", "def"]);
      testProcessArgv(["--", "abc", "def"], [exe, "abc", "def"]);
      // testProcessArgv(["--", "abc", "--", "def"], [exe, "abc", "--", "def"]);
    });

    test("process._eval", async () => {
      const code = flag === "--print" ? "process._eval" : "console.log(process._eval)";
      const { stdout } = Bun.spawnSync({
        cmd: [bunExe(), flag, code],
        env: bunEnv,
      });
      expect(stdout.toString("utf8")).toEqual(code + "\n");
    });

    test("does not crash in non-latin1 directory", async () => {
      const dir = join(tmpdirSync(), "eval-test-开始学习");
      await Bun.write(join(dir, "index.js"), "console.log('hello world')");

      const { stdout, stderr, exitCode } = Bun.spawnSync({
        cmd: [bunExe(), flag, "import './index.js'"],
        env: bunEnv,
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });

      expect(stderr.toString("utf8")).toBe("");
      expect(stdout.toString("utf8")).toEqual("hello world\n" + (flag === "--print" ? "undefined\n" : ""));
      expect(exitCode).toBe(0);
    });
  });
}

describe("--print for cjs/esm", () => {
  test("eval result between esm imports", async () => {
    let cwd = tmpdirSync();
    writeFileSync(join(cwd, "foo.js"), "'foo'");
    writeFileSync(join(cwd, "bar.js"), "'bar'");
    let { stdout, stderr, exitCode } = Bun.spawnSync({
      cmd: [bunExe(), "--print", 'import "./foo.js"; 123; import "./bar.js"'],
      cwd: cwd,
      env: bunEnv,
    });
    expect(stderr.toString("utf8")).toBe("");
    expect(stdout.toString("utf8")).toEqual("123\n");
    expect(exitCode).toBe(0);
    rmSync(cwd, { recursive: true, force: true });
  });
  test("forced cjs", async () => {
    let { stdout, stderr, exitCode } = Bun.spawnSync({
      cmd: [bunExe(), "--print", "module.exports; 123"],
      env: bunEnv,
    });
    expect(stderr.toString("utf8")).toBe("");
    expect(stdout.toString("utf8")).toEqual("123\n");
    expect(exitCode).toBe(0);
  });
  test("module, exports, require, __filename, __dirname", async () => {
    let { stdout, stderr, exitCode } = Bun.spawnSync({
      cmd: [
        bunExe(),
        "--print",
        `
        console.log(typeof module, typeof exports, typeof require, typeof __filename, typeof __dirname); 123
      `,
      ],
      env: bunEnv,
    });
    expect(stderr.toString("utf8")).toBe("");
    expect(stdout.toString("utf8")).toEqual("object object function string string\n123\n");
    expect(exitCode).toBe(0);
  });
  test("module._compile is require('module').prototype._compile", async () => {
    const { stdout, exitCode } = Bun.spawnSync({
      cmd: [bunExe(), "-p", "module._compile === require('module').prototype._compile"],
      env: bunEnv,
    });
    expect(stdout.toString()).toBe("true\n");
    expect(exitCode).toBe(0);
  });
});

function group(run: (code: string) => SyncSubprocess<"pipe", "inherit">) {
  test("it works", async () => {
    const { stdout } = run('console.log("hello world")');
    expect(stdout.toString("utf8")).toEqual("hello world\n");
  });

  test("it gets a correct specifer", async () => {
    const { stdout } = run("console.log("/Users/yoav/.dash/stable/workspaces/local_ws_b6fdd7dfa81e45339823498c5f707d68/projects/cottontail/compat/upstream/bun/v1.3.10/test/cli/run/run-eval.test.ts")");
    expect(stdout.toString("utf8")).toEndWith(sep + "[stdin]\n");
  });

  test("it can require", async () => {
    const { stdout } = run(`
        const process = require("node:process");
        console.log(process.platform);
      `);
    expect(stdout.toString("utf8")).toEqual(process.platform + "\n");
  });

  test("it can import", async () => {
    const { stdout } = run(`
        import * as process from "node:process";
        console.log(process.platform);
      `);
    expect(stdout.toString("utf8")).toEqual(process.platform + "\n");
  });

  test("process.argv", async () => {
    const { stdout } = run("console.log(process.argv)");
    const exe = isWindows ? bunExe().replaceAll("/", "\\") : bunExe();
    expect(JSON.parse(stdout.toString("utf8"))).toEqual([exe, "-"]);
  });

  test("process._eval", async () => {
    const code = "console.log(process._eval)";
    const { stdout } = run(code);

    // the file piping one on windows can include extra carriage returns
    if (isWindows) {
      expect(stdout.toString("utf8")).toInclude(code);
    } else {
      expect(stdout.toString("utf8")).toEqual(code + "\n");
    }
  });
}

describe("bun run - < file-path.js", () => {
  function run(code: string) {
    // bash only supports / as path separator
    const file = join(tmpdir(), "bun-run-eval-test.js").replaceAll("\\", "/");
    require("fs").writeFileSync(file, code);
    try {
      let result;
      if (process.platform === "win32") {
        result = Bun.spawnSync(["powershell", "-c", `Get-Content ${file} | ${bunExe()} run -`], {
          env: bunEnv,
          stderr: "inherit",
        });
      } else {
        result = Bun.spawnSync(["bash", "-c", `${bunExe()} run - < ${file}`], {
          env: bunEnv,
          stderr: "inherit",
        });
      }

      if (!result.success) {
        queueMicrotask(() => {
          throw new Error("bun run - < file-path.js failed");
        });
      }

      return result;
    } finally {
      try {
        require("fs").unlinkSync(file);
      } catch (e) {}
    }
  }

  group(run);
});

describe("echo | bun run -", () => {
  function run(code: string) {
    const result = Bun.spawnSync([bunExe(), "run", "-"], {
      env: bunEnv,
      stdin: Buffer.from(code),
      stderr: "inherit",
    });
    if (!result.success) {
      queueMicrotask(() => {
        throw new Error("bun run - failed");
      });
    }

    return result;
  }

  group(run);
});

test("process._eval (undefined for normal run)", async () => {
  const cwd = tmpdirSync();
  const file = join(cwd, "test.js");
  writeFileSync(file, "console.log(typeof process._eval)");

  const { stdout } = Bun.spawnSync({
    cmd: [bunExe(), "run", file],
    cwd: cwd,
    env: bunEnv,
  });
  expect(stdout.toString("utf8")).toEqual("undefined\n");

  rmSync(cwd, { recursive: true, force: true });
});
