import { spawn } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const child = spawn("sh", ["-c", "read value; printf stdout-$value; printf stderr-$value >&2"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const result = await new Promise<{ code: number | null; signal: number | null }>((resolve) => {
  child.on("close", (code, signal) => resolve({ code, signal }));
  child.stdin.end("ok");
});

assert(result.code === 0, `child_process.spawn exit mismatch: ${result.code}`);
assert(result.signal === null, `child_process.spawn signal mismatch: ${result.signal}`);
assert(stdout === "stdout-ok", `child_process.spawn stdout mismatch: ${JSON.stringify(stdout)}`);
assert(stderr === "stderr-ok", `child_process.spawn stderr mismatch: ${JSON.stringify(stderr)}`);

const inherited = spawn("sh", ["-c", "printf inherited-stdout; printf inherited-stderr >&2"], {
  stdio: "inherit",
});

const inheritedResult = await new Promise<{ code: number | null; signal: number | null }>((resolve) => {
  inherited.on("close", (code, signal) => resolve({ code, signal }));
});

assert(inherited.stdout === null, "inherited child stdout should be null");
assert(inherited.stderr === null, "inherited child stderr should be null");
assert(inheritedResult.code === 0, `inherited child exit mismatch: ${inheritedResult.code}`);
assert(inheritedResult.signal === null, `inherited child signal mismatch: ${inheritedResult.signal}`);

console.log("node child_process spawn passed");
