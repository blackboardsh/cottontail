import { createLazyFunction, createLazyObject } from "./lazy-runtime.js";
import { loadCottontailCapabilityModule } from "../node/module.js";
import "../internal/test-host-modules.js";

let namespace;
export const loadBunTestCapabilityModule = () => {
  if (namespace !== undefined) return namespace;
  // bun:test eagerly materializes these globals so later user replacement of
  // Promise.prototype.then cannot affect the stream polyfill. Do that through
  // the application-owned facade before capability bytecode evaluates; the
  // test bundle must not become the owner of a second web-stream realm.
  try { void globalThis.ReadableStream; } catch {}
  return namespace = loadCottontailCapabilityModule("test", "bun/test.js");
};
globalThis[Symbol.for("cottontail.internal.loadBunTestCapability")] ??=
  loadBunTestCapabilityModule;
const load = loadBunTestCapabilityModule;

export const expect = createLazyFunction(load, "expect");
export const mock = createLazyFunction(load, "mock");
export const spyOn = createLazyFunction(load, "spyOn");
export const setSystemTime = createLazyFunction(load, "setSystemTime");
export const setDefaultTimeout = createLazyFunction(load, "setDefaultTimeout");
export const onTestFinished = createLazyFunction(load, "onTestFinished");
export const expectTypeOf = createLazyFunction(load, "expectTypeOf");
export const beforeAll = createLazyFunction(load, "beforeAll");
export const afterAll = createLazyFunction(load, "afterAll");
export const beforeEach = createLazyFunction(load, "beforeEach");
export const afterEach = createLazyFunction(load, "afterEach");
export const test = createLazyFunction(load, "test");
export const it = createLazyFunction(load, "it");
export const describe = createLazyFunction(load, "describe");
export const xit = createLazyFunction(load, "xit");
export const xtest = createLazyFunction(load, "xtest");
export const xdescribe = createLazyFunction(load, "xdescribe");
export const jest = createLazyObject(() => ({ jest: load().jest }), "jest");
export const vi = createLazyObject(() => ({ vi: load().vi }), "vi");

export default {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  jest,
  mock,
  onTestFinished,
  setDefaultTimeout,
  setSystemTime,
  spyOn,
  test,
  vi,
  xdescribe,
  xit,
  xtest,
};
