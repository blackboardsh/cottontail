import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-test-cli-"));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
  return directory;
}

function run(directory: string, args: string[], env: Record<string, string | undefined> = {}) {
  const result = Bun.spawnSync([process.execPath, "test", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      AGENT: "0",
      ...env,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ...result, stderrText: String(result.stderr ?? "") };
}

test("Bun CLI validates bail and timeout before discovery", () => {
  const directory = fixture({ "sample.test.ts": `import { test } from "bun:test"; test("ok", () => {});` });
  try {
    const bail = run(directory, ["--bail=0"]);
    expect(bail.exitCode).toBe(1);
    expect(bail.stderrText).toContain("expects a number");
    const timeout = run(directory, ["--timeout", "nope"]);
    expect(timeout.exitCode).toBe(1);
    expect(timeout.stderrText).toContain("Invalid timeout");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun CLI bail stops pending tests at the requested failure count", () => {
  const directory = fixture({
    "sample.test.ts": `
      import { expect, test } from "bun:test";
      test("first", () => expect(true).toBe(false));
      test("second", () => expect(true).toBe(true));
    `,
  });
  try {
    const result = run(directory, ["--bail"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toContain("Bailed out after 1 failure");
    expect(result.stderrText).not.toContain("(pass) second");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun CLI accepts a space-separated bail limit", () => {
  const directory = fixture({
    "sample.test.ts": `
      import { expect, test } from "bun:test";
      test("first", () => expect(true).toBe(false));
      test("second", () => expect(true).toBe(false));
      test("third", () => expect(true).toBe(true));
    `,
  });
  try {
    const result = run(directory, ["--bail", "2"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toContain("Bailed out after 2 failures");
    expect(result.stderrText).not.toContain("(pass) third");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun CLI emits one GitHub Actions group per test file", () => {
  const source = `import { test } from "bun:test"; test("ok", () => {});`;
  const directory = fixture({ "first.test.ts": source, "second.test.ts": source });
  try {
    const result = run(directory, [], { GITHUB_ACTIONS: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.stderrText.match(/::group::/g)).toHaveLength(2);
    expect(result.stderrText.match(/::endgroup::/g)).toHaveLength(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun CLI groups an empty test file in GitHub Actions", () => {
  const directory = fixture({ "empty.test.ts": "" });
  try {
    const result = run(directory, [], { GITHUB_ACTIONS: "true" });
    expect(result.exitCode).toBe(0);
    expect(result.stderrText.match(/::group::/g)).toHaveLength(1);
    expect(result.stderrText.match(/::endgroup::/g)).toHaveLength(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun CLI emits GitHub Actions annotations for failures and timeouts", () => {
  const directory = fixture({
    "failure.test.ts": `
      import { test } from "bun:test";
      test("primitive", () => { throw "Oops!"; });
      test("timeout", async () => { await Bun.sleep(100); }, { timeout: 1 });
    `,
  });
  try {
    const result = run(directory, [], { GITHUB_ACTIONS: "true" });
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toMatch(/::error file=.*,line=\d+,col=\d+,title=error: Oops!::/);
    expect(result.stderrText).toContain(`::error title=error: Test "timeout" timed out after 1ms::`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Bun CLI annotates beforeEach and afterEach hook failures", () => {
  for (const hook of ["beforeEach", "afterEach"]) {
    const directory = fixture({
      "hook.test.ts": `
        import { test, ${hook} } from "bun:test";
        ${hook}(() => { throw new Error(); });
        test("test", () => {});
      `,
    });
    try {
      const result = run(directory, [], { GITHUB_ACTIONS: "true" });
      expect(result.exitCode).toBe(1);
      expect(result.stderrText).toMatch(/::error file=.*,line=\d+,col=\d+,title=error::/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("Bun CLI annotates top-level GitHub Actions errors", () => {
  const directory = fixture({ "global.test.ts": `throw new Error();` });
  try {
    const result = run(directory, [], { GITHUB_ACTIONS: "true" });
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toMatch(/::error file=.*,line=\d+,col=\d+,title=error::/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bare non-test filenames remain filters and print Bun's filepath hint", () => {
  const directory = fixture({
    "index.ts": `import { test } from "bun:test"; test("must not run", () => {});`,
  });
  try {
    const result = run(directory, ["index.ts"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderrText).toContain("bun test ./index.ts");
    expect(result.stderrText).not.toContain("must not run");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
