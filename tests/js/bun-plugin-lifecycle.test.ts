import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => Bun.plugin.clearAll());

test("runtime callbacks preserve ordering, namespaces, and contracts", async () => {
  Bun.plugin.clearAll();
  const events: string[] = [];
  expect(Object.keys(Bun.plugin)).toContain("clearAll");
  expect(Bun.plugin.clearAll.length).toBe(1);

  const returned = Bun.plugin({
    name: "runtime-contracts",
    setup(this: unknown, build) {
      void this;
      expect(build.target).toBe("bun");
      const callbacks = {
        resolve(this: unknown, args: { importer: string; path: string }) {
          void this;
          events.push("resolve-second");
          expect(Object.keys(args).sort()).toEqual(["importer", "path"]);
          return Promise.resolve({ path: args.path, namespace: "contract-result" });
        },
        load(this: unknown, args: { path: string }) {
          void this;
          events.push("load");
          expect(Object.keys(args)).toEqual(["path"]);
          return { loader: "object" as const, exports: { value: args.path } };
        },
      };
      expect(build.onResolve({ filter: /.*/, namespace: "contract" }, () => {
        events.push("resolve-first");
        return null;
      })).toBe(build);
      build.onResolve({ filter: /.*/, namespace: "contract" }, callbacks.resolve);
      build.onLoad({ filter: /.*/, namespace: "contract-result" }, callbacks.load);
      return 123;
    },
  });

  expect(returned).toBeUndefined();
  expect((await import("contract:item")).value).toBe("item");
  expect(events).toEqual(["resolve-first", "resolve-second", "load"]);
});

test("runtime onLoad rejection releases the pending module", async () => {
  Bun.plugin.clearAll();
  const sentinel = new Error("runtime onLoad sentinel");
  let calls = 0;
  Bun.plugin({
    name: "retry-rejected-load",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: "retry-load" }, () => {
        calls++;
        if (calls === 1) return Promise.reject(sentinel);
        return { loader: "object", exports: { value: 42 } };
      });
    },
  });

  let caught: unknown;
  try {
    await import("retry-load:item");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(sentinel);
  expect((await import("retry-load:item")).value).toBe(42);
  expect(calls).toBe(2);
});

test("runtime onResolve rejects pending promises", async () => {
  Bun.plugin.clearAll();
  Bun.plugin({
    name: "pending-resolve",
    setup(build) {
      build.onResolve({ filter: /.*/, namespace: "pending-resolve" }, () => new Promise(() => {}));
    },
  });

  let error: unknown;
  try {
    await import("pending-resolve:item");
  } catch (caught) {
    error = caught;
  }
  expect(String(error)).toContain("onResolve() doesn't support pending promises yet");
});

test("clearAll does not recache pending virtual modules", async () => {
  Bun.plugin.clearAll();
  const id = "cottontail-plugin-pending-generation";
  let finish!: (value: object) => void;
  const value = new Promise<object>(resolve => { finish = resolve; });
  Bun.plugin({
    name: "pending-virtual",
    setup(build) {
      build.module(id, () => value);
    },
  });

  const pending = import(id);
  await Promise.resolve();
  Bun.plugin.clearAll();
  finish({ loader: "object", exports: { value: "old" } });
  expect((await pending).value).toBe("old");
  await Promise.resolve();

  let rejected = false;
  try {
    await import(id);
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);

  Bun.plugin({
    name: "replacement-virtual",
    setup(build) {
      build.module(id, () => ({ loader: "object", exports: { value: "new" } }));
    },
  });
  expect((await import(id)).value).toBe("new");
});

test("virtual modules can be overridden across require and import", async () => {
  Bun.plugin.clearAll();
  const id = "cottontail-plugin-override";
  Bun.plugin({
    name: "initial-virtual",
    setup(build) {
      build.module(id, () => ({ loader: "object", exports: { value: "initial" } }));
    },
  });
  expect((await import(id)).value).toBe("initial");

  Bun.plugin({
    name: "required-virtual",
    setup(build) {
      build.module(id, () => ({ loader: "object", exports: { value: "required" } }));
    },
  });
  expect(require(id).value).toBe("required");

  Bun.plugin({
    name: "imported-virtual",
    setup(build) {
      build.module(id, () => ({ loader: "object", exports: { value: "imported" } }));
    },
  });
  expect((await import(id)).value).toBe("imported");
});

test("clearAll preserves completed file onLoad modules", async () => {
  Bun.plugin.clearAll();
  const directory = mkdtempSync(join(tmpdir(), "cottontail-plugin-cache-"));
  const path = join(directory, "cached-plugin.js");
  writeFileSync(path, "export default 'disk';");
  try {
    Bun.plugin({
      name: "file-cache",
      setup(build) {
        build.onLoad({ filter: /cached-plugin\.js$/ }, () => ({
          loader: "object",
          exports: { default: "plugin" },
        }));
      },
    });
    expect((await import(path)).default).toBe("plugin");
    Bun.plugin.clearAll();
    expect((await import(path)).default).toBe("plugin");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("build hooks preserve order and omit unimplemented propagation fields", async () => {
  const events: string[] = [];
  const result = await Bun.build({
    entrypoints: ["plugin-lifecycle-entry"],
    target: "bun",
    plugins: [{
      name: "lifecycle",
      setup(this: unknown, build) {
        void this;
        events.push("setup");
        build.onStart(() => {
          events.push("start");
          return Promise.resolve().then(() => events.push("start-done"));
        });
        events.push("setup-end");
        build.onResolve({ filter: /^plugin-lifecycle-entry$/ }, args => {
          events.push("resolve-first");
          expect(Object.keys(args).sort()).toEqual(["importer", "kind", "namespace", "path", "resolveDir"]);
          expect(args.resolveDir).toBe(".");
          return null;
        });
        build.onResolve({ filter: /^plugin-lifecycle-entry$/ }, args => {
          events.push("resolve-second");
          return {
            path: args.path,
            namespace: "lifecycle",
            pluginData: { ignored: true },
            suffix: "?ignored",
          } as never;
        });
        build.onLoad({ filter: /.*/, namespace: "lifecycle" }, args => {
          events.push("load");
          expect(Object.keys(args).sort()).toEqual(["defer", "loader", "namespace", "path", "side"]);
          return { contents: "export default 42", loader: "js" };
        });
        build.onEnd(async () => {
          events.push("end-first");
          await Promise.resolve();
          events.push("end-first-done");
        });
        build.onEnd(() => { events.push("end-second"); });
      },
    }],
  });

  expect(result.success).toBe(true);
  expect(events).toEqual([
    "setup",
    "start",
    "setup-end",
    "start-done",
    "resolve-first",
    "resolve-second",
    "load",
    "end-first",
    "end-second",
    "end-first-done",
  ]);
});

test("onEnd rejects with the original error after invoking every callback", async () => {
  const sentinel = new Error("onEnd sentinel");
  const events: string[] = [];
  let caught: unknown;
  try {
    await Bun.build({
      entrypoints: ["plugin-on-end-entry"],
      throw: false,
      plugins: [{
        name: "on-end-error",
        setup(build) {
          build.onResolve({ filter: /.*/ }, ({ path }) => ({ path, namespace: "on-end" }));
          build.onLoad({ filter: /.*/, namespace: "on-end" }, () => ({ contents: "export {};", loader: "js" }));
          build.onEnd(() => {
            events.push("first");
            throw sentinel;
          });
          build.onEnd(() => { events.push("second"); });
        },
      }],
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(sentinel);
  expect(events).toEqual(["first", "second"]);
});
