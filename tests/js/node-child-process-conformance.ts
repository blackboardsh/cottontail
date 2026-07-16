import { ChildProcess, fork, spawn } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertError(fn: () => unknown, code: string, message: string) {
  try {
    fn();
  } catch (error: any) {
    assert(error?.code === code, `expected ${code}, received ${error?.code}`);
    assert(error?.message === message, `error message mismatch: ${JSON.stringify(error?.message)}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

const internal = new ChildProcess();
internal.spawn({
  file: process.execPath,
  args: [process.execPath, "-e", "process.stdout.write(process.env.COTTONTAIL_CHILD_PROCESS_ENV_PAIR || '')"],
  envPairs: ["COTTONTAIL_CHILD_PROCESS_ENV_PAIR=from-env-pairs"],
  stdio: ["ignore", "pipe", "ignore"],
});
let envOutput = "";
internal.stdout.on("data", chunk => {
  envOutput += chunk.toString();
});
await new Promise<void>((resolve, reject) => {
  internal.once("error", reject);
  internal.once("close", code => {
    if (code === 0) resolve();
    else reject(new Error(`internal ChildProcess.spawn exited with ${code}`));
  });
});
assert(envOutput === "from-env-pairs", `envPairs mismatch: ${JSON.stringify(envOutput)}`);

const originalSpawn = ChildProcess.prototype.spawn;
let prototypeSpawnCalled = false;
ChildProcess.prototype.spawn = function observedSpawn(options: any) {
  prototypeSpawnCalled = true;
  return originalSpawn.call(this, options);
};
let observedChild;
try {
  observedChild = spawn(process.execPath, ["-e", ""], { stdio: null });
} finally {
  ChildProcess.prototype.spawn = originalSpawn;
}
await new Promise<void>((resolve, reject) => {
  observedChild.once("error", reject);
  observedChild.once("close", () => resolve());
});
assert(prototypeSpawnCalled, "exported spawn() bypassed ChildProcess.prototype.spawn()");

for (const invalid of [0, true, () => {}, Symbol("invalid")]) {
  try {
    fork(import.meta.path, invalid as any);
  } catch (error: any) {
    assert(error?.code === "ERR_INVALID_ARG_TYPE", `invalid fork args code mismatch: ${error?.code}`);
    continue;
  }
  throw new Error(`fork accepted invalid args: ${String(invalid)}`);
}

const child = fork(`${import.meta.dirname}/fixtures/fork-child.js`);
assert(child.channel === child._channel, "fork channel and _channel must alias the same control object");
assert(typeof child.channel?.ref === "function", "fork channel.ref is missing");
assert(typeof child.channel?.unref === "function", "fork channel.unref is missing");
assertError(() => child.send(), "ERR_MISSING_ARGS", 'The "message" argument must be specified');
assertError(
  () => child.send(Symbol()),
  "ERR_INVALID_ARG_TYPE",
  'The "message" argument must be one of type string, object, number, or boolean. Received type symbol (Symbol())',
);

await new Promise<void>((resolve, reject) => {
  child.once("error", reject);
  child.on("message", message => {
    if (message?.ready) child.send({ value: "done" });
  });
  child.once("close", code => {
    if (code === 0) resolve();
    else reject(new Error(`fork child exited with ${code}`));
  });
});

console.log("node child_process conformance passed");
