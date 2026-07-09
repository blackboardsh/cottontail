import { spawn } from "bun";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const childPath = `${import.meta.dirname}/fixtures/readline-stdio-child.ts`;
const proc = spawn([process.execPath, childPath], {
  stdin: "pipe",
  stdout: "pipe",
  stderr: "pipe",
});

proc.stdin!.write("alpha\nbeta\r\n");
proc.stdin!.end();

const exitCode = await proc.exited;
const stdout = await proc.stdout!.text();
const stderr = await proc.stderr!.text();

assert(exitCode === 0, `readline child exited with ${exitCode}: ${stderr}`);
assert(stdout === "line:alpha\nline:beta\nclosed", `readline stdout mismatch: ${JSON.stringify(stdout)}`);

console.log("node readline passed");
