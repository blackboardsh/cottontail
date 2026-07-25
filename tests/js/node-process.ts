import { spawnSync } from "node:child_process";
import processModule from "node:process";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

assert(process.release?.name === "node", "global process.release.name mismatch");
assert(processModule.release?.name === "node", "node:process release.name mismatch");
assert(typeof process.version === "string" && process.version.length > 0, "process.version missing");
assert(typeof process.versions?.node === "string", "process.versions.node missing");
assert(typeof process.versions?.cottontail === "string", "process.versions.cottontail missing");

if (process.platform === "win32") {
  const abortResult = spawnSync(process.execPath, ["-e", "process.abort()"], { stdio: "ignore" });
  assert(abortResult.status === 134, `Windows process.abort() exited with ${abortResult.status}`);
  assert(abortResult.signal == null, `Windows process.abort() reported signal ${abortResult.signal}`);

  const ordinaryError = spawnSync(
    process.execPath,
    ["-e", 'throw new RangeError("Out of memory")'],
    { stdio: "ignore" },
  );
  assert(
    ordinaryError.status === 1,
    `a user-thrown Out of memory error exited with ${ordinaryError.status} instead of 1`,
  );
}

console.log("node process passed");
