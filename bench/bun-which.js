import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const isWindows = process.platform === "win32";
const suffix = isWindows ? ".cmd" : "";
const iterations = Number(process.argv[2] ?? 500);
const root = mkdtempSync(join(tmpdir(), "cottontail-bench-which-"));

function createPathList(name, count, command) {
  const directories = [];
  for (let index = 0; index < count; index += 1) {
    const directory = join(root, `${name}-${index}`);
    mkdirSync(directory, { recursive: true });
    directories.push(directory);
  }
  const executable = join(directories.at(-1), command + suffix);
  writeFileSync(executable, isWindows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWindows) chmodSync(executable, 0o755);
  return directories.join(delimiter);
}

function measure(command, path, count) {
  for (let index = 0; index < 100; index += 1) Bun.which(command, { PATH: path });
  const start = Bun.nanoseconds();
  for (let index = 0; index < count; index += 1) Bun.which(command, { PATH: path });
  return (Bun.nanoseconds() - start) / count;
}

try {
  const shortCommand = "short-found";
  const longCommand = "long-found";
  const shortPath = createPathList("short", 4, shortCommand);
  const longPath = createPathList("long", 64, longCommand);
  const result = {
    shortFoundNs: measure(shortCommand, shortPath, iterations),
    shortMissingNs: measure("short-missing", shortPath, iterations),
    longFoundNs: measure(longCommand, longPath, iterations),
    longMissingNs: measure("long-missing", longPath, iterations),
  };
  console.log(JSON.stringify(result));
} finally {
  rmSync(root, { recursive: true, force: true });
}
