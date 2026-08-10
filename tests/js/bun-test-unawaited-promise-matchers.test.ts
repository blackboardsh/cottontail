import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let matcherSettled = false;

test("waits for an un-awaited resolves matcher at invocation", () => {
  const value = new Promise<number>(resolve => {
    setTimeout(() => {
      matcherSettled = true;
      resolve(42);
    }, 10);
  });

  expect(value).resolves.toBe(42);
  expect(matcherSettled).toBe(true);
});

test("does not advance until the matcher settles", () => {
  expect(matcherSettled).toBe(true);
});

test("settles an async not.toThrow timer before lexical resource disposal", () => {
  let callbackSettled = false;
  let disposedAfterSettlement = false;

  {
    using _resource = {
      [Symbol.dispose]() {
        disposedAfterSettlement = callbackSettled;
      },
    };

    expect(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      callbackSettled = true;
    }).not.toThrow();
  }

  expect(callbackSettled).toBe(true);
  expect(disposedAfterSettlement).toBe(true);
});

test("async not.toThrow does not suppress an unrelated unhandled rejection", () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-async-matcher-"));
  const fixture = join(directory, "unrelated-rejection.test.ts");
  writeFileSync(fixture, `
    import { expect, test } from "bun:test";

    test("unrelated rejection", () => {
      Promise.reject(new Error("unrelated rejection during matcher pump"));
      expect(async () => {
        await new Promise(resolve => setTimeout(resolve, 0));
      }).not.toThrow();
    });
  `);

  const env = { ...process.env, AGENT: "0" };
  delete env.COTTONTAIL_TEST_AGGREGATE_FILE;
  delete env.COTTONTAIL_TEST_REPORTER_AGGREGATE_FILE;
  delete env.COTTONTAIL_TEST_CLI_HEADER_PRINTED;
  delete env.COTTONTAIL_TEST_FILE_COUNT;

  try {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "test", fixture, "--timeout=1000", "--max-concurrency=1"],
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = String(result.stderr);
    expect(result.exitCode, stderr).toBe(1);
    expect(stderr).toContain("unrelated rejection during matcher pump");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("native waitForPromise supports a bounded status check", () => {
  const host = globalThis.cottontail as {
    waitForPromise(promise: Promise<unknown>, timeout?: unknown): number;
  };

  let expirationTimer: ReturnType<typeof setTimeout>;
  const resolvesLater = new Promise<void>(resolve => {
    expirationTimer = setTimeout(resolve, 1_000);
  });
  expect(host.waitForPromise(resolvesLater, 5)).toBe(0);
  clearTimeout(expirationTimer!);

  let timerFired = false;
  let settlementTimer: ReturnType<typeof setTimeout>;
  const pending = new Promise<void>(resolve => {
    settlementTimer = setTimeout(() => {
      timerFired = true;
      resolve();
    }, 1);
  });

  expect(host.waitForPromise(pending, 0)).toBe(0);
  expect(timerFired).toBe(false);
  expect(host.waitForPromise(pending, 5_000)).toBe(1);
  expect(timerFired).toBe(true);
  clearTimeout(settlementTimer!);
});

test("native waitForPromise validates its optional timeout", () => {
  const host = globalThis.cottontail as {
    waitForPromise(promise: Promise<unknown>, timeout?: unknown): number;
  };
  const settled = Promise.resolve();
  const marker = new Error("timeout conversion marker");
  const throwingTimeout = {
    [Symbol.toPrimitive]() {
      throw marker;
    },
  };

  let conversionError: unknown;
  try {
    host.waitForPromise(settled, throwingTimeout);
  } catch (error) {
    conversionError = error;
  }
  expect(conversionError).toBe(marker);

  for (const invalid of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    expect(() => host.waitForPromise(settled, invalid)).toThrow(
      "cottontail.waitForPromise timeout must be a finite non-negative number",
    );
  }

  expect(host.waitForPromise(settled, undefined)).toBe(1);
  expect(host.waitForPromise(settled, Number.MAX_VALUE)).toBe(1);
});
