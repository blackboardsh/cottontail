import { spawn } from "node:child_process";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

// Synchronous sibling spawns must not inherit a still-open start gate. The
// second child intentionally stays alive until the first child produces data.
const first = spawn(process.execPath, ["-e", "process.stdout.write('ready')"], {
  stdio: ["ignore", "pipe", "ignore"],
});
const blocker = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
  stdio: "ignore",
});

let timeout: ReturnType<typeof setTimeout>;
const ready = await Promise.race([
  new Promise<string>((resolve, reject) => {
    first.once("error", reject);
    first.stdout.once("data", chunk => resolve(chunk.toString()));
  }),
  new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error("first child remained blocked behind a sibling spawn gate")), 1000);
  }),
]);
clearTimeout(timeout!);

assert(ready === "ready", `spawn-gate output mismatch: ${JSON.stringify(ready)}`);
blocker.kill("SIGKILL");
await new Promise<void>(resolve => blocker.once("close", () => resolve()));

console.log("node child_process spawn gate passed");
