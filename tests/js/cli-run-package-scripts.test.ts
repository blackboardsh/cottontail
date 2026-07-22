import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const scratchRoot = process.env.COTTONTAIL_CLI_RUN_TEST_ROOT ?? join(process.cwd(), ".cottontail-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "cli-run-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(cwd: string, args: string[]) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd,
    env: {
      ...process.env,
      NO_COLOR: "1",
      PATH: join(cwd, "missing-bin"),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

test("multi-run rewrites nested package-manager commands and exposes lifecycle metadata", () => {
  const directory = join(scratch, "nested-run");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `{
      // Package scripts are loaded with Bun's JSONC rules.
      "name": "run-fixture",
      "version": "1.2.3",
      "config": { "flavor": "stock-jsc" },
      "scripts": {
        "inner": "bun probe.js",
        "outer": "npm run inner",
      },
    }`,
  );
  writeFileSync(
    join(directory, "probe.js"),
    `console.log(JSON.stringify({
      packageName: process.env.npm_package_name,
      packageVersion: process.env.npm_package_version,
      packageJson: process.env.npm_package_json,
      lifecycleEvent: process.env.npm_lifecycle_event,
      lifecycleScript: process.env.npm_lifecycle_script,
      initCwd: process.env.INIT_CWD,
      localPrefix: process.env.npm_config_local_prefix,
      userAgent: process.env.npm_config_user_agent,
      configFlavor: process.env.npm_package_config_flavor,
      bun: process.env.BUN,
      execPath: process.execPath,
    }));\n`,
  );

  const result = run(directory, ["run", "--parallel", "outer"]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  const outputLine = result.stdout.split(/\r?\n/).find(line => line.includes('"packageName"'));
  expect(outputLine).toBeDefined();
  const metadata = JSON.parse(outputLine!.slice(outputLine!.indexOf("{")));
  const realDirectory = realpathSync(directory);
  expect(metadata).toMatchObject({
    packageName: "run-fixture",
    packageVersion: "1.2.3",
    packageJson: join(realDirectory, "package.json"),
    lifecycleEvent: "inner",
    lifecycleScript: "bun probe.js",
    initCwd: realDirectory,
    localPrefix: realDirectory,
    configFlavor: "stock-jsc",
  });
  expect(metadata.userAgent).toStartWith("bun/1.3.10 ");
  expect(metadata.bun).toBe(metadata.execPath);
  expect(result.stderr).toMatch(/^outer\s+\| Done/m);
});

test("workspace multi-run honors JSONC patterns and sorts packages by name", () => {
  const directory = join(scratch, "workspace-order");
  const firstByPath = join(directory, "packages", "a-dir");
  const firstByName = join(directory, "packages", "z-dir");
  const ignored = join(directory, "ignored");
  mkdirSync(firstByPath, { recursive: true });
  mkdirSync(firstByName, { recursive: true });
  mkdirSync(ignored, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `{
      // This package must not make the workspace parser fall back to a tree walk.
      "private": true,
      "workspaces": ["packages/*",],
    }`,
  );

  for (const [packageDirectory, name] of [
    [firstByPath, "omega"],
    [firstByName, "alpha"],
    [ignored, "ignored"],
  ] as const) {
    writeFileSync(
      join(packageDirectory, "package.json"),
      JSON.stringify({ name, scripts: { order: "bun probe.js" } }),
    );
    writeFileSync(join(packageDirectory, "probe.js"), "console.log(process.env.npm_package_name);\n");
  }

  const result = run(directory, ["run", "--sequential", "--filter", "*", "order"]);
  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  const alpha = result.stdout.indexOf("alpha:order | alpha");
  const omega = result.stdout.indexOf("omega:order | omega");
  expect(alpha).toBeGreaterThanOrEqual(0);
  expect(omega).toBeGreaterThan(alpha);
  expect(result.stdout).not.toContain("ignored");
});
