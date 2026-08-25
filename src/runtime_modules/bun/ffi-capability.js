import { createLazyFunction, createLazyObject } from "./lazy-runtime.js";
import { loadCottontailCapabilityModule } from "../node/module.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.ffi.bunFfi")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= loadCottontailCapabilityModule("ffi", "bun/ffi-implementation.js");
const lazyFunction = name => state.exports[name] ??= createLazyFunction(load, name);
const lazyObject = name => state.exports[name] ??= createLazyObject(() => ({ [name]: load()[name] }), name);

export const CFunction = lazyFunction("CFunction");
export const CString = lazyFunction("CString");
export const JSCallback = lazyFunction("JSCallback");
export const cc = lazyFunction("cc");
export const dlopen = lazyFunction("dlopen");
export const linkSymbols = lazyFunction("linkSymbols");
export const ptr = lazyFunction("ptr");
export const toArrayBuffer = lazyFunction("toArrayBuffer");
export const toBuffer = lazyFunction("toBuffer");
export const viewSource = lazyFunction("viewSource");
export const FFIType = lazyObject("FFIType");
export const read = lazyObject("read");
export const native = lazyObject("native");
export const suffix = globalThis.cottontail.platform() === "win32" ? "dll" :
  globalThis.cottontail.platform() === "darwin" ? "dylib" : "so";

export default state.module ??= {
  CFunction, CString, FFIType, JSCallback, cc, dlopen, linkSymbols, native,
  ptr, read, suffix, toArrayBuffer, toBuffer, viewSource,
};
