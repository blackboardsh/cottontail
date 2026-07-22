import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  composeBakeClientHotUpdateSourceMap,
  createBakeSourceMapRecord,
  normalizeBakeServerStack,
  normalizeBakeClientSourceMap,
  registerBakeServerPatch,
} from "../../src/runtime_modules/bun/bake-source-map.js";

const { SourceMap } = require("node:module");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryRoot(name: string) {
  const root = join(tmpdir(), `cottontail-${name}-${process.pid}-${Date.now()}-${temporaryRoots.length}`);
  temporaryRoots.push(root);
  return root;
}

function positionAt(source: string, search: string) {
  const offset = source.indexOf(search);
  expect(offset).toBeGreaterThanOrEqual(0);
  const prefix = source.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length - 1, column: lines.at(-1)!.length };
}

test("Bake initial client maps use stable file URLs and compiler-relocated source indexes", () => {
  const root = temporaryRoot("bake-initial-map");
  const generatedSource = "first\nsecond\n";
  const record = createBakeSourceMapRecord(generatedSource, {
    version: 3,
    sources: ["entry.ts"],
    sourcesContent: ["first\nsecond\n"],
    names: [],
    mappings: "AAAA;AACA",
  }, { mapPath: join(root, "entry.js.map"), projectRoot: root });
  const payload = normalizeBakeClientSourceMap(record, {
    leadingSources: ["index.html"],
    preferredSources: ["entry.ts"],
  });

  expect(payload.sources).toEqual([
    "bun://Bun/Bun HMR Runtime",
    pathToFileURL(join(root, "index.html")).href,
    pathToFileURL(join(root, "entry.ts")).href,
  ]);
  expect(new SourceMap(payload).findEntry(1, 0)).toMatchObject({
    originalSource: payload.sources[2],
    originalLine: 1,
    originalColumn: 0,
  });
});

test("Bake HMR maps relocate serialized module factories", () => {
  const root = temporaryRoot("bake-hmr-map");
  const factory = `(hmr) => {\n  console.log("magic");\n}`;
  const generatedSource = `prefix\n  // App.tsx\n  "App.tsx": [[],[],[],${factory},false]\n`;
  const record = createBakeSourceMapRecord(generatedSource, {
    version: 3,
    sources: ["App.tsx"],
    sourcesContent: [`line one\nconsole.log("magic");\n`],
    names: [],
    mappings: ";;;EACY",
  }, { mapPath: join(root, "entry.js.map"), projectRoot: root });
  const outputSource = `globalThis[Symbol.for("bun:hmr")]({"App.tsx":${factory}\n}, "1")\n`;
  const payload = composeBakeClientHotUpdateSourceMap(outputSource, [{
    length: factory.length,
    moduleId: "App.tsx",
    originalOffset: 0,
    originalText: factory,
    outputStart: outputSource.indexOf(factory),
    record,
  }]);
  const generated = positionAt(outputSource, "magic");

  expect(payload.sources).toEqual([
    "bun://Bun/Bun HMR Runtime",
    pathToFileURL(join(root, "App.tsx")).href,
  ]);
  expect(new SourceMap(payload).findEntry(generated.line, generated.column)).toMatchObject({
    originalSource: payload.sources[1],
    originalLine: 1,
    originalColumn: 12,
  });
});

test("Bake server patches register their map before module factories execute", () => {
  const root = temporaryRoot("bake-server-map");
  const generatedSource = `(() => {})\n  // app.ts\n  "app.ts": [[],[],[],(hmr) => {\n    hmr.exports = { explode() {\n      throw new Error("mapped");\n    }};\n  },false]\n}, {\n  main: "app.ts"\n});`;
  const record = createBakeSourceMapRecord(generatedSource, {
    version: 3,
    sources: ["app.ts"],
    sourcesContent: ["\n\n\n\n\nthrow new Error(\"mapped\");\n"],
    names: [],
    // SourceMapStore places this chunk after the one-line HMR invocation.
    mappings: ";;;MAKe",
  }, { mapPath: join(root, "entry.js.map"), projectRoot: root });
  const registration = registerBakeServerPatch(generatedSource, record, "focused-test");
  const patchSource = readFileSync(registration.filename, "utf8");
  const generated = positionAt(patchSource, "mapped");

  expect(new SourceMap(registration.sourceMap).findEntry(generated.line, generated.column)).toMatchObject({
    originalSource: join(root, "app.ts"),
    originalLine: 5,
    originalColumn: 15,
  });

  const hmr = { exports: {} as { explode?: () => void } };
  registration.modules["app.ts"][3](hmr);
  try {
    hmr.exports.explode!();
    throw new Error("expected mapped error");
  } catch (error: any) {
    const stack = globalThis.__cottontailRemapModuleStackString(String(error.stack));
    expect(stack).toContain(`${join(root, "app.ts")}:6:16`);
  }
});

test("Bake server stacks preserve DevServer renamer frames for imported exports", () => {
  const root = temporaryRoot("bake-server-renamer");
  const generatedSource = `(() => {})
  // lib/utils.ts
  "lib/utils.ts": [[],["doSomething"],[],(hmr) => {
    function doSomething() {}
    hmr.exports = { doSomething };
  },false],

  // pages/nested.tsx
  "pages/nested.tsx": [["lib/utils.ts",1,"doSomething"],["default"],[],(hmr) => {
    const [utils] = hmr.imports;
    hmr.exports = { default() { return utils.doSomething(); } };
  },false]
}, {
  main: "pages/nested.tsx"
});`;
  const record = createBakeSourceMapRecord(generatedSource, {
    version: 3,
    sources: ["lib/utils.ts", "pages/nested.tsx"],
    sourcesContent: [
      "export function doSomething() {\n  return helperFunction();\n}\n",
      "import { doSomething } from '../lib/utils';\n",
    ],
    names: [],
    mappings: "AAAA",
  }, { mapPath: join(root, "entry.js.map"), projectRoot: root });
  const registration = registerBakeServerPatch(generatedSource, record, "renamer-test");
  const stack = `Error: nested\n    doSomething@${join(root, "lib/utils.ts")}:1:31`;

  expect(normalizeBakeServerStack(stack, [registration])).toContain(
    `doSomething2@${join(root, "lib/utils.ts")}:1:28`,
  );
});
