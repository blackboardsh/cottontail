import assert from "node:assert/strict";

async function runRepl(args: string[], input = "") {
  const process = Bun.spawn({
    cmd: [globalThis.process.execPath, "repl", ...args],
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...globalThis.process.env, HOME: "", TERM: "dumb", NO_COLOR: "1" },
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
assert.equal(session.stdout.match(/Welcome to Bun/g)?.length, 1);

const persistentValues = await runRepl(
  [],
  "class Point { constructor(value) { this.value = value; } }\nnew Point(7).value\n({ value: 9, nested: true })\n.exit\n",
);
assert.equal(persistentValues.exitCode, 0);
assert.match(persistentValues.stdout, /7/);
assert.match(persistentValues.stdout, /nested/);

const eof = Bun.spawnSync({
  cmd: [globalThis.process.execPath, "repl"],
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  timeout: 3000,
  env: { ...globalThis.process.env, HOME: "", TERM: "dumb", NO_COLOR: "1" },
});
const eofStdout = eof.stdout?.toString() ?? "";
const eofStderr = eof.stderr?.toString() ?? "";
assert.equal(eof.exitCode, 0);
assert.match(eofStdout, /Welcome to Bun/);
assert.doesNotMatch(`${eofStdout}\n${eofStderr}`, /Resolving dependencies|bun add/);

const printed = await runRepl(["-p", "await Promise.resolve('ready')"]);
assert.equal(printed.exitCode, 0);
assert.equal(printed.stdout, '"ready"\n');
assert.equal(printed.stderr, "");

console.log("bun repl cli tests passed");
