import { cc, FFIType, JSCallback } from "bun:ffi";
import { expect, test } from "bun:test";

test("FFI preserves register and stack arguments across native calls and callbacks", () => {
  const library = cc({
    source: `
#include <stdint.h>
int32_t weighted_ints(int32_t a, int32_t b, int32_t c, int32_t d, int32_t e,
                      int32_t f, int32_t g, int32_t h, int32_t i, int32_t j) {
  return a + 2*b + 3*c + 4*d + 5*e + 6*f + 7*g + 8*h + 9*i + 10*j;
}
double weighted_doubles(double a, double b, double c, double d, double e,
                         double f, double g, double h, double i, double j) {
  return a + 2*b + 3*c + 4*d + 5*e + 6*f + 7*g + 8*h + 9*i + 10*j;
}
typedef int32_t (*callback_t)(int32_t, int32_t, int32_t, int32_t, int32_t,
                             int32_t, int32_t, int32_t, int32_t, int32_t);
int32_t call_callback(callback_t callback) {
  return callback(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
}
`,
    symbols: {
      weighted_ints: { args: Array(10).fill(FFIType.i32), returns: FFIType.i32 },
      weighted_doubles: { args: Array(10).fill(FFIType.f64), returns: FFIType.f64 },
      call_callback: { args: [FFIType.ptr], returns: FFIType.i32 },
    },
  });
  const callback = new JSCallback(
    (...values: number[]) => values.reduce((sum, value, index) => sum + value * (index + 1), 0),
    { args: Array(10).fill(FFIType.i32), returns: FFIType.i32 },
  );
  try {
    expect(library.symbols.weighted_ints(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)).toBe(385);
    expect(library.symbols.weighted_doubles(0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5)).toBe(192.5);
    expect(library.symbols.call_callback(callback.ptr)).toBe(385);
  } finally {
    callback.close();
    library.close();
  }
}, 120_000);
