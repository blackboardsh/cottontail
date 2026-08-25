import { createLazyFunction, createLazyObject } from "../bun/lazy-runtime.js";
import { loadCottontailCapabilityModule } from "./module.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.sqlite.nodeSqlite")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= loadCottontailCapabilityModule("sqlite", "node/sqlite.js");
const lazyFunction = name => state.exports[name] ??= createLazyFunction(load, name);

export const DatabaseSync = lazyFunction("DatabaseSync");
export const StatementSync = lazyFunction("StatementSync");
export const Session = lazyFunction("Session");
export const backup = lazyFunction("backup");
export const constants = state.exports.constants ??= createLazyObject(() => ({ constants: load().constants }), "constants");
export default state.module ??= { DatabaseSync, StatementSync, Session, backup, constants };
