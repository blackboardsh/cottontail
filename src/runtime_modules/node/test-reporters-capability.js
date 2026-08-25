import { createLazyFunction } from "../bun/lazy-runtime.js";
import { loadCottontailCapabilityModule } from "./module.js";

let namespace;
const load = () => namespace ??= loadCottontailCapabilityModule("test", "node/test/reporters.js");

export const dot = createLazyFunction(load, "dot");
export const junit = createLazyFunction(load, "junit");
export const lcov = createLazyFunction(load, "lcov");
export const spec = createLazyFunction(load, "spec");
export const tap = createLazyFunction(load, "tap");
export default { dot, junit, lcov, spec, tap };
