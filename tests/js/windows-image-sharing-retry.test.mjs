import assert from "node:assert/strict";
import { test } from "node:test";
import { withOwnedWindowsImageRetry, windowsImageRetryBudgetMs } from "./fixtures/windows-image-sharing-retry.mjs";

function clock(platform = "win32") {
  let elapsed = 0;
  const sleeps = [];
  return {
    options: { platform, now: () => elapsed, sleep: (milliseconds) => { sleeps.push(milliseconds); elapsed += milliseconds; } },
    advance: (milliseconds) => { elapsed += milliseconds; },
    get elapsed() { return elapsed; },
    sleeps,
  };
}

test("successful operations preserve their result without sleeping", () => {
  const fake = clock();
  const result = {};
  assert.equal(withOwnedWindowsImageRetry(() => result, fake.options), result);
  assert.deepEqual(fake.sleeps, []);
});

test("Windows sharing failures retry until the same operation succeeds", () => {
  const fake = clock();
  const errors = ["EACCES", "EBUSY", "EPERM"];
  let attempts = 0;
  const result = withOwnedWindowsImageRetry(() => {
    const code = errors[attempts++];
    if (code) throw Object.assign(new Error(code), { code });
    return "complete";
  }, fake.options);
  assert.equal(result, "complete");
  assert.equal(attempts, 4);
  assert.deepEqual(fake.sleeps, [50, 50, 50]);
});

test("persistent sharing failures are bounded to three seconds and preserve the last error", () => {
  const fake = clock();
  let attempts = 0;
  let lastError;
  assert.throws(() => withOwnedWindowsImageRetry(() => {
    lastError = Object.assign(new Error(`attempt ${++attempts}`), { code: "EACCES" });
    throw lastError;
  }, fake.options), error => error === lastError);
  assert.equal(windowsImageRetryBudgetMs, 3_000);
  assert.equal(fake.elapsed, 3_000);
  assert.equal(attempts, 60, "no retry begins at the deadline");
  assert.equal(fake.sleeps.length, 60);
});

test("the final delay is clamped to the remaining budget", () => {
  const fake = clock();
  const error = Object.assign(new Error("locked"), { code: "EBUSY" });
  let attempts = 0;
  assert.throws(() => withOwnedWindowsImageRetry(() => {
    attempts++;
    fake.advance(2_995);
    throw error;
  }, fake.options), received => received === error);
  assert.equal(attempts, 1);
  assert.deepEqual(fake.sleeps, [5]);
  assert.equal(fake.elapsed, 3_000);
});

test("an operation consuming the budget is not retried or followed by a delay", () => {
  const fake = clock();
  const error = Object.assign(new Error("locked"), { code: "EPERM" });
  let attempts = 0;
  assert.throws(() => withOwnedWindowsImageRetry(() => {
    attempts++;
    fake.advance(3_000);
    throw error;
  }, fake.options), received => received === error);
  assert.equal(attempts, 1);
  assert.deepEqual(fake.sleeps, []);
});

test("other errors fail immediately, including after a transient sharing failure", () => {
  for (const error of [Object.assign(new Error("not found"), { code: "ENOENT" }), new Error("unknown"), null]) {
    const fake = clock();
    let attempts = 0;
    assert.throws(() => withOwnedWindowsImageRetry(() => {
      attempts++;
      if (attempts === 1) throw Object.assign(new Error("locked"), { code: "EBUSY" });
      throw error;
    }, fake.options), received => received === error);
    assert.equal(attempts, 2);
    assert.deepEqual(fake.sleeps, [50]);
  }
});

test("non-Windows calls are unchanged and never consult the retry clock", () => {
  for (const platform of ["linux", "darwin"]) {
    const error = Object.assign(new Error("denied"), { code: "EACCES" });
    let attempts = 0;
    assert.throws(() => withOwnedWindowsImageRetry(() => { attempts++; throw error; }, {
      platform,
      now: () => { throw new Error("must not read the retry clock"); },
      sleep: () => { throw new Error("must not sleep"); },
    }), received => received === error);
    assert.equal(attempts, 1);
  }
});
