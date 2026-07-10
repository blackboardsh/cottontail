import { CFunction, CString, FFIType, cc, dlopen, linkSymbols, ptr, read, suffix, toArrayBuffer, toBuffer } from "bun:ffi";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const bytes = new Uint8Array([104, 101, 108, 108, 111, 0]);
const address = ptr(bytes);
assert(typeof address === "number" && address > 0, "bun:ffi ptr mismatch");
assert(read.u8(address) === 104, "bun:ffi read.u8 mismatch");
assert(read.u16(address) === 25960, "bun:ffi read.u16 mismatch");
assert(toBuffer(address, 0, 5).toString() === "hello", "bun:ffi toBuffer mismatch");
assert(new Uint8Array(toArrayBuffer(address, 1, 2))[0] === 101, "bun:ffi toArrayBuffer mismatch");
assert(String(new CString(address)) === "hello", "bun:ffi CString mismatch");
assert(FFIType.cstring === "cstring", "bun:ffi FFIType mismatch");
assert(typeof suffix === "string" && suffix.length > 0, "bun:ffi suffix mismatch");

const libc = process.platform === "darwin"
  ? "/usr/lib/libSystem.B.dylib"
  : process.platform === "win32"
    ? "msvcrt.dll"
    : "libc.so.6";
const libcSymbols = dlopen(libc, {
  strlen: { args: [FFIType.cstring], returns: FFIType.u64 },
});
assert(libcSymbols.symbols.strlen("hello") === 5n, "bun:ffi dlopen strlen mismatch");
const strlen = new CFunction({
  ptr: libcSymbols.symbols.strlen.ptr,
  args: [FFIType.cstring],
  returns: FFIType.u64,
});
assert(strlen("hello") === 5n, "bun:ffi CFunction mismatch");
const linked = linkSymbols({
  strlen: {
    ptr: libcSymbols.symbols.strlen.ptr,
    args: [FFIType.cstring],
    returns: FFIType.u64,
  },
});
assert(linked.symbols.strlen("hello") === 5n, "bun:ffi linkSymbols mismatch");

const tmp = process.env.COTTONTAIL_TMP_DIR || "/tmp";
const sourcePath = `${tmp}/cottontail-ffi-add-${Date.now()}.c`;
await Bun.write(sourcePath, "int add(int a, int b) { return a + b; }\n");
const compiled = cc({
  source: sourcePath,
  symbols: {
    add: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  },
});
assert(compiled.symbols.add(2, 3) === 5, "bun:ffi cc mismatch");

console.log("bun ffi surface passed");
