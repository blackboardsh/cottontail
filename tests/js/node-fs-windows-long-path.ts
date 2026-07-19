import { existsSync } from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (cottontail.platform() === "win32") {
  assert(!existsSync(""), "existsSync should reject an empty Windows path");
  const cwd = cottontail.cwd().replaceAll("/", "\\");
  const longPath = `${cwd}\\${".\\".repeat(140)}README.md`;
  assert(longPath.length > 260, `long-path probe was unexpectedly short: ${longPath.length}`);
  assert(existsSync(longPath), `existsSync rejected an existing long path: ${longPath}`);
}

console.log("node fs windows long path passed");
