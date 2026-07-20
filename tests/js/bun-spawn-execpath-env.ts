import { spawn } from "bun";
import { isAbsolute } from "node:path";

function assert(value: unknown, message: string) {
  if (!value) throw new Error(message);
}

process.env.COTTONTAIL_ELECTROBUN_DIST = "/tmp/fake-electrobun";
process.env.COTTONTAIL_ELECTROBUN_NAME = "Fake";

assert(isAbsolute(process.execPath), `process.execPath is not absolute: ${process.execPath}`);
assert(cottontail.execPath() === process.execPath, "host and process exec paths differ");

const childPath = `${import.meta.dirname}/fixtures/print-electrobun-env.ts`;
const proc = spawn([process.execPath, childPath], {
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr, code] = await Promise.all([
  proc.stdout!.text(),
  proc.stderr!.text(),
  proc.exited,
]);

assert(code === 0, `child failed ${code}: ${stderr}`);

const parsed = JSON.parse(stdout);
assert(parsed.dist === "" && parsed.name === "", `electrobun env leaked: ${stdout}`);

console.log("bun spawn execpath env passed");
