import { createLazyFunction, createLazyObject } from "./lazy-runtime.js";
import { loadCottontailCapabilityModule, loadEmbeddedRuntimeModule } from "../node/module.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.test.bunTest")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
export const loadBunTestCapabilityModule = () => {
  if (state.namespace !== undefined) return state.namespace;
  // The test capability must share the application's builtin instances, but
  // ordinary applications and workers do not need its fs/stream/assert graph.
  // Initialize those host modules before evaluating any test capability code.
  loadEmbeddedRuntimeModule("internal/test-host-modules.js");
  // bun:test eagerly materializes these globals so later user replacement of
  // Promise.prototype.then cannot affect the stream polyfill. Do that through
  // the application-owned facade before capability bytecode evaluates; the
  // test bundle must not become the owner of a second web-stream realm.
  try { void globalThis.ReadableStream; } catch {}
  return state.namespace = loadCottontailCapabilityModule("test", "bun/test.js");
};
globalThis[Symbol.for("cottontail.internal.loadBunTestCapability")] ??=
  loadBunTestCapabilityModule;
const load = loadBunTestCapabilityModule;
const lazyFunction = name => state.exports[name] ??= createLazyFunction(load, name);
const lazyObject = name => state.exports[name] ??= createLazyObject(() => ({ [name]: load()[name] }), name);

export const expect = lazyFunction("expect");
export const mock = lazyFunction("mock");
export const spyOn = lazyFunction("spyOn");
export const setSystemTime = lazyFunction("setSystemTime");
export const setDefaultTimeout = lazyFunction("setDefaultTimeout");
export const onTestFinished = lazyFunction("onTestFinished");
export const expectTypeOf = lazyFunction("expectTypeOf");
export const beforeAll = lazyFunction("beforeAll");
export const afterAll = lazyFunction("afterAll");
export const beforeEach = lazyFunction("beforeEach");
export const afterEach = lazyFunction("afterEach");
export const test = lazyFunction("test");
export const it = lazyFunction("it");
export const describe = lazyFunction("describe");
export const xit = lazyFunction("xit");
export const xtest = lazyFunction("xtest");
export const xdescribe = lazyFunction("xdescribe");
export const jest = lazyObject("jest");
export const vi = lazyObject("vi");

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
