import { expect, test } from "bun:test";
import {
  createSourceMapConsumer,
  formatUncaughtBundleError,
  remapStackString,
} from "../../src/runtime_modules/vendor/sourcemap.js";

test("large source maps decode only the requested source content", () => {
  const selectedSource = [
    'const message = "escaped\\ntext";',
    "throw new Error(message);",
    "",
  ].join("\n");
  const map = JSON.stringify({
    version: 3,
    metadata: { nested: [{ ignored: true }] },
    names: [],
    sources: ["src/input.js", "src/unrelated.js"],
    sourcesContent: [selectedSource, "x".repeat(2 * 1024 * 1024)],
    sourceRoot: "../",
    mappings: "AAAA;AACA",
  });

  const consumer = createSourceMapConsumer(map, {
    mapPath: "/tmp/project/out/app.js.map",
    bundlePath: "/tmp/project/out/app.js",
    sourceRoot: "/tmp/project/out",
  });

  expect(consumer?.originalPositionFor(2, 1)).toEqual({
    source: "/tmp/project/src/input.js",
    line: 2,
    column: 1,
    lines: selectedSource.split("\n"),
  });
});

test("Windows bundle frames remap case-insensitively without duplicating an absolute source root", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };

  try {
    runtimeGlobal.__cottontailBundlePath = "C:\\Repo\\run\\script.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["[eval]"],
      sourcesContent: ['throw new Error("boom");'],
      sourceRoot: "C:\\Repo",
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "C:\\Repo";

    expect(remapStackString("boom@c:\\repo\\run\\script.bundle.mjs:1:1"))
      .toBe("boom@C:/Repo/[eval]:1:1");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("uncaught formatting recovers nested inline source context and preserves caller frames", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };
  const originalSource = 'throw new Error("nested boom");\n';
  const nestedMap = JSON.stringify({
    version: 3,
    names: [],
    sources: ["/tmp/project/src/input.ts"],
    sourcesContent: [originalSource],
    mappings: "AAAA",
  });
  const bundledSource = [
    'throw new Error("nested boom");',
    `//# sourceMappingURL=data:application/json;base64,${Buffer.from(nestedMap).toString("base64")}`,
  ].join("\n");

  try {
    runtimeGlobal.__cottontailBundlePath = "/tmp/project/runtime.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["/tmp/project/out.js"],
      sourcesContent: [bundledSource],
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "/tmp/project";

    const error = new Error("nested boom");
    error.stack = [
      "Error: nested boom",
      "    at /tmp/project/runtime.bundle.mjs:1:1",
      "    at caller (/tmp/project/src/caller.ts:2:3)",
      "wrapper@file:///tmp/project/runtime.bundle.mjs:99:1",
    ].join("\n");

    expect(formatUncaughtBundleError(error)).toBe(true);
    expect(error.stack).toContain('1 | throw new Error("nested boom");');
    expect(error.stack).toContain("at /tmp/project/src/input.ts:1:1");
    expect(error.stack).toContain("at caller (/tmp/project/src/caller.ts:2:3)");
    expect(error.stack).not.toContain("runtime.bundle.mjs");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("uncaught formatting reports a Bun bundle that has no source-map directive", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };

  try {
    runtimeGlobal.__cottontailBundlePath = "/tmp/project/runtime.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["/tmp/project/out.js"],
      sourcesContent: ['// @bun\nthrow new Error("boom");\n'],
      mappings: "AACA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "/tmp/project";

    const error = new Error("boom");
    error.stack = "Error: boom\n    at /tmp/project/runtime.bundle.mjs:1:1";

    expect(formatUncaughtBundleError(error)).toBe(true);
    expect(error.stack).toContain("\nnote: missing sourcemaps for /tmp/project/out.js\n");
    expect(error.stack).toEndWith("note: consider bundling with '--sourcemap' to get unminified traces");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("uncaught formatting prefers nested source text when an inline map reuses the outer source path", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };
  const sharedSource = "/tmp/project/shared.ts";
  const nestedMap = JSON.stringify({
    version: 3,
    names: [],
    sources: [sharedSource],
    sourcesContent: ['throw new Error("nested original");\n'],
    mappings: "AAAA",
  });
  const generatedSource = [
    'throw new Error("outer generated");',
    `//# sourceMappingURL=data:application/json;base64,${Buffer.from(nestedMap).toString("base64")}`,
  ].join("\n");

  try {
    runtimeGlobal.__cottontailBundlePath = "/tmp/project/runtime.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: [sharedSource],
      sourcesContent: [generatedSource],
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "/tmp/project";

    const error = new Error("boom");
    error.stack = "Error: boom\n    at /tmp/project/runtime.bundle.mjs:1:1";

    expect(formatUncaughtBundleError(error)).toBe(true);
    expect(error.stack).toContain('1 | throw new Error("nested original");');
    expect(error.stack).not.toContain("outer generated");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("uncaught formatting resolves encoded Windows drive and UNC file URLs", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };

  try {
    runtimeGlobal.__cottontailBundlePath = "C:\\Repo\\run\\script.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["file:///C:/Repo/src/Input%20File.ts"],
      sourcesContent: ['throw new Error("drive context");\n'],
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "C:\\Repo";
    const driveError = new Error("drive");
    driveError.stack = "Error: drive\nframe@file:///c:/repo/src/Input%20File.ts:1:1";

    expect(formatUncaughtBundleError(driveError)).toBe(true);
    expect(driveError.stack).toContain('1 | throw new Error("drive context");');

    runtimeGlobal.__cottontailBundlePath = "\\\\Server\\Share\\run\\script.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["file://Server/Share/src/Input%20File.ts"],
      sourcesContent: ['throw new Error("UNC context");\n'],
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "\\\\Server\\Share";
    const uncError = new Error("UNC");
    uncError.stack = "Error: UNC\nframe@file://server/share/src/Input%20File.ts:1:1";

    expect(formatUncaughtBundleError(uncError)).toBe(true);
    expect(uncError.stack).toContain('1 | throw new Error("UNC context");');
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("stack remapping filters encoded Windows drive and UNC active-bundle file URLs", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };
  const mapData = JSON.stringify({
    version: 3,
    names: [],
    sources: ["/tmp/project/input.ts"],
    sourcesContent: ["export {};\n"],
    mappings: "AAAA",
  });

  try {
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = mapData;
    runtimeGlobal.__cottontailBundleSourceRoot = "/tmp/project";

    runtimeGlobal.__cottontailBundlePath = "C:\\Repo With Space\\run\\script.bundle.mjs";
    const driveStack = remapStackString([
      "Error: boom",
      "wrapper@file:///c:/repo%20with%20space/run/script.bundle.mjs:999:1",
      "caller@file:///c:/repo%20with%20space/src/caller.ts:2:3",
    ].join("\n"));
    expect(driveStack).not.toContain("script.bundle.mjs");
    expect(driveStack).toContain("caller@file:///c:/repo%20with%20space/src/caller.ts:2:3");

    runtimeGlobal.__cottontailBundlePath = "\\\\Server\\Share Name\\run\\script.bundle.mjs";
    const uncStack = remapStackString([
      "Error: boom",
      "wrapper@file://server/Share%20Name/run/script.bundle.mjs:999:1",
      "caller@file://server/Share%20Name/src/caller.ts:2:3",
    ].join("\n"));
    expect(uncStack).not.toContain("script.bundle.mjs");
    expect(uncStack).toContain("caller@file://server/Share%20Name/src/caller.ts:2:3");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("stack remapping filters anonymous async V8 active-bundle file URL frames", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };

  try {
    runtimeGlobal.__cottontailBundlePath = "C:\\Repo With Space\\run\\script.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["/tmp/project/input.ts"],
      sourcesContent: ["export {};\n"],
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "/tmp/project";

    const stack = remapStackString([
      "Error: boom",
      "    at async file:///c:/repo%20with%20space/run/script.bundle.mjs:999:1",
      "    at async file:///c:/repo%20with%20space/src/caller.ts:2:3",
    ].join("\n"));
    expect(stack).not.toContain("script.bundle.mjs");
    expect(stack).toContain("at async file:///c:/repo%20with%20space/src/caller.ts:2:3");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("missing-sourcemap notes recognize a Bun pragma after a hashbang", () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };
  const sourceMap = (source: string) => JSON.stringify({
    version: 3,
    names: [],
    sources: ["/tmp/project/out.js"],
    sourcesContent: [source],
    mappings: "AAEA",
  });

  try {
    runtimeGlobal.__cottontailBundlePath = "/tmp/project/runtime.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceRoot = "/tmp/project";
    runtimeGlobal.__cottontailBundleSourceMapData = sourceMap([
      "#!/usr/bin/env bun",
      "// @bun",
      'throw new Error("boom");',
    ].join("\n"));
    const missingMap = new Error("boom");
    missingMap.stack = "Error: boom\n    at /tmp/project/runtime.bundle.mjs:1:1";

    expect(formatUncaughtBundleError(missingMap)).toBe(true);
    expect(missingMap.stack).toContain("note: missing sourcemaps for /tmp/project/out.js");
    expect(missingMap.stack).toContain("note: consider bundling with '--sourcemap'");

    runtimeGlobal.__cottontailBundleSourceMapData = sourceMap([
      "#!/usr/bin/env bun",
      "// @bun",
      'throw new Error("boom");',
      "//# sourceMappingURL=out.js.map",
    ].join("\n"));
    const advertisedMap = new Error("boom");
    advertisedMap.stack = "Error: boom\n    at /tmp/project/runtime.bundle.mjs:1:1";

    expect(formatUncaughtBundleError(advertisedMap)).toBe(true);
    expect(advertisedMap.stack).not.toContain("note: missing sourcemaps");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});

test("uncaught formatting prefers a readable external frame over a later embedded-runtime frame", async () => {
  const runtimeGlobal = globalThis as typeof globalThis & {
    __cottontailBundlePath?: string;
    __cottontailBundleSourceMap?: string;
    __cottontailBundleSourceMapData?: string;
    __cottontailBundleSourceRoot?: string;
  };
  const previous = {
    bundlePath: runtimeGlobal.__cottontailBundlePath,
    sourceMap: runtimeGlobal.__cottontailBundleSourceMap,
    sourceMapData: runtimeGlobal.__cottontailBundleSourceMapData,
    sourceRoot: runtimeGlobal.__cottontailBundleSourceRoot,
  };
  const externalSource = import.meta.path;
  const externalLines = (await Bun.file(externalSource).text()).split(/\r?\n/);
  const marker = "external dynamic module frame marker";
  const markerLine = externalLines.findIndex(line => line.includes(marker)) + 1;

  try {
    runtimeGlobal.__cottontailBundlePath = "/tmp/project/script.bundle.mjs";
    runtimeGlobal.__cottontailBundleSourceMap = undefined;
    runtimeGlobal.__cottontailBundleSourceMapData = JSON.stringify({
      version: 3,
      names: [],
      sources: ["/.cottontail-embedded-runtime/node/module.js"],
      sourcesContent: ["internal runtime frame\n"],
      mappings: "AAAA",
    });
    runtimeGlobal.__cottontailBundleSourceRoot = "/tmp/project";

    expect(markerLine).toBeGreaterThan(0);
    const error = new TypeError("dynamic failure");
    error.stack = [
      "TypeError: dynamic failure",
      `@${externalSource}:${markerLine}:1`,
      "@/tmp/project/script.bundle.mjs:1:1",
    ].join("\n");

    expect(formatUncaughtBundleError(error)).toBe(true);
    expect(error.stack).toContain(marker);
    expect(error.stack).toContain(`at ${externalSource}:${markerLine}:1`);
    expect(error.stack).not.toContain("internal runtime frame");
  } finally {
    runtimeGlobal.__cottontailBundlePath = previous.bundlePath;
    runtimeGlobal.__cottontailBundleSourceMap = previous.sourceMap;
    runtimeGlobal.__cottontailBundleSourceMapData = previous.sourceMapData;
    runtimeGlobal.__cottontailBundleSourceRoot = previous.sourceRoot;
  }
});
