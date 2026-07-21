import assert from "node:assert/strict";

async function runRepl(args: string[], input = "") {
  const process = Bun.spawn({
    cmd: [globalThis.process.execPath, "repl", ...args],
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, TERM: "dumb", NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    process.stdout.text(),
    process.stderr.text(),
    process.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const session = await runRepl([], "const value: number = 21\nvalue * 2\n.exit\n");
assert.equal(session.exitCode, 0);
assert.match(session.stdout, /Welcome to Bun/);
assert.match(session.stdout, /42/);

const printed = await runRepl(["-p", "await Promise.resolve('ready')"]);
assert.equal(printed.exitCode, 0);
assert.equal(printed.stdout, '"ready"\n');
assert.equal(printed.stderr, "");

console.log("bun repl cli tests passed");
