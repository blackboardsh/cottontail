import { cc, CString, JSCallback, toBuffer } from "bun:ffi";
import { describe, expect, test } from "bun:test";

const library = cc({
  source: `${import.meta.dir}/fixtures/ffi-threadsafe-cstrings.c`,
  flags: process.platform === "win32" ? [] : ["-pthread"],
  symbols: {
    ffi_cstring_burst: { args: ["ptr", "u32"], returns: "i32" },
    ffi_cstring_immediate: { args: ["ptr"], returns: "i32" },
    ffi_cstring_start_blocking: { args: ["ptr"], returns: "i32" },
    ffi_cstring_join_blocking: { args: [], returns: "i32" },
  },
});

const burstSignature = {
  args: ["u32", "cstring", "cstring", "cstring", "cstring", "ptr"],
  returns: "void",
  threadsafe: true,
} as const;

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

describe("threadsafe FFI C-string ownership", () => {
  test("owns every queued string until delivery, while ptr remains borrowed", async () => {
    const values: unknown[] = [];
    const callback = new JSCallback((id, first, second, empty, absent, borrowed) => {
      values.push([
        id, String(new CString(first)), String(new CString(second)),
        String(new CString(empty)), absent, String(new CString(borrowed)),
      ]);
    }, burstSignature);
    try {
      expect(library.symbols.ffi_cstring_burst(callback.ptr, 64)).toBe(0);
      await waitFor(() => values.length === 64);
      expect(values).toEqual(Array.from({ length: 64 }, (_, i) => [
        i, `/tmp/zendo-${i}-é-漢-🙂.mjs`, `value-${i}-é`, "", 0, "OVERWRITTEN",
      ]));
    } finally {
      callback.close();
    }
  });

  test("keeps same-thread C-string pointers borrowed", () => {
    const callback = new JSCallback((text, borrowed) => {
      expect(text).toBe(borrowed);
      toBuffer(text, 0, 1)[0] = 77;
      return 7;
    }, { args: ["cstring", "ptr"], returns: "i32", threadsafe: true });
    try {
      expect(library.symbols.ffi_cstring_immediate(callback.ptr)).toBe(1);
    } finally {
      callback.close();
    }
  });

  test("keeps result-waiting foreign-thread C-string pointers borrowed", async () => {
    let received = false;
    const callback = new JSCallback((text, borrowed) => {
      expect(text).toBe(borrowed);
      toBuffer(text, 0, 1)[0] = 77;
      received = true;
      return 7;
    }, { args: ["cstring", "ptr"], returns: "i32", threadsafe: true });
    try {
      expect(library.symbols.ffi_cstring_start_blocking(callback.ptr)).toBe(0);
      await waitFor(() => received);
      expect(library.symbols.ffi_cstring_join_blocking()).toBe(1);
    } finally {
      callback.close();
    }
  });

  test("discards queued strings when the callback closes before delivery", async () => {
    let calls = 0;
    const callback = new JSCallback(() => { calls++; }, burstSignature);
    try {
      expect(library.symbols.ffi_cstring_burst(callback.ptr, 64)).toBe(0);
    } finally {
      callback.close();
    }
    await Bun.sleep(20);
    expect(calls).toBe(0);
  });

  test("closing during a burst discards the remaining jobs", async () => {
    let calls = 0;
    const callback = new JSCallback(() => {
      calls++;
      callback.close();
    }, burstSignature);
    try {
      expect(library.symbols.ffi_cstring_burst(callback.ptr, 64)).toBe(0);
      await waitFor(() => calls > 0);
      expect(calls).toBe(1);
    } finally {
      callback.close();
    }
  });
});
