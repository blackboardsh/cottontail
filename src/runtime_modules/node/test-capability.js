import { createLazyFunction, createLazyObject } from "../bun/lazy-runtime.js";
import { loadCottontailCapabilityModule } from "./module.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.test.nodeTest")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= loadCottontailCapabilityModule("test", "node/test.js");
const lazyFunction = name => state.exports[name] ??= createLazyFunction(load, name);
const lazyObject = name => state.exports[name] ??= createLazyObject(load, name);

export const after = lazyFunction("after");
export const afterEach = lazyFunction("afterEach");
export const before = lazyFunction("before");
export const beforeEach = lazyFunction("beforeEach");
export const describe = lazyFunction("describe");
export const it = lazyFunction("it");
export const onTestFinished = lazyFunction("onTestFinished");
export const only = lazyFunction("only");
export const run = lazyFunction("run");
export const setDefaultTimeout = lazyFunction("setDefaultTimeout");
export const skip = lazyFunction("skip");
export const suite = lazyFunction("suite");
export const todo = lazyFunction("todo");
export const mock = lazyObject("mock");
export const assert = lazyObject("assert");
export const snapshot = lazyObject("snapshot");

const facadeSurface = {
  after,
  afterEach,
  assert,
  before,
  beforeEach,
  describe,
  it,
  mock,
  onTestFinished,
  only,
  run,
  setDefaultTimeout,
  skip,
  snapshot,
  suite,
  todo,
};

const testTarget = function test(...args) {
  return Reflect.apply(load().test, this, args);
};
export const test = state.module ??= new Proxy(testTarget, {
  apply(_target, receiver, args) {
    return Reflect.apply(load().test, receiver, args);
  },
  get(_target, property) {
    if (Object.prototype.hasOwnProperty.call(facadeSurface, property)) return facadeSurface[property];
    const implementation = load().default ?? load().test;
    return Reflect.get(implementation, property, implementation);
  },
  has(_target, property) {
    return Object.prototype.hasOwnProperty.call(facadeSurface, property) || property in (load().default ?? load().test);
  },
  getOwnPropertyDescriptor(_target, property) {
    if (Object.prototype.hasOwnProperty.call(facadeSurface, property)) {
      return { value: facadeSurface[property], writable: true, enumerable: true, configurable: true };
    }
    return Reflect.getOwnPropertyDescriptor(testTarget, property);
  },
  ownKeys() {
    return [...new Set([...Reflect.ownKeys(testTarget), ...Reflect.ownKeys(facadeSurface)])];
  },
});

facadeSurface.test = test;

export default test;
