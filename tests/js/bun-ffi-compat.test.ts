import {
  CFunction,
  CString,
  FFIType,
  JSCallback,
  dlopen,
  linkSymbols,
  native,
  ptr,
  read,
  toArrayBuffer,
  toBuffer,
  viewSource,
} from "bun:ffi";
import { describe, expect, test } from "bun:test";

const libc = process.platform === "darwin"
  ? "/usr/lib/libSystem.B.dylib"
  : process.platform === "win32"
    ? "msvcrt.dll"
    : "libc.so.6";

describe("bun:ffi JavaScript compatibility", () => {
  test("FFIType matches Bun's numeric enum and aliases", () => {
    expect(FFIType.char).toBe(0);
    expect(FFIType.int8_t).toBe(1);
    expect(FFIType.uint8_t).toBe(2);
    expect(FFIType.int16_t).toBe(3);
    expect(FFIType.uint16_t).toBe(4);
    expect(FFIType.int32_t).toBe(5);
    expect(FFIType.uint32_t).toBe(6);
    expect(FFIType.int64_t).toBe(7);
    expect(FFIType.uint64_t).toBe(8);
    expect(FFIType.double).toBe(9);
    expect(FFIType.float).toBe(10);
    expect(FFIType.bool).toBe(11);
    expect(FFIType.pointer).toBe(12);
    expect(FFIType.void).toBe(13);
    expect(FFIType.cstring).toBe(14);
    expect(FFIType.i64_fast).toBe(15);
    expect(FFIType.u64_fast).toBe(16);
    expect(FFIType.function).toBe(17);
    expect(FFIType.napi_env).toBe(18);
    expect(FFIType.napi_value).toBe(19);
    expect(FFIType.buffer).toBe(20);
    expect(FFIType.ptr).toBe(FFIType.pointer);
    expect(FFIType.callback).toBe(FFIType.function);
    expect(FFIType.fn).toBe(FFIType.function);
    expect(FFIType.usize).toBe(FFIType.uint64_t);
  });

  test("ptr validates buffer sources and applies byte offsets", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const address = ptr(bytes);
    expect(typeof address).toBe("number");
    expect(ptr(bytes, 2)).toBe(address + 2);
    expect(() => ptr(bytes, 5)).toThrow("byteOffset out of bounds");
    expect(() => ptr(bytes, "1" as any)).toThrow("Expected number for byteOffset");
    expect(() => ptr(new Uint8Array())).toThrow("length > 0");
    expect(() => ptr(null as any)).toThrow("Expected ArrayBufferView");
  });

  test("read and pointer views preserve native memory", () => {
    const storage = new ArrayBuffer(32);
    const data = new DataView(storage);
    data.setUint8(0, 0xfe);
    data.setInt16(1, -1234, true);
    data.setUint32(3, 0xfedcba98, true);
    data.setBigInt64(8, -123456789n, true);
    data.setFloat32(16, 3.5, true);
    data.setFloat64(24, -9.25, true);
    const address = ptr(storage);

    expect(read.u8(address)).toBe(0xfe);
    expect(read.i16(address, 1)).toBe(-1234);
    expect(read.u32(address, 3)).toBe(0xfedcba98);
    expect(read.i64(address, 8)).toBe(-123456789n);
    expect(read.f32(address, 16)).toBe(3.5);
    expect(read.f64(address, 24)).toBe(-9.25);

    const view = new Uint8Array(toArrayBuffer(address, 0, 4));
    view[0] = 7;
    expect(new Uint8Array(storage)[0]).toBe(7);
    expect(Array.from(toBuffer(address, 1, 3))).toEqual(Array.from(new Uint8Array(storage, 1, 3)));
    expect(() => toArrayBuffer(0, 0, 1)).toThrow("ptr cannot be zero");
    expect(() => toArrayBuffer(address, 0, 0)).toThrow("length must be > 0");
  });

  test("CString is a String subclass with bounded and NUL-terminated views", () => {
    const bytes = Buffer.from([97, 98, 0, 99, 100, 0]);
    const address = ptr(bytes);
    const terminated = new CString(address);
    const bounded = new CString(address, 1, 3);

    expect(terminated instanceof String).toBe(true);
    expect(terminated instanceof CString).toBe(true);
    expect(String(terminated)).toBe("ab");
    expect(terminated.length).toBe(2);
    expect(terminated.ptr).toBe(address);
    expect(Array.from(new Uint8Array(terminated.arrayBuffer))).toEqual([97, 98]);
    expect(String(bounded)).toBe("b\0c");
    expect(Array.from(new Uint8Array(bounded.arrayBuffer))).toEqual([98, 0, 99]);
    expect(new CString(0).arrayBuffer.byteLength).toBe(0);
  });

  test("dlopen exposes Bun-style symbol wrappers", () => {
    const library = dlopen(libc, {
      abs: { args: [FFIType.int], returns: FFIType.int },
      strlen: { args: [FFIType.cstring], returns: FFIType.usize },
    });

    expect(library.symbols.abs(-42)).toBe(42);
    expect(library.symbols.abs.native(-7)).toBe(7);
    expect(library.symbols.abs.length).toBe(1);
    expect(typeof library.symbols.abs.ptr).toBe("number");
    expect(typeof library.symbols.abs.native).toBe("function");
    expect(library.symbols.strlen(Buffer.from("cottontail\0"))).toBe(10n);
    expect(() => library.symbols.strlen("cottontail" as any)).toThrow("encode it as a buffer");
    expect(library.close()).toBeUndefined();
    expect(library.close()).toBeUndefined();
  });

  test("linkSymbols and CFunction call existing function pointers", () => {
    const library = dlopen(libc, { abs: { args: ["int"], returns: "int" } });
    const linked = linkSymbols({
      absolute: { ptr: library.symbols.abs.ptr, args: ["int"], returns: "int" },
    });
    const direct = new CFunction({ ptr: library.symbols.abs.ptr, args: ["int"], returns: "int" });

    expect(linked.symbols.absolute(-9)).toBe(9);
    expect(direct(-11)).toBe(11);
    expect(typeof direct.native).toBe("function");
    expect(direct.close()).toBeUndefined();
    expect(direct.close()).toBeUndefined();
    expect(() => linkSymbols({ missing: { args: [], returns: "int" } as any })).toThrow(/missing.*ptr/i);
  });

  test("JSCallback supports coercion, 64-bit values, and disposal", () => {
    let received: unknown;
    const callback = new JSCallback((value: bigint) => {
      received = value;
      return value;
    }, { args: ["int64_t"], returns: "int64_t", threadsafe: true });
    const call = new CFunction({ ptr: callback.ptr, args: ["int64_t"], returns: "int64_t" });

    expect(callback.threadsafe).toBe(true);
    expect(+callback).toBe(callback.ptr);
    expect(call(-42n)).toBe(-42n);
    expect(received).toBe(-42n);
    callback.close();
    expect(callback.ptr).toBeNull();
    expect(+callback).toBe(0);
    callback.close();
    expect(() => new JSCallback(null as any, {})).toThrow("Expected callback to be a function");
  });

  test("pointer views invoke C finalizers after collection", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    let calls = 0;
    const callback = new JSCallback((address: number, context: number | null) => {
      expect(address).toBe(ptr(bytes));
      expect(context).toBeNull();
      calls++;
    }, { args: ["ptr", "ptr"], returns: "void" });

    (() => {
      const view = toArrayBuffer(ptr(bytes), 0, bytes.byteLength, callback.ptr);
      expect(new Uint8Array(view)[1]).toBe(2);
    })();
    for (let attempt = 0; attempt < 20 && calls === 0; attempt++) {
      Bun.gc(true);
      await Bun.sleep(5);
    }

    expect(calls).toBe(1);
    callback.close();
  });

  test("type and symbol validation happens before native calls", () => {
    expect(() => dlopen(libc, {})).toThrow("Expected at least one symbol");
    expect(() => dlopen(libc, { abs: { args: ["not-a-type"], returns: "int" } })).toThrow("Unsupported type");
    expect(() => dlopen(42 as any, { abs: { args: ["int"], returns: "int" } })).toThrow("Expected string");
    expect(() => native.callback()).toThrow("Deprecated");
  });

  test("viewSource returns valid C declarations with Bun's result shape", () => {
    const callback = viewSource({ args: ["ptr"], returns: "bool" }, true);
    const symbols = viewSource({ add: { args: ["int", "int"], returns: "int" } }, false);

    expect(typeof callback).toBe("string");
    expect(callback).toContain("bool my_callback_function(void * arg0)");
    expect(Array.isArray(symbols)).toBe(true);
    expect(symbols).toHaveLength(1);
    expect(symbols[0]).toContain("int32_t add(int32_t arg0, int32_t arg1)");
  });
});
