import { spawn } from "bun";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const proc = spawn(["sh", "-c", "printf first; sleep 0.25; printf second"], {
  stdout: "pipe",
  stderr: "pipe",
});

const reader = proc.stdout!.getReader();
const first = await Promise.race([
  reader.read(),
  delay(150).then(() => null),
]);

assert(first !== null, "Bun.spawn stdout reader did not stream before process exit");
assert(first.done === false, "Bun.spawn stdout reader ended before first chunk");
assert(new TextDecoder().decode(first.value) === "first", "Bun.spawn first stdout chunk mismatch");

let rest = "";
for (;;) {
  const chunk = await reader.read();
  if (chunk.done) break;
  rest += new TextDecoder().decode(chunk.value);
}

const exitCode = await proc.exited;
assert(exitCode === 0, `Bun.spawn streaming child exited with ${exitCode}`);
assert(rest === "second", `Bun.spawn remaining stdout mismatch: ${JSON.stringify(rest)}`);

console.log("bun spawn streaming passed");
