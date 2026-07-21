import { expect, test } from "bun:test";

test("dynamic builtin import preserves the live CommonJS process object", async () => {
  const defaultDescriptor = Object.getOwnPropertyDescriptor(process, "default");
  const helloDescriptor = Object.getOwnPropertyDescriptor(process, "hello");

  try {
    process.default = 1;
    process.hello = 2;

    const processModule = await import("node:process");
    expect(processModule.default).toBe(process);
    expect(processModule.default.default).toBe(1);
    expect(processModule.hello).toBe(2);
    expect(processModule.default.hello).toBe(2);
  } finally {
    if (defaultDescriptor) Object.defineProperty(process, "default", defaultDescriptor);
    else delete process.default;
    if (helloDescriptor) Object.defineProperty(process, "hello", helloDescriptor);
    else delete process.hello;
  }
});
