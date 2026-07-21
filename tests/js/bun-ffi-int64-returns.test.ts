import { CFunction, FFIType, cc } from "bun:ffi";
import { describe, expect, test } from "bun:test";

const library = cc({
  source: `
#include <stdint.h>

int64_t cottontail_i64_min(void) { return INT64_MIN; }
int64_t cottontail_i64_unsafe(void) { return -INT64_C(9007199254740993); }
int64_t cottontail_i64_safe(void) { return INT64_C(9007199254740991); }
uint64_t cottontail_u64_max(void) { return UINT64_MAX; }
uint64_t cottontail_u64_unsafe(void) { return UINT64_C(9007199254740993); }
uint64_t cottontail_u64_safe(void) { return UINT64_C(9007199254740991); }
int32_t cottontail_i32_min(void) { return INT32_MIN; }
uint32_t cottontail_u32_max(void) { return UINT32_MAX; }
`,
  symbols: {
    cottontail_i64_min: { args: [], returns: FFIType.i64 },
    cottontail_i64_unsafe: { args: [], returns: FFIType.i64 },
    cottontail_i64_safe: { args: [], returns: FFIType.i64_fast },
    cottontail_u64_max: { args: [], returns: FFIType.u64 },
    cottontail_u64_unsafe: { args: [], returns: FFIType.u64 },
    cottontail_u64_safe: { args: [], returns: FFIType.u64_fast },
    cottontail_i32_min: { args: [], returns: FFIType.i32 },
    cottontail_u32_max: { args: [], returns: FFIType.u32 },
  },
});

describe("bun:ffi exact 64-bit native returns", () => {
  test("preserves signed and unsigned values outside Number's safe range", () => {
    expect(library.symbols.cottontail_i64_min()).toBe(-(1n << 63n));
    expect(library.symbols.cottontail_i64_unsafe()).toBe(-9007199254740993n);
    expect(library.symbols.cottontail_u64_max()).toBe((1n << 64n) - 1n);
    expect(library.symbols.cottontail_u64_unsafe()).toBe(9007199254740993n);
  });

  test("fast 64-bit returns preserve Bun's Number behavior for safe results", () => {
    expect(library.symbols.cottontail_i64_safe()).toBe(9007199254740991);
    expect(library.symbols.cottontail_u64_safe()).toBe(9007199254740991);
  });

  test("CFunction preserves exact signed and unsigned 64-bit results", () => {
    const signed = new CFunction({
      ptr: library.symbols.cottontail_i64_min.ptr,
      args: [],
      returns: FFIType.i64,
    });
    const unsigned = new CFunction({
      ptr: library.symbols.cottontail_u64_max.ptr,
      args: [],
      returns: FFIType.u64,
    });

    expect(signed()).toBe(-(1n << 63n));
    expect(unsigned()).toBe((1n << 64n) - 1n);
  });

  test("smaller integer return types remain Numbers", () => {
    expect(library.symbols.cottontail_i32_min()).toBe(-2147483648);
    expect(library.symbols.cottontail_u32_max()).toBe(4294967295);
  });
});
