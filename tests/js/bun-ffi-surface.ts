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
assert(FFIType.cstring === 14 && FFIType.int === 5 && FFIType.pointer === 12, "bun:ffi FFIType mismatch");
assert(typeof suffix === "string" && suffix.length > 0, "bun:ffi suffix mismatch");

const libc = process.platform === "darwin"
  ? "/usr/lib/libSystem.B.dylib"
  : process.platform === "win32"
    ? "msvcrt.dll"
    : "libc.so.6";
const libcSymbols = dlopen(libc, {
  strlen: { args: [FFIType.cstring], returns: FFIType.u64 },
});
const hello = Buffer.from("hello\0");
assert(libcSymbols.symbols.strlen(hello) === 5n, "bun:ffi dlopen strlen mismatch");
const libcFilePath = process.platform === "linux"
  ? process.report.getReport().sharedObjects.find((path: string) => /\/libc\.so(?:\.|$)/.test(path)) ?? libc
  : libc;
for (const libraryInput of [Bun.pathToFileURL(libcFilePath), Bun.pathToFileURL(libcFilePath).href, Bun.file(libcFilePath)]) {
  const library = dlopen(libraryInput, {
    strlen: { args: [FFIType.cstring], returns: "usize" },
  });
  assert(library.symbols.strlen(hello) === 5n, "bun:ffi library input or usize mismatch");
}
const strlen = new CFunction({
  ptr: libcSymbols.symbols.strlen.ptr,
  args: [FFIType.cstring],
  returns: FFIType.u64,
});
assert(strlen(hello) === 5n, "bun:ffi CFunction mismatch");
const linked = linkSymbols({
  strlen: {
    ptr: libcSymbols.symbols.strlen.ptr,
    args: [FFIType.cstring],
    returns: FFIType.u64,
  },
});
assert(linked.symbols.strlen(hello) === 5n, "bun:ffi linkSymbols mismatch");

let invalidPointerError = "";
try {
  linkSymbols({ invalid: {} as any });
} catch (error: any) {
  invalidPointerError = error.message;
}
assert(invalidPointerError.includes("invalid") && invalidPointerError.includes('"ptr"'), "bun:ffi linkSymbols pointer validation mismatch");

let missingLibraryError = "";
try {
  dlopen("libcottontail-definitely-missing.so", { missing: { args: [], returns: FFIType.void } });
} catch (error: any) {
  missingLibraryError = error.message;
}
assert(missingLibraryError.includes("Failed to open library") && missingLibraryError.includes("libcottontail-definitely-missing.so"), "bun:ffi missing library error mismatch");

const tmp = process.env.COTTONTAIL_TMP_DIR || "/tmp";
const fixtureId = Date.now();
const sourcePath = `${tmp}/cottontail-ffi-add-${fixtureId}.c`;
const headerName = `cottontail-ffi-add-${fixtureId}.h`;
const headerPath = `${tmp}/${headerName}`;
await Bun.write(headerPath, "#define COTTONTAIL_HEADER_VALUE 23\n");
await Bun.write(sourcePath, `
#include <stddef.h>
#include "${headerName}"
typedef void *napi_env;
typedef void *napi_value;
extern int napi_create_string_utf8(napi_env, const char *, size_t, napi_value *);
int add(int a, int b) { return a + b; }
unsigned long long add_u64(unsigned long long a, unsigned long long b) { return a + b; }
int defined_value(void) { return COTTONTAIL_DEFINED_VALUE; }
int header_value(void) { return COTTONTAIL_HEADER_VALUE; }
napi_value make_napi_string(napi_env env) {
  napi_value result = 0;
  napi_create_string_utf8(env, "native-jsc", (size_t)-1, &result);
  return result;
}
`);
const compiled = cc({
  source: sourcePath,
  define: { COTTONTAIL_DEFINED_VALUE: 17 },
  flags: `-I${tmp}`,
  symbols: {
    add: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    add_u64: { args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 },
    defined_value: { args: [], returns: FFIType.i32 },
    header_value: { args: [], returns: FFIType.i32 },
    make_napi_string: { args: ["napi_env"], returns: "napi_value" },
  },
});
assert(compiled.symbols.add(2, 3) === 5, "bun:ffi cc mismatch");
const maxU64 = (1n << 64n) - 1n;
assert(compiled.symbols.add_u64(-maxU64, maxU64) === 0n, "bun:ffi exact uint64 argument mismatch");
assert(compiled.symbols.defined_value() === 17, "bun:ffi cc define mismatch");
assert(compiled.symbols.header_value() === 23, "bun:ffi cc scalar flags mismatch");
assert(compiled.symbols.make_napi_string(null) === "native-jsc", "bun:ffi N-API value mismatch");

let missingCompiledSymbol = "";
try {
  cc({
    source: sourcePath,
    define: { COTTONTAIL_DEFINED_VALUE: 17 },
    symbols: { absent: { args: [], returns: FFIType.void } },
  });
} catch (error: any) {
  missingCompiledSymbol = error.message;
}
assert(missingCompiledSymbol.includes('Symbol "absent" is missing'), "bun:ffi cc missing symbol mismatch");

console.log("bun ffi surface passed");
