import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "cottontail-startup-cache-"));
const project = join(root, "project");
const cacheRoot = join(root, "cache-root");
const cacheDirectory = join(cacheRoot, "cottontail", "cache");
const defaultCacheHome = join(root, "cache-home");
const defaultCacheDirectory = join(defaultCacheHome, ".cache", "cottontail", "cache");

mkdirSync(project, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

function runCommand(args: string[], cwd = project, defaultCache = false, argv0?: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, ...args],
    cwd,
    env: {
      ...process.env,
      COTTONTAIL_TMP_DIR: defaultCache ? "" : cacheRoot,
      HOME: defaultCache ? defaultCacheHome : process.env.HOME,
      LOCALAPPDATA: defaultCache ? "" : process.env.LOCALAPPDATA,
      XDG_CACHE_HOME: defaultCache ? "" : process.env.XDG_CACHE_HOME,
    },
    argv0,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function run(entry: string, argv0?: string) {
  return runCommand([entry], project, false, argv0);
}

function artifactNames(directory = cacheDirectory) {
  return readdirSync(directory).filter(name => name.endsWith(".mjs")).sort();
}

test("runtime module launcher is reused while entry sources stay live", async () => {
  const dependency = join(project, "dependency.mjs");
  const entry = join(project, "entry.mjs");
  writeFileSync(dependency, [
    'export let value = "one";',
    "await Promise.resolve();",
    'value += "-tla";',
    "",
  ].join("\n"));
  writeFileSync(entry, [
    'import { value } from "./dependency.mjs";',
    'const namespace = await import("./dependency.mjs");',
    'if (!value.endsWith("-tla") || namespace.value !== value) throw new Error("module identity");',
    'if (await import("bun") !== Bun) throw new Error("bun identity");',
    "console.log(value);",
    "",
  ].join("\n"));

  const first = run(entry);
  expect(first.exitCode).toBe(0);
  expect(first.stdout.toString()).toBe("one-tla\n");
  expect(first.stderr.toString()).toBe("");

  const manifestPath = join(cacheDirectory, "module-runtime.manifest");
  expect(existsSync(manifestPath)).toBe(true);
  expect(readFileSync(manifestPath).subarray(0, 8).toString()).toBe("CTLCACH3");
  const firstManifestMtime = statSync(manifestPath).mtimeMs;
  const firstArtifacts = artifactNames();
  expect(firstArtifacts.length).toBe(1);

  await Bun.sleep(25);
  const second = run(entry, "caller-controlled-argv0");
  expect(second.exitCode).toBe(0);
  expect(second.stdout.toString()).toBe("one-tla\n");
  expect(second.stderr.toString()).toBe("");
  expect(artifactNames()).toEqual(firstArtifacts);
  expect(statSync(manifestPath).mtimeMs).toBe(firstManifestMtime);

  await Bun.sleep(25);
  const artifactPath = join(cacheDirectory, firstArtifacts[0]);
  const originalArtifact = readFileSync(artifactPath);
  writeFileSync(artifactPath, Buffer.alloc(originalArtifact.length, 0x20));
  const repaired = run(entry, "different-caller-argv0");
  expect(repaired.exitCode).toBe(0);
  expect(repaired.stdout.toString()).toBe("one-tla\n");
  expect(repaired.stderr.toString()).toBe("");
  const repairedArtifacts = artifactNames();
  expect(repairedArtifacts.length).toBe(1);
  expect(readFileSync(join(cacheDirectory, repairedArtifacts[0]))).not.toEqual(
    Buffer.alloc(originalArtifact.length, 0x20),
  );
  const repairedManifestMtime = statSync(manifestPath).mtimeMs;
  expect(repairedManifestMtime).toBeGreaterThan(firstManifestMtime);

  await Bun.sleep(25);
  writeFileSync(manifestPath, "corrupt manifest");
  const recovered = run(entry);
  expect(recovered.exitCode).toBe(0);
  expect(recovered.stdout.toString()).toBe("one-tla\n");
  expect(recovered.stderr.toString()).toBe("");
  expect(readFileSync(manifestPath).subarray(0, 8).toString()).toBe("CTLCACH3");
  const recoveredArtifacts = artifactNames();
  expect(recoveredArtifacts.length).toBe(1);
  const recoveredManifestMtime = statSync(manifestPath).mtimeMs;

  await Bun.sleep(25);
  writeFileSync(dependency, [
    'export let value = "two";',
    "await Promise.resolve();",
    'value += "-tla";',
    "",
  ].join("\n"));
  const invalidated = run(entry);
  expect(invalidated.exitCode).toBe(0);
  expect(invalidated.stdout.toString()).toBe("two-tla\n");
  expect(invalidated.stderr.toString()).toBe("");
  expect(artifactNames()).toEqual(recoveredArtifacts);
  expect(statSync(manifestPath).mtimeMs).toBe(recoveredManifestMtime);
}, 60_000);

test("shared runtime launcher stays reusable while an entry is running", async () => {
  const dependency = join(project, "leased-dependency.mjs");
  const entry = join(project, "leased-entry.mjs");
  const ready = join(project, "leased-entry.ready");
  const baselineArtifacts = artifactNames().length;
  writeFileSync(dependency, 'export const value = "leased-one";\n');
  writeFileSync(entry, [
    'import { writeFileSync } from "node:fs";',
    'import { value } from "./leased-dependency.mjs";',
    `writeFileSync(${JSON.stringify(ready)}, "ready");`,
    "console.log(value);",
    'if (process.env.COTTONTAIL_LEASE_HOLD === "1") await Bun.sleep(30_000);',
    "",
  ].join("\n"));

  const child = Bun.spawn({
    cmd: [process.execPath, entry],
    cwd: project,
    env: { ...process.env, COTTONTAIL_TMP_DIR: cacheRoot, COTTONTAIL_LEASE_HOLD: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    expect(artifactNames().length).toBe(baselineArtifacts);

    writeFileSync(dependency, 'export const value = "leased-two";\n');
    const replacement = run(entry);
    expect(replacement.exitCode).toBe(0);
    expect(replacement.stdout.toString()).toBe("leased-two\n");
    expect(replacement.stderr.toString()).toBe("");
    expect(artifactNames().length).toBe(baselineArtifacts);

    child.kill();
    await child.exited;
    expect(await new Response(child.stdout).text()).toBe("leased-one\n");
    expect(await new Response(child.stderr).text()).toBe("");

    const cleaned = run(entry);
    expect(cleaned.exitCode).toBe(0);
    expect(cleaned.stdout.toString()).toBe("leased-two\n");
    expect(cleaned.stderr.toString()).toBe("");
    expect(artifactNames().length).toBe(baselineArtifacts);
  } finally {
    child.kill();
  }
}, 30_000);

test("cached runtime artifact stacks retain original source locations", () => {
  const entry = join(project, "cached-stack.mjs");
  writeFileSync(entry, [
    "await Promise.resolve();",
    'const marker = "cached-source-map";',
    "throw new Error(marker);",
    "",
  ].join("\n"));

  const first = run(entry);
  expect(first.exitCode).not.toBe(0);

  const cached = run(entry);
  const stderr = cached.stderr.toString();
  expect(cached.exitCode).not.toBe(0);
  expect(stderr).toContain("cached-source-map");
  expect(stderr).toContain(`${entry}:3`);
});

test("plain CommonJS entries and eval share one dynamic runtime artifact", async () => {
  const dependency = join(project, "commonjs-dependency.cjs");
  const firstEntry = join(project, "commonjs-first.cjs");
  const secondProject = join(root, "second-project");
  const secondDependency = join(secondProject, "commonjs-dependency.cjs");
  const secondEntry = join(secondProject, "commonjs-second.cjs");
  mkdirSync(secondProject, { recursive: true });
  writeFileSync(dependency, 'module.exports = { value: "one" };\n');
  const entrySource = [
    'const dependency = require("./commonjs-dependency.cjs");',
    'if (require("./commonjs-dependency.cjs") !== dependency) throw new Error("cache identity");',
    'if (require.main !== module) throw new Error("require.main identity");',
    "console.log(dependency.value);",
    "",
  ].join("\n");
  writeFileSync(firstEntry, entrySource);
  writeFileSync(secondEntry, entrySource);
  writeFileSync(secondDependency, 'module.exports = { value: "two" };\n');

  const first = runCommand([firstEntry], project, true);
  expect(first.exitCode).toBe(0);
  expect(first.stdout.toString()).toBe("one\n");

  const runtimeArtifacts = artifactNames(defaultCacheDirectory).filter(name => name.startsWith("commonjs-runtime-"));
  expect(runtimeArtifacts.length).toBe(1);
  const manifestPath = join(defaultCacheDirectory, "commonjs-runtime.manifest");
  const manifestMtime = statSync(manifestPath).mtimeMs;

  await Bun.sleep(25);
  const second = runCommand([secondEntry], secondProject, true);
  expect(second.exitCode).toBe(0);
  expect(second.stdout.toString()).toBe("two\n");
  expect(artifactNames(defaultCacheDirectory).filter(name => name.startsWith("commonjs-runtime-"))).toEqual(runtimeArtifacts);
  expect(statSync(manifestPath).mtimeMs).toBe(manifestMtime);

  const evaluated = runCommand(["-e", 'console.log("eval-runtime")'], secondProject, true);
  expect(evaluated.exitCode).toBe(0);
  expect(evaluated.stdout.toString()).toBe("eval-runtime\n");
  expect(artifactNames(defaultCacheDirectory).filter(name => name.startsWith("commonjs-runtime-"))).toEqual(runtimeArtifacts);
}, 30_000);
