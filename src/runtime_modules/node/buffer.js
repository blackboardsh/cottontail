import "../bun/ffi.js";

export const Buffer = globalThis.Buffer;
export const Blob = globalThis.Blob;
export const File = globalThis.File;
export const atob = globalThis.atob;
export const btoa = globalThis.btoa;

export default { Buffer, Blob, File, atob, btoa };
