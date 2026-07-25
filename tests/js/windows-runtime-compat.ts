import { closeSync, existsSync, openSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

if (process.platform === "win32") {
  assert(
    /^(\.\.\/){3,5}x$/.test(posix.relative("a/b/c", "../../x")),
    "path.posix.relative did not normalize the Windows cwd",
  );
  assert(
    pathToFileURL("C:\\Users\\cottontail\\entry.js").href ===
      "file:///C:/Users/cottontail/entry.js",
    "pathToFileURL did not emit a drive-letter file URL",
  );
  assert(
    pathToFileURL("\\\\?\\C:\\Users\\cottontail\\entry.js").href ===
      "file:///C:/Users/cottontail/entry.js",
    "pathToFileURL treated a namespaced drive path as UNC",
  );
  assert(
    pathToFileURL("\\\\?\\UNC\\server\\share\\entry.js").href ===
      "file://server/share/entry.js",
    "pathToFileURL did not strip the extended UNC prefix",
  );
  assert(
    pathToFileURL("\\\\server\\share\\folder\\..").href ===
      "file://server/share/",
    "pathToFileURL did not normalize UNC path components",
  );
  assert(
    pathToFileURL("\\\\?\\UNC\\server\\share\\folder\\..").href ===
      "file://server/share/",
    "pathToFileURL did not normalize extended UNC path components",
  );
  assert(
    fileURLToPath("file://server/share/entry.js") === "\\\\server\\share\\entry.js",
    "fileURLToPath dropped the UNC hostname",
  );

  assert(process.env.path === process.env.PATH, "process.env PATH lookup is case-sensitive");
  const environmentKey = "Cottontail_Windows_Environment_Case";
  try {
    process.env[environmentKey] = true as never;
    assert(
      process.env.cottontail_windows_environment_case === "true",
      "process.env did not coerce or case-fold an assigned value",
    );
    assert(
      Object.keys(process.env).includes(environmentKey),
      "process.env did not preserve the spelling of a newly assigned key",
    );
  } finally {
    delete process.env.COTTONTAIL_WINDOWS_ENVIRONMENT_CASE;
  }
  assert(
    process.env.cottontail_windows_environment_case === undefined,
    "process.env did not case-fold deletion",
  );

  const nullFd = openSync("/dev/null", "r");
  closeSync(nullFd);
  assert((await Bun.file("/dev/null").arrayBuffer()).byteLength === 0, "Bun.file(/dev/null) was not empty");

  assert(existsSync(process.execPath), `process.execPath is not an existing absolute path: ${process.execPath}`);
  const child = Bun.spawnSync([process.execPath, "-p", "6 * 7"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  assert(child.exitCode === 0, `spawning process.execPath failed: ${child.stderr}`);
  assert(child.stdout.toString().trim() === "42", "spawned process.execPath returned the wrong output");
}

console.log("windows runtime compatibility passed");
