import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertBytes(actual: Uint8Array, expected: Uint8Array, label: string): void {
  assert(
    actual.byteLength === expected.byteLength,
    `${label} length mismatch: ${actual.byteLength} !== ${expected.byteLength}`,
  );
  for (let index = 0; index < expected.byteLength; index += 1) {
    assert(actual[index] === expected[index], `${label} byte ${index}: ${actual[index]} !== ${expected[index]}`);
  }
}

const tempDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tempDir, "COTTONTAIL_TMP_DIR missing");

const expected = Uint8Array.from([0x00, 0x41, 0x0d, 0x0a, 0x42, 0x1a, 0x43, 0x0a, 0x0d, 0xff]);
const source = join(tempDir, "node-fs-binary-source.bin");
const copyDestination = join(tempDir, "node-fs-binary-copy.bin");
const cpDestination = join(tempDir, "node-fs-binary-cp.bin");

rmSync(copyDestination, { force: true });
rmSync(cpDestination, { force: true });

const stringFlagsRead = readFileSync(source);
const numericFd = openSync(source, constants.O_RDONLY);
let numericFlagsRead: Uint8Array;
try {
  numericFlagsRead = readFileSync(numericFd);
} finally {
  closeSync(numericFd);
}

copyFileSync(source, copyDestination);
cpSync(source, cpDestination);

assertBytes(stringFlagsRead, expected, "readFileSync string flags");
assertBytes(numericFlagsRead, expected, "readFileSync numeric flags");
assert(statSync(copyDestination).size === expected.byteLength, "copyFileSync destination size mismatch");
assert(statSync(cpDestination).size === expected.byteLength, "cpSync destination size mismatch");
assertBytes(readFileSync(copyDestination), expected, "copyFileSync destination bytes");
assertBytes(readFileSync(cpDestination), expected, "cpSync destination bytes");

console.log("node fs binary io passed");
