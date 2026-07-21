import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import fs from "fs";
import tty from "tty";

import { dlopen } from "bun:ffi";

describe("node:tty constructors", () => {
  test("ReadStream is callable with and without new", () => {
    const direct = tty.ReadStream(0);
    const constructed = new tty.ReadStream(0);

    expect(direct).toBeInstanceOf(tty.ReadStream);
    expect(constructed).toBeInstanceOf(tty.ReadStream);
    expect(direct).toBeInstanceOf(EventEmitter);
  });

  test("WriteStream is callable with and without new", () => {
    const direct = tty.WriteStream(1);
    const constructed = new tty.WriteStream(2);

    expect(direct).toBeInstanceOf(tty.WriteStream);
    expect(constructed).toBeInstanceOf(tty.WriteStream);
    expect(direct).toBeInstanceOf(EventEmitter);
  });
});

test("process writable stdio uses the TTY WriteStream prototype", () => {
  expect(typeof dlopen).toBe("function");
  expect(typeof fs.ReadStream).toBe("function");
  expect(process.stdin instanceof fs.ReadStream).toBe(true);
  expect(process.stdout instanceof tty.WriteStream).toBe(true);
  expect(process.stderr instanceof tty.WriteStream).toBe(true);
  expect(process.stdout.fd).toBe(1);
  expect(process.stderr.fd).toBe(2);
  expect(typeof process.stdout.getWindowSize).toBe("function");
});
