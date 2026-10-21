import { beforeAll, afterAll } from 'bun:test';

let originalSpawnSync;
beforeAll(() => {
  originalSpawnSync = Bun.spawnSync;
  Bun.spawnSync = function (command, ...rest) {
    const argv = Array.isArray(command) ? command : command?.cmd;
    if (!argv?.includes('--hutch-shell-file')) {
      return originalSpawnSync.call(this, command, ...rest);
    }
    const started = performance.now();
    const remainingBeforeMs = globalThis.__cottontailCurrentTestRemainingMs?.();
    const result = originalSpawnSync.call(this, command, ...rest);
    console.error('HUTCH_CHILD_RESULT ' + JSON.stringify({
      test: globalThis.__cottontailCurrentTestName?.(),
      command: argv,
      elapsedMs: performance.now() - started,
      remainingBeforeMs,
      callerTimeoutMs: rest[0]?.timeout ?? null,
      remainingAfterMs: globalThis.__cottontailCurrentTestRemainingMs?.(),
      exitCode: result.exitCode,
      signalCode: result.signalCode,
      exitedDueToTimeout: result.exitedDueToTimeout,
      exitedDueToMaxBuffer: result.exitedDueToMaxBuffer,
      success: result.success,
      pid: result.pid,
      error: result.error == null ? undefined : String(result.error),
      stdout: result.stdout?.toString(),
      stderr: result.stderr?.toString(),
    }));
    return result;
  };
});
afterAll(() => { Bun.spawnSync = originalSpawnSync; });
