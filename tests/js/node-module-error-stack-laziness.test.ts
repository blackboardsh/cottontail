import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const originalPrepareStackTrace = Error.prepareStackTrace;
const originalStackTraceLimit = Error.stackTraceLimit;
const directory = mkdtempSync(join(tmpdir(), "cottontail-lazy-error-"));
const filename = join(directory, "lazy-error.mjs");
const source = [
  "await 0;",
  "export function caught(message) { try { throw new Error(message); } catch (error) { return error; } }",
  "export function called(message) { return Error(message); }",
  'export function delayed() { throw new Error("lazy-source-diagnostic"); }',
  "",
].join("\n");
let loaded;

beforeAll(async () => {
  writeFileSync(filename, source);
  loaded = await import(pathToFileURL(filename).href);
});

afterEach(() => {
  Error.prepareStackTrace = originalPrepareStackTrace;
  Error.stackTraceLimit = originalStackTraceLimit;
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

test("caught dynamic-module errors format only when their stack is read", () => {
  let earlyCalls = 0;
  let lateCalls = 0;
  Error.prepareStackTrace = error => {
    if (error.message === "lazy-caught") earlyCalls += 1;
    return "early";
  };
  const error = loaded.caught("lazy-caught");
  expect(earlyCalls).toBe(0);
  const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
  expect(typeof descriptor?.get).toBe("function");
  expect(typeof descriptor?.set).toBe("function");
  expect(descriptor?.configurable).toBe(true);
  expect(descriptor?.enumerable).toBe(false);
  const formatted = { customStack: true };
  Error.prepareStackTrace = value => {
    if (value === error) lateCalls += 1;
    return formatted;
  };
  expect(error.stack).toBe(formatted);
  expect(error.stack).toBe(formatted);
  expect(earlyCalls).toBe(0);
  expect(lateCalls).toBe(1);
});

test("calling Error without new also defers formatting and preserves explicit stack assignments", () => {
  let calls = 0;
  Error.prepareStackTrace = error => {
    if (error.message === "lazy-assigned") calls += 1;
    return "formatted";
  };
  const error = loaded.called("lazy-assigned");
  error.stack = "user-supplied@";
  expect(error.stack).toBe("user-supplied@");
  const custom = { stack: "assigned object" };
  error.stack = custom;
  expect(error.stack).toBe(custom);
  expect(calls).toBe(0);
});

test("stack replacement and deletion do not invoke the original formatter", () => {
  let calls = 0;
  Error.prepareStackTrace = error => {
    if (error.message === "lazy-replaced") calls += 1;
    return "formatted";
  };
  const error = loaded.caught("lazy-replaced");
  let customStack = "custom@";
  let reads = 0;
  const get = () => { reads += 1; return customStack; };
  const set = value => { customStack = value; };
  Object.defineProperty(error, "stack", { configurable: true, enumerable: true, get, set });
  expect(Object.getOwnPropertyDescriptor(error, "stack")).toEqual({ configurable: true, enumerable: true, get, set });
  expect(reads).toBe(0);
  error.stack = "changed@";
  expect(error.stack).toBe("changed@");
  expect(reads).toBe(1);
  expect(delete error.stack).toBe(true);
  expect(Object.hasOwn(error, "stack")).toBe(false);
  expect(error.stack).toBeUndefined();
  expect(calls).toBe(0);
});

test("a disabled stack stays absent in dynamic modules", () => {
  Error.stackTraceLimit = 0;
  const error = loaded.caught("lazy-disabled");
  expect(Object.hasOwn(error, "stack")).toBe(false);
  expect(error.stack).toBeUndefined();
});

test("delayed error inspection retains the original dynamic-module source", () => {
  Error.prepareStackTrace = undefined;
  let error;
  try { loaded.delayed(); } catch (value) { error = value; }
  Bun.gc(true);
  const metadata = error[Symbol.for("cottontail.dynamicErrorSource")];
  expect(metadata.filename).toBe(filename);
  expect(metadata.source).toBe(source);
  expect(error.stack).toContain("lazy-error.mjs");
  const rendered = Bun.inspect(error);
  expect(rendered).toContain("lazy-source-diagnostic");
  expect(rendered).toContain("export function delayed()");
});
