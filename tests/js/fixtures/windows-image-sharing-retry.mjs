// Test fixtures only: freshly executed Windows images can remain temporarily
// sharing-locked even after their process handles have closed. A native probe
// reproduced ERROR_SHARING_VIOLATION (32) with both Cottontail and Node, then
// succeeded about 1.7 seconds later. Do not apply this to production fs calls.
export const windowsImageRetryBudgetMs = 3_000;
const retryDelayMs = 50;
const sharingErrors = new Set(["EACCES", "EBUSY", "EPERM"]);
let waiter;

function sleepSync(milliseconds) {
  waiter ??= new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waiter, 0, 0, milliseconds);
}

// The caller must own the exact just-executed image or disposable fixture
// directory. The retry window never changes the enclosing test's deadline.
export function withOwnedWindowsImageRetry(operation, {
  platform = process.platform,
  now = () => performance.now(),
  sleep = sleepSync,
} = {}) {
  if (platform !== "win32") return operation();
  const deadline = now() + windowsImageRetryBudgetMs;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!sharingErrors.has(error?.code)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      sleep(Math.min(retryDelayMs, remaining));
      // Never begin another filesystem operation at or beyond the deadline.
      if (now() >= deadline) throw error;
    }
  }
}
