import { delimiter, isAbsolute, sep } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (cottontail.platform() === "win32") {
  assert(sep === "\\", `node:path named sep export mismatch: ${JSON.stringify(sep)}`);
  assert(delimiter === ";", `node:path named delimiter export mismatch: ${JSON.stringify(delimiter)}`);
  assert(isAbsolute("C:\\windows-absolute"), "node:path named isAbsolute export rejected a drive path");
  assert(isAbsolute("\\\\server\\share\\windows-absolute"), "node:path named isAbsolute export rejected a UNC path");
} else {
  assert(sep === "/", `node:path named sep export mismatch: ${JSON.stringify(sep)}`);
  assert(delimiter === ":", `node:path named delimiter export mismatch: ${JSON.stringify(delimiter)}`);
  assert(isAbsolute("/posix-absolute"), "node:path named isAbsolute export rejected a POSIX path");
}

console.log("node path platform exports passed");
