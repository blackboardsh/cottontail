import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-native-compile-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function compiledChildEnvironment() {
  const env = { ...process.env };
  delete env.BUN_OPTIONS;
  delete env.STANDALONE_DOTENV_VALUE;
  delete env.COTTONTAIL_TEST_CLI_HEADER_PRINTED;
  delete env.COTTONTAIL_TEST_FILE_COUNT;
  delete env.COTTONTAIL_TEST_AGGREGATE_FILE;
  delete env.COTTONTAIL_TEST_REPORTER_AGGREGATE_FILE;
  // This test validates the compiled program, not bun:test's GitHub reporter.
  // A compile requested from inside the test runtime retains its mode marker;
  // prevent the nested standalone from rendering an empty CI test group.
  env.GITHUB_ACTIONS = "";
  return env;
}

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

  const run = Bun.spawnSync({
    cmd: [executable, "--version", "user-value"],
    cwd: root,
    env: compiledChildEnvironment(),
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

test("compiled builds preserve an explicit root through direct and plugin-shadow graphs", async () => {
  const project = join(root, "explicit-root");
  const sourceDir = join(project, "src");
  const assetDir = join(project, "assets");
  const entry = join(sourceDir, "entry.ts");
  mkdirSync(sourceDir, { recursive: true });
  mkdirSync(assetDir, { recursive: true });
  writeFileSync(join(assetDir, "payload.asset"), "embedded-asset");
  writeFileSync(
    entry,
    'import payload from "../assets/payload.asset";\nconsole.log(payload.replaceAll("\\\\", "/"));\n',
  );

  const relativeRoot = relative(process.cwd(), project);
  const virtualAsset = process.platform === "win32"
    ? "B:/~BUN/root/assets/payload.asset"
    : "/$bunfs/root/assets/payload.asset";

  for (const usePlugin of [false, true]) {
    const executable = join(
      root,
      process.platform === "win32"
        ? `root-${usePlugin ? "plugin" : "direct"}.exe`
        : `root-${usePlugin ? "plugin" : "direct"}`,
    );
    const result = await Bun.build({
      entrypoints: [entry],
      root: relativeRoot,
      loader: { ".asset": "file" },
      naming: { asset: "[dir]/[name].[ext]" },
      compile: { outfile: executable },
      plugins: usePlugin
        ? [{
            name: "compile-root-shadow",
            setup(build) {
              build.onLoad({ filter: /entry\.ts$/ }, args => ({
                contents: readFileSync(args.path, "utf8"),
                loader: "ts",
              }));
            },
          }]
        : undefined,
    });

    expect(result.success).toBe(true);
    const run = Bun.spawnSync({
      cmd: [executable],
      cwd: project,
      env: compiledChildEnvironment(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(run.exitCode).toBe(0);
    expect(String(run.stderr)).toBe("");
    expect(String(run.stdout).trim()).toBe(virtualAsset);
  }
}, { timeout: 120_000 });
