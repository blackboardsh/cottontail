import { randomUUID } from 'crypto';

const windowsJobMetadata = new WeakMap();

function validateDuration(name, value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new TypeError(`${name} must be a positive safe integer no greater than 2147483647`);
  }
}

export function startWindowsJobChild(command, args, options) {
  const {
    jobLauncher,
    parentPid = process.pid,
    spawnOptions,
    spawnProcess,
  } = options;
  if (typeof command !== 'string' || command.length === 0) {
    throw new TypeError('Windows job command must be a non-empty string');
  }
  if (!Array.isArray(args)) throw new TypeError('Windows job args must be an array');
  if (typeof jobLauncher !== 'string' || jobLauncher.length === 0) {
    throw new TypeError('jobLauncher must be a non-empty string');
  }
  if (!Number.isSafeInteger(parentPid) || parentPid < 1 || parentPid > 0xffff_ffff) {
    throw new TypeError('parentPid must be a positive 32-bit integer');
  }
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function');

  const jobName = `Local\\HutchBunCompat-${randomUUID()}`;
  const child = spawnProcess(
    jobLauncher,
    ['run', jobName, String(parentPid), command, ...args.map(String)],
    spawnOptions,
  );
  windowsJobMetadata.set(child, { jobLauncher, jobName });
  return child;
}

export function isWindowsJobChild(child) {
  return windowsJobMetadata.has(child);
}

export function terminateWindowsJobChild(child, options) {
  const { spawnProcess, timeoutMs, watchdogMs } = options;
  validateDuration('Windows job timeoutMs', timeoutMs);
  validateDuration('Windows job watchdogMs', watchdogMs);
  if (watchdogMs <= timeoutMs) {
    throw new TypeError('Windows job watchdogMs must exceed timeoutMs');
  }
  if (typeof spawnProcess !== 'function') throw new TypeError('spawnProcess must be a function');
  const metadata = windowsJobMetadata.get(child);
  if (metadata == null) {
    throw new TypeError('child was not started by the Windows Job Object launcher');
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer = null;
    let terminator = null;
    let watchdog = null;
    let lastStatus = null;
    const deadline = Date.now() + watchdogMs;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (watchdog != null) clearTimeout(watchdog);
      if (retryTimer != null) clearTimeout(retryTimer);
      watchdog = null;
      retryTimer = null;
      if (error) reject(error);
      else resolve(true);
    };
    const startAttempt = () => {
      if (settled) return;
      try {
        terminator = spawnProcess(
          metadata.jobLauncher,
          ['terminate', metadata.jobName, String(timeoutMs)],
          { stdio: 'ignore', windowsHide: true },
        );
      } catch (error) {
        finish(new Error(
          `Windows Job Object terminator failed to start: ${error?.message ?? String(error)}`,
          { cause: error },
        ));
        return;
      }
      terminator.once('error', (error) => {
        finish(new Error(
          `Windows Job Object terminator failed to start: ${error?.message ?? String(error)}`,
          { cause: error },
        ));
      });
      terminator.once('close', (code) => {
        if (settled) return;
        if (code === 0) {
          finish(null);
          return;
        }
        lastStatus = code;
        // An interrupt can arrive after the launcher process is spawned but
        // before it creates its named Job. OpenJobObject then fails quickly;
        // retry inside the same overall watchdog instead of caching that
        // startup race as a permanent failed proof.
        if (Date.now() + 25 < deadline) {
          retryTimer = setTimeout(startAttempt, 25);
          return;
        }
        finish(new Error(
          `Windows Job Object terminator exited with status ${lastStatus ?? 'unknown'}`,
        ));
      });
    };
    watchdog = setTimeout(() => {
      try { terminator?.kill('SIGKILL'); } catch {}
      terminator?.unref?.();
      finish(new Error(
        `Windows Job Object terminator did not prove teardown within ${watchdogMs}ms` +
        (lastStatus == null ? '' : ` (last status ${lastStatus})`),
      ));
    }, watchdogMs);
    startAttempt();
  });
}
