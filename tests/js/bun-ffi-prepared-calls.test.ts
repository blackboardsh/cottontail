import {
  CFunction,
  CString,
  FFIType,
  JSCallback,
  dlopen,
  ptr,
} from "bun:ffi";
import { describe, expect, test } from "bun:test";

const libc = process.platform === "darwin"
  ? "/usr/lib/libSystem.B.dylib"
  : process.platform === "win32"
    ? "msvcrt.dll"
    : "libc.so.6";

function callbackRoundTrip(type: number | string, value: unknown) {
  const callback = new JSCallback(input => input, {
    args: [type],
    returns: type,
  });
  const call = new CFunction({
    ptr: callback.ptr,
    args: [type],
    returns: type,
  });
  try {
    return call(value);
  } finally {
    callback.close();
  }
}

describe("bun:ffi prepared native calls", () => {
  test("uses the prepared call after construction", () => {
    const library = dlopen(libc, {
      abs: { args: [FFIType.i32], returns: FFIType.i32 },
    });
    const abs = library.symbols.abs;
    const host = (globalThis as any).cottontail;
    const originalCall = host.nativeCall;
    const originalCallPointer = host.nativeCallPointer;
    const originalPrepare = host.prepareNativeCall;
    host.nativeCall = () => {
      throw new Error("legacy nativeCall path used");
    };
    host.nativeCallPointer = () => {
      throw new Error("legacy nativeCallPointer path used");
    };
    host.prepareNativeCall = () => {
      throw new Error("signature was prepared more than once");
    };
    try {
      expect(abs(-41)).toBe(41);
      expect(abs.native(-42)).toBe(42);
      expect(abs.native).not.toBe(abs);
      library.close();
      expect(abs(-43)).toBe(43);
    } finally {
      host.nativeCall = originalCall;
      host.nativeCallPointer = originalCallPointer;
      host.prepareNativeCall = originalPrepare;
    }
  });

  test("marshals scalar arguments and return values natively", () => {
    expect(callbackRoundTrip(FFIType.i8, -128)).toBe(-128);
    expect(callbackRoundTrip(FFIType.i16, -32768)).toBe(-32768);
    expect(callbackRoundTrip(FFIType.i32, -2147483648)).toBe(-2147483648);
    expect(callbackRoundTrip(FFIType.u8, 255)).toBe(255);
    expect(callbackRoundTrip(FFIType.u16, 65535)).toBe(65535);
    expect(callbackRoundTrip(FFIType.u32, 4294967295)).toBe(4294967295);
    expect(callbackRoundTrip(FFIType.i64, -(1n << 63n))).toBe(-(1n << 63n));
    expect(callbackRoundTrip(FFIType.u64, (1n << 64n) - 1n)).toBe((1n << 64n) - 1n);
    expect(callbackRoundTrip(FFIType.i64_fast, -42n)).toBe(-42);
    expect(callbackRoundTrip(FFIType.u64_fast, 42n)).toBe(42);
    expect(callbackRoundTrip(FFIType.f32, 10.25)).toBe(Math.fround(10.25));
    expect(callbackRoundTrip(FFIType.f64, -10.25)).toBe(-10.25);
    expect(callbackRoundTrip(FFIType.bool, true)).toBe(true);
  });

  test("preserves Bun integer coercion and clamping", () => {
    expect(callbackRoundTrip(FFIType.i8, 255)).toBe(-1);
    expect(callbackRoundTrip(FFIType.i16, 32768)).toBe(-32768);
    expect(callbackRoundTrip(FFIType.i32, 4294967295)).toBe(-1);
    expect(callbackRoundTrip(FFIType.u8, -1)).toBe(0);
    expect(callbackRoundTrip(FFIType.u8, 999)).toBe(255);
    expect(callbackRoundTrip(FFIType.u16, -1)).toBe(0);
    expect(callbackRoundTrip(FFIType.u16, 999999)).toBe(65535);
    expect(callbackRoundTrip(FFIType.u16, 4294967295)).toBe(0);
    expect(callbackRoundTrip(FFIType.u16, Infinity)).toBe(0);
    expect(callbackRoundTrip(FFIType.u32, -1)).toBe(0);
    expect(callbackRoundTrip(FFIType.u32, 1e20)).toBe(4294967295);
    expect(callbackRoundTrip(FFIType.u64, -1)).toBe(0n);
    expect(callbackRoundTrip(FFIType.u64_fast, -1)).toBe(0);
    expect(callbackRoundTrip(FFIType.u64, -((1n << 64n) - 1n))).toBe(1n);
  });

  test("preserves pointer, buffer, and callback behavior", () => {
    const bytes = new Uint8Array([11, 22, 33, 0]);
    const address = ptr(bytes);
    const pointerCallback = new JSCallback(input => input, {
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    });
    const pointerCall = new CFunction({
      ptr: pointerCallback.ptr,
      args: [FFIType.ptr],
      returns: FFIType.ptr,
    });
    const bufferCall = new CFunction({
      ptr: pointerCallback.ptr,
      args: [FFIType.buffer],
      returns: FFIType.ptr,
    });
    const functionCallback = new JSCallback(input => input, {
      args: [FFIType.function],
      returns: FFIType.function,
    });
    const functionCall = new CFunction({
      ptr: functionCallback.ptr,
      args: [FFIType.function],
      returns: FFIType.function,
    });
    try {
      expect(pointerCall(bytes)).toBe(address);
      expect(pointerCall(new CString(address))).toBe(address);
      expect(pointerCall(null)).toBeNull();
      expect(bufferCall(bytes)).toBe(address);
      expect(() => bufferCall(bytes.buffer)).toThrow("Expected a TypedArray");
      expect(() => pointerCall("not encoded")).toThrow("encode it as a buffer");
      expect(() => pointerCall({ ptr: address } as any)).toThrow("Unable to convert value to a pointer");
      expect(functionCall(pointerCallback)).toBe(pointerCallback.ptr);
      expect(functionCall({ ptr: pointerCallback.ptr } as any)).toBe(pointerCallback.ptr);
    } finally {
      pointerCallback.close();
      functionCallback.close();
    }
  });

  test("wraps C string returns without returning raw pointers", () => {
    const library = dlopen(libc, {
      strchr: {
        args: [FFIType.cstring, FFIType.i32],
        returns: FFIType.cstring,
      },
    });
    const input = Buffer.from("cottontail\0");
    const result = library.symbols.strchr(input, "t".charCodeAt(0));
    expect(result).toBeInstanceOf(CString);
    expect(String(result)).toBe("ttontail");
    expect(String(library.symbols.strchr(input, "z".charCodeAt(0)))).toBe("");
  });
});
