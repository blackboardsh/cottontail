import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-native-compile-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("Bun.build compiles in-process with standalone metadata and embedded assets", async () => {
  const entry = join(root, "entry.ts");
  const executable = join(root, process.platform === "win32" ? "native-compile.exe" : "native-compile");
  writeFileSync(join(root, "message.txt"), "embedded graph asset");
  writeFileSync(join(root, ".env"), "STANDALONE_DOTENV_VALUE=should-not-load\n");
  writeFileSync(
    entry,
    `import message from "./message.txt";
console.log(JSON.stringify({
  message,
  argv0: process.argv[0],
  entrypoint: process.argv[1],
  argv: process.argv.slice(2),
  execArgv: process.execArgv,
  execPath: process.execPath,
  title: process.title,
  dotenv: process.env.STANDALONE_DOTENV_VALUE ?? null,
  flags: globalThis.__cottontailStandaloneFlags,
}));
`,
  );

  const originalExecPath = process.execPath;
  let result;
  try {
    // The former implementation spawned process.execPath to report success.
    // A native compile must not depend on this mutable JavaScript property.
    process.execPath = join(root, "missing-cottontail");
    result = await Bun.build({
      entrypoints: [entry],
      sourcemap: "external",
      compile: {
        outfile: executable,
        executablePath: originalExecPath,
        execArgv: ["--console-depth=4", "--title=compiled-title"],
        autoloadDotenv: false,
        autoloadBunfig: false,
      },
    });
  } finally {
    process.execPath = originalExecPath;
  }

  expect(result.success).toBe(true);
  expect(result.outputs.map(output => output.kind)).toEqual(["entry-point", "sourcemap"]);
  expect(result.outputs[0].path).toBe(executable);
  expect(result.outputs[0].sourcemap).toBe(result.outputs[1]);
  expect(JSON.parse(readFileSync(`${executable}.map`, "utf8")).version).toBe(3);

  const env = { ...process.env };
  delete env.BUN_OPTIONS;
  delete env.STANDALONE_DOTENV_VALUE;
  const run = Bun.spawnSync({
    cmd: [executable, "--version", "user-value"],
    cwd: root,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
  expect(String(run.stderr)).toBe("");
  expect(JSON.parse(String(run.stdout))).toEqual({
    message: "embedded graph asset",
    argv0: "bun",
    entrypoint: process.platform === "win32" ? "B:/~BUN/root/index.js" : "/$bunfs/root/index.js",
    argv: ["--version", "user-value"],
    execArgv: ["--console-depth=4", "--title=compiled-title"],
    execPath: realpathSync(executable),
    title: "compiled-title",
    dotenv: null,
    flags: {
      disableDefaultEnvFiles: true,
      disableAutoloadBunfig: true,
      disableAutoloadTsconfig: true,
      disableAutoloadPackageJson: true,
    },
  });
});
