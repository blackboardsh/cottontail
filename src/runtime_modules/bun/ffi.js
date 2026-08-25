import { createLazyFunction, createLazyObject } from "./lazy-runtime.js";
import { loadCottontailCapabilityModule } from "../node/module.js";

let namespace;
const load = () => namespace ??= loadCottontailCapabilityModule("ffi", "bun/ffi-implementation.js");

export const CFunction = createLazyFunction(load, "CFunction");
export const CString = createLazyFunction(load, "CString");
export const JSCallback = createLazyFunction(load, "JSCallback");
export const cc = createLazyFunction(load, "cc");
export const dlopen = createLazyFunction(load, "dlopen");
export const linkSymbols = createLazyFunction(load, "linkSymbols");
export const ptr = createLazyFunction(load, "ptr");
export const toArrayBuffer = createLazyFunction(load, "toArrayBuffer");
export const toBuffer = createLazyFunction(load, "toBuffer");
export const viewSource = createLazyFunction(load, "viewSource");
export const FFIType = createLazyObject(() => ({ FFIType: load().FFIType }), "FFIType");
export const read = createLazyObject(() => ({ read: load().read }), "read");
export const native = createLazyObject(() => ({ native: load().native }), "native");
export const suffix = globalThis.cottontail.platform() === "win32" ? "dll" :
  globalThis.cottontail.platform() === "darwin" ? "dylib" : "so";

export default {
  CFunction, CString, FFIType, JSCallback, cc, dlopen, linkSymbols, native,
  ptr, read, suffix, toArrayBuffer, toBuffer, viewSource,
};
