import { spawnSync } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const result = cottontail.platform() === "win32"
  ? spawnSync(
      "cmd.exe",
      ["/D", "/C", "echo inherited-sync-stdout & echo inherited-sync-stderr 1>&2 & exit /B 23"],
      { stdio: "inherit" },
    )
  : spawnSync(
      "sh",
      ["-c", "printf inherited-sync-stdout; printf inherited-sync-stderr >&2; exit 23"],
      { stdio: "inherit" },
    );

assert(result.status === 23, `inherited spawnSync exit mismatch: ${result.status}`);
assert(result.signal === null, `inherited spawnSync signal mismatch: ${result.signal}`);
assert(result.stdout === null, "inherited spawnSync stdout should be null");
assert(result.stderr === null, "inherited spawnSync stderr should be null");
console.log("node child inherited sync passed");
