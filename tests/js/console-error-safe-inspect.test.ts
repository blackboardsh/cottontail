import { expect, test } from "bun:test";

test("console inspection survives hostile Error accessors", async () => {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", `
      const error = new Error("Test error");
      Object.defineProperty(error, "stack", {
        get() { throw new Error("stack getter should stay contained"); },
      });
      Object.defineProperty(error, "cause", {
        get() { throw new Error("cause getter should stay contained"); },
      });
      error.normalProp = "works";
      console.log(error);
      console.log("after error print");
    `],
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("normalProp");
  expect(stdout).toContain("after error print");
  expect(stdout).not.toContain("getter should stay contained");
  expect(stderr).not.toContain("getter should stay contained");
});
