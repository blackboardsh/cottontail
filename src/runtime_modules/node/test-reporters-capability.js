import { createLazyFunction } from "../bun/lazy-runtime.js";
import { loadCottontailCapabilityModule } from "./module.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.test.reporters")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= loadCottontailCapabilityModule("test", "node/test/reporters.js");

const lazyFunction = name => state.exports[name] ??= createLazyFunction(load, name);

export const dot = lazyFunction("dot");
export const junit = lazyFunction("junit");
export const lcov = lazyFunction("lcov");
export const spec = lazyFunction("spec");
export const tap = lazyFunction("tap");
export default { dot, junit, lcov, spec, tap };
