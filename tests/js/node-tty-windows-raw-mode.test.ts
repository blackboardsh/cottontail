import { describe, expect, test } from "bun:test";
import { dlopen, ptr } from "bun:ffi";
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import tty from "node:tty";

const PTY_UNSUPPORTED = "PTY not supported on this platform";
const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;
const ENABLE_LINE_INPUT = 0x0002;
const ENABLE_ECHO_INPUT = 0x0004;
const ENABLE_WINDOW_INPUT = 0x0008;

describe("Windows console raw mode", () => {
  test("uses libuv raw and normal modes without leaving the console changed", () => {
    if (process.platform !== "win32") return;

    const kernel32 = dlopen("kernel32.dll", {
      GetStdHandle: { args: ["int32_t"], returns: "ptr" },
      GetConsoleMode: { args: ["ptr", "ptr"], returns: "bool" },
      SetConsoleMode: { args: ["ptr", "uint32_t"], returns: "bool" },
    });
    const { GetStdHandle, GetConsoleMode, SetConsoleMode } = kernel32.symbols;
    const inputHandle = GetStdHandle(STD_INPUT_HANDLE);
    const originalMode = new Uint32Array(1);
    const input = new tty.ReadStream(0);
    let hasConsole = false;

    try {
      hasConsole = inputHandle !== null && GetConsoleMode(inputHandle, ptr(originalMode));
      if (!hasConsole) {
        expect(() => input.setRawMode(true)).toThrow(PTY_UNSUPPORTED);
        expect(input.isRaw).toBe(false);
        return;
      }

      expect(input.setRawMode(true)).toBe(input);
      expect(input.isRaw).toBe(true);
      const rawMode = new Uint32Array(1);
      expect(GetConsoleMode(inputHandle, ptr(rawMode))).toBe(true);
      expect(rawMode[0] & ENABLE_WINDOW_INPUT).toBe(ENABLE_WINDOW_INPUT);
      expect(rawMode[0] & (ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT)).toBe(0);

      expect(input.setRawMode(false)).toBe(input);
      expect(input.isRaw).toBe(false);
      const normalMode = new Uint32Array(1);
      expect(GetConsoleMode(inputHandle, ptr(normalMode))).toBe(true);
      expect(normalMode[0]).toBe(ENABLE_PROCESSED_INPUT | ENABLE_LINE_INPUT | ENABLE_ECHO_INPUT);
    } finally {
      if (hasConsole && inputHandle !== null) {
        SetConsoleMode(inputHandle, originalMode[0]);
      }
      kernel32.close();
    }
  });

  test("keeps non-console descriptors unsupported", () => {
    if (process.platform !== "win32") return;

    const path = join(tmpdir(), `cottontail-tty-${process.pid}-${Date.now()}.tmp`);
    const fd = openSync(path, "w+");
    try {
      const input = new tty.ReadStream(fd);
      expect(input.isTTY).toBe(false);
      expect(() => input.setRawMode(true)).toThrow(PTY_UNSUPPORTED);
      expect(input.isRaw).toBe(false);
    } finally {
      closeSync(fd);
      rmSync(path, { force: true });
    }
  });

  test("keeps Bun.Terminal unsupported without Windows PTY support", () => {
    if (process.platform !== "win32") return;
    expect(() => new Bun.Terminal({})).toThrow(PTY_UNSUPPORTED);
  });
});
