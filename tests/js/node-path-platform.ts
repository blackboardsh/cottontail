import { delimiter, isAbsolute, posix, sep, win32 } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (cottontail.platform() === "win32") {
  assert(sep === "\\", `node:path named sep export mismatch: ${JSON.stringify(sep)}`);
  assert(delimiter === ";", `node:path named delimiter export mismatch: ${JSON.stringify(delimiter)}`);
  assert(isAbsolute("C:\\windows-absolute"), "node:path named isAbsolute export rejected a drive path");
  assert(isAbsolute("\\\\server\\share\\windows-absolute"), "node:path named isAbsolute export rejected a UNC path");
  assert(
    /^(\.\.\/){3,5}x$/.test(posix.relative("a/b/c", "../../x")),
    "path.posix.relative used the Windows cwd as one backslash-containing segment",
  );
  assert(win32.normalize("CON:") === ".\\CON:.", "node:path did not normalize a reserved device name");
  assert(
    win32.normalize("\\\\?\\COM1:.\\..\\..\\foo.js") === "\\\\?\\COM1:\\foo.js",
    "node:path did not normalize a reserved namespaced device path",
  );
} else {
  assert(sep === "/", `node:path named sep export mismatch: ${JSON.stringify(sep)}`);
  assert(delimiter === ":", `node:path named delimiter export mismatch: ${JSON.stringify(delimiter)}`);
  assert(isAbsolute("/posix-absolute"), "node:path named isAbsolute export rejected a POSIX path");
}

console.log("node path platform exports passed");
