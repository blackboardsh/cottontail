import { createLazyFunction, createLazyObject } from "./lazy-runtime.js";
import { loadCottontailCapabilityModule } from "../node/module.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.sqlite.bunSqlite")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= loadCottontailCapabilityModule("sqlite", "bun/sqlite.js");
const lazyFunction = name => state.exports[name] ??= createLazyFunction(load, name);

export const Database = lazyFunction("Database");
export const Statement = lazyFunction("Statement");
export const SQLiteError = lazyFunction("SQLiteError");
export const constants = state.exports.constants ??= createLazyObject(() => ({ constants: load().constants }), "constants");
export default state.module ??= Database;
