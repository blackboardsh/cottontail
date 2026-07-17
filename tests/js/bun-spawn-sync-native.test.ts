function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const executable = process.execPath;
const isWindows = process.platform === "win32";
const killSignal = isWindows ? 9 : 1;

const timeoutStarted = Date.now();
const timeoutResult = cottontail.spawnSync(
  executable,
  ["-e", `process.stdout.write("before-timeout"); await Bun.sleep(5000);`],
  {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 1000,
    killSignal,
  },
);
const timeoutElapsed = Date.now() - timeoutStarted;
assert(timeoutResult.exitedDueToTimeout === true, "spawnSync did not report its native timeout");
assert(timeoutResult.exitedDueToMaxBuffer === false, "timeout was misreported as maxBuffer");
assert(timeoutResult.signalCode === killSignal, `timeout signal mismatch: ${timeoutResult.signalCode}`);
assert(timeoutResult.stdout === "before-timeout", `timeout partial stdout mismatch: ${timeoutResult.stdout}`);
assert(timeoutResult.pid > 0, `timeout pid mismatch: ${timeoutResult.pid}`);
assert(timeoutElapsed >= 900 && timeoutElapsed < 2500, `timeout elapsed ${timeoutElapsed}ms`);

const controller = new AbortController();
controller.abort();
const abortStarted = Date.now();
const abortResult = cottontail.spawnSync(
  executable,
  ["-e", `await Bun.sleep(5000);`],
  {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    signal: controller.signal,
    killSignal,
  },
);
assert(abortResult.signalCode === killSignal, `abort signal mismatch: ${abortResult.signalCode}`);
assert(abortResult.exitedDueToTimeout === false, "abort was misreported as timeout");
assert(abortResult.exitedDueToMaxBuffer === false, "abort was misreported as maxBuffer");
assert(Date.now() - abortStarted < 1500, "already-aborted signal did not terminate promptly");

const maxBufferStarted = Date.now();
const maxBufferResult = cottontail.spawnSync(
  executable,
  ["-e", `const chunk = "y\\n".repeat(128); for (;;) process.stdout.write(chunk);`],
  {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 256,
    killSignal,
  },
);
const maxBufferElapsed = Date.now() - maxBufferStarted;
assert(maxBufferResult.exitedDueToMaxBuffer === true, "spawnSync did not report maxBuffer termination");
assert(maxBufferResult.exitedDueToTimeout === false, "maxBuffer was misreported as timeout");
assert(maxBufferResult.signalCode === killSignal, `maxBuffer signal mismatch: ${maxBufferResult.signalCode}`);
assert(maxBufferResult.stdout.length > 256, `maxBuffer partial stdout was truncated: ${maxBufferResult.stdout.length}`);
assert(maxBufferResult.stdout.startsWith("y\n".repeat(128)), "maxBuffer partial stdout content mismatch");
assert(maxBufferElapsed < 1500, `maxBuffer elapsed ${maxBufferElapsed}ms`);

const input = new TextEncoder().encode("input-through-pipe");
const inputResult = cottontail.spawnSync(
  executable,
  ["-e", `process.stdin.pipe(process.stdout);`],
  {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    input,
  },
);
assert(inputResult.status === 0, `piped input child failed: ${inputResult.status}`);
assert(inputResult.stdout === "input-through-pipe", `piped input mismatch: ${inputResult.stdout}`);
assert(inputResult.stderr === undefined, "ignored stderr should be absent");

const largeInput = new Uint8Array(512 * 1024).fill("i".charCodeAt(0));
const duplexResult = cottontail.spawnSync(
  executable,
  ["-e", `process.stdout.write("o".repeat(512 * 1024)); process.stdin.pipe(process.stdout);`],
  {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    input: largeInput,
  },
);
assert(duplexResult.status === 0, `duplex child failed: ${duplexResult.status}`);
assert(duplexResult.stdout.length === 1024 * 1024, `duplex output length mismatch: ${duplexResult.stdout.length}`);
assert(duplexResult.stdout.charCodeAt(0) === "o".charCodeAt(0), "duplex prefix mismatch");
assert(duplexResult.stdout.charCodeAt(duplexResult.stdout.length - 1) === "i".charCodeAt(0), "duplex suffix mismatch");

let spawnError: unknown;
try {
  cottontail.spawnSync("cottontail-definitely-missing-executable", [], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
} catch (error) {
  spawnError = error;
}
assert(String(spawnError).includes("FileNotFound"), "missing executable did not propagate a native spawn error");

console.log("native Bun.spawnSync contract passed");
