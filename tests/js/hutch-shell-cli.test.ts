import { afterAll, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";

const root = mkdtempSync(join(tmpdir(), "cottontail-hutch-shell-"));
const portableChild = join(import.meta.dir, "fixtures", "shell-portable-child.js");
const scriptExecutable = Bun.which("script");
const privateRoots = new Set<string>();

function snapshotTree(directory: string) {
  const snapshot: Array<[string, string, number, number, string?]> = [];
  const visit = (absolutePath: string, relativePath: string) => {
    const stat = lstatSync(absolutePath);
    const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other";
    snapshot.push([
      relativePath,
      kind,
      stat.mode & 0o777,
      stat.size,
      stat.isFile() ? readFileSync(absolutePath).toString("base64") : undefined,
    ]);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolutePath).sort()) {
        visit(join(absolutePath, name), relativePath === "." ? name : join(relativePath, name));
      }
    }
  };
  visit(directory, ".");
  return snapshot;
}

function expectPrivateStoragePermissions(directory: string) {
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      expect(stat.mode & 0o777).toBe(0o700);
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    expect(stat.isFile()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  };
  visit(directory);
}

const shellWrapperSource = String.raw`
const [command, ...args] = process.argv.slice(2);
const clearPrivateArgv = () => {
  process.argv.splice(1);
  if (Array.isArray(Bun.argv) && Bun.argv !== process.argv) Bun.argv.splice(1);
  if (Array.isArray(cottontail.argv)) cottontail.argv.splice(1);
  if (Array.isArray(cottontail.args)) cottontail.args.splice(0);
  if (Array.isArray(process.execArgv)) process.execArgv.splice(0);
  if (Array.isArray(cottontail.execArgv)) cottontail.execArgv.splice(0);
};
clearPrivateArgv();
globalThis.__cottontailLoadDotenv?.();
const hadStandaloneFlags = Object.prototype.hasOwnProperty.call(globalThis, "__cottontailStandaloneFlags");
const previousStandaloneFlags = globalThis.__cottontailStandaloneFlags;
if (previousStandaloneFlags == null) globalThis.__cottontailStandaloneFlags = {};
try {
  await globalThis.__cottontailLoadStandaloneBunfig?.();
} finally {
  if (hadStandaloneFlags) globalThis.__cottontailStandaloneFlags = previousStandaloneFlags;
  else delete globalThis.__cottontailStandaloneFlags;
}
clearPrivateArgv();
const strings = [command];
for (let index = 0; index < args.length; index++) {
  strings[strings.length - 1] += " ";
  strings.push("");
}
strings.raw = strings;
const task = Bun.$(strings, ...args).nothrow();
task.options[Symbol.for("cottontail.internal.hutchShellTask")] = {
  input: () => Bun.stdin.stream(),
  passthrough: true,
};
const result = await task;
process.exitCode = result.exitCode;
`;

const configLoaderSource = String.raw`
process.stdout.write(JSON.stringify({
  argv: process.argv,
  entry: import.meta.path,
  mode: globalThis.__cottontailHutchPrivateFileMode,
}));
`;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  for (const privateRoot of privateRoots) {
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

type PrivateFileMode = "shell" | "config";

type PrivateInvocation = {
  argv: string[];
  file: string;
  privateRoot: string;
  cleanup: () => void;
};

function createPrivateInvocation(
  mode: PrivateFileMode,
  source: string,
  args: string[] = [],
  parent = tmpdir(),
): PrivateInvocation {
  const privateRoot = mkdtempSync(join(parent, `cottontail-hutch-private-${mode}-`));
  const file = join(
    privateRoot,
    mode === "shell" ? "hutch-shell-command.mjs" : "hutch-config-loader.mjs",
  );
  privateRoots.add(privateRoot);
  writeFileSync(file, source);
  if (process.platform !== "win32") {
    chmodSync(privateRoot, 0o700);
    chmodSync(file, 0o600);
  }
  let cleaned = false;
  return {
    privateRoot,
    file,
    argv: [
      process.execPath,
      mode === "shell" ? "--hutch-shell-file" : "--hutch-config-file",
      file,
      "--hutch-private-root",
      privateRoot,
      ...args,
    ],
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      rmSync(privateRoot, { recursive: true, force: true });
      privateRoots.delete(privateRoot);
    },
  };
}

function createHutchShellInvocation(
  command: string | undefined,
  args: string[] = [],
  parent = tmpdir(),
) {
  return createPrivateInvocation(
    "shell",
    shellWrapperSource,
    command === undefined ? [] : [command, ...args],
    parent,
  );
}

function createHutchConfigInvocation(
  source = configLoaderSource,
  parent = tmpdir(),
) {
  return createPrivateInvocation("config", source, [], parent);
}

function runHutchShell(
  command: string | undefined,
  args: string[] = [],
  options: { cwd?: string; env?: Record<string, string>; stdin?: Uint8Array } = {},
) {
  const invocation = createHutchShellInvocation(command, args);
  try {
    return Bun.spawnSync(invocation.argv, {
      cwd: options.cwd ?? root,
      env: options.env == null ? process.env : { ...process.env, ...options.env },
      stdin: options.stdin,
      stdout: "pipe",
      stderr: "pipe",
    });
  } finally {
    invocation.cleanup();
  }
}

test("runs one raw Bun shell program without changing its grammar", () => {
  const child = runHutchShell(String.raw`printf 'raw|grammar\n' | cat`);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("raw|grammar\n");
  expect(child.stderr.toString()).toBe("");
});

test("appends every argument as a lossless non-syntax interpolation", () => {
  const args = [
    "",
    "spaced value",
    "single'quote",
    'double"quote',
    "$HOME",
    "semi; printf INJECTED",
    "ampersand & echo INJECTED",
    "%PATH%",
    "snowman ☃",
    "--",
  ];
  const child = runHutchShell(String.raw`printf '<%s>\n'`, args);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe(args.map(value => `<${value}>\n`).join(""));
  expect(child.stderr.toString()).toBe("");
});

test("forwards adversarial arguments byte-for-byte to an external command", () => {
  const args = [
    "",
    "spaced value",
    " leading",
    "trailing ",
    "\tactual-tab",
    "\nactual-line-feed",
    "\ractual-carriage-return",
    "single'quote",
    'double"quote',
    "back\\slash\\",
    String.raw`literal\n\b`,
    "$HOME",
    "$(printf INJECTED)",
    "`printf INJECTED`",
    "semi; printf INJECTED",
    "ampersand & echo INJECTED",
    "pipe|redirect<out>(group)",
    "glob*?[abc] brace{a,b} ~",
    "%PATH%",
    "caret^bang!",
    "\ue000private-marker-like",
    "--conditions=development",
    "--conditions",
    "browser",
    "--config",
    "./untrusted-bunfig.toml",
    "--feature",
    "feature-value",
    "--define=private.protocol:true",
    "snowman ☃",
  ];
  const command = `${$.escape(process.execPath)} ${$.escape(portableChild)} argv-json`;
  const child = runHutchShell(command, args);

  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual(args);
  expect(child.stderr.toString()).toBe("");
});

test("keeps exec and bun exec targets as opaque argv", () => {
  const marker = join(root, "exec-argument-injected.txt");
  const opaque = [
    "",
    "spaced value",
    "$HOME",
    `$(printf injected > ${marker})`,
    `; printf injected > ${marker}`,
    "backtick `printf injected`",
    "snowman ☃",
  ];
  const target = [process.execPath, portableChild, "argv-json", ...opaque];

  for (const command of ["exec", "bun exec"]) {
    const child = runHutchShell(command, target);
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual(opaque);
    expect(child.stderr.toString()).toBe("");
    expect(existsSync(marker)).toBe(false);
  }
});

test("does not expose the private command protocol as shell positional args", () => {
  const child = runHutchShell(String.raw`printf '%s|%s|%s' "$#" "$1" "$@"`);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("0||");
  expect(child.stderr.toString()).toBe("");
});

test("expands an empty shell positional vector into zero external argv entries", () => {
  const command = `${$.escape(process.execPath)} ${$.escape(portableChild)} argv-json "$@"`;
  const child = runHutchShell(command);

  expect(child.exitCode).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual([]);
  expect(child.stderr.toString()).toBe("");
});

test("runs a config loader with exactly the executable and loader argv", () => {
  const invocation = createHutchConfigInvocation();
  let child;
  try {
    child = Bun.spawnSync(invocation.argv, { cwd: root, stdout: "pipe", stderr: "pipe" });
    const observed = JSON.parse(child.stdout.toString());

    expect(child.exitCode).toBe(0);
    expect(observed.argv).toEqual([process.execPath, realpathSync(invocation.file)]);
    expect(observed.entry).toBe(realpathSync(invocation.file));
    expect(observed.mode).toBe("config");
    expect(child.stderr.toString()).toBe("");
  } finally {
    invocation.cleanup();
  }
});

test("lets the config loader alone import and serialize hutch.config.ts", () => {
  const project = join(root, "config-loader-project");
  const marker = join(project, "project-preload-ran.txt");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "HUTCH_CONFIG_DOTENV=loaded-by-dotenv\n");
  writeFileSync(join(project, "bunfig.toml"), 'preload = "./project-preload.mjs"\n');
  writeFileSync(
    join(project, "project-preload.mjs"),
    `await Bun.write(${JSON.stringify(marker)}, "ran");\n` +
      'process.env.HUTCH_CONFIG_PRELOAD = "loaded-by-preload";\n',
  );
  writeFileSync(
    join(project, "hutch.config.ts"),
    `export default {
      scripts: { verify: "printf config" },
      dotenv: process.env.HUTCH_CONFIG_DOTENV ?? null,
      preload: process.env.HUTCH_CONFIG_PRELOAD ?? null,
    };\n`,
  );
  const loader = String.raw`
const configuration = (await import(process.cwd() + "/hutch.config.ts")).default;
process.stdout.write(JSON.stringify({
  configuration,
  marker: await Bun.file(process.cwd() + "/project-preload-ran.txt").exists(),
  argv: process.argv.slice(1),
}));
`;
  const invocation = createHutchConfigInvocation(loader);
  const env = { ...process.env };
  delete env.HUTCH_CONFIG_DOTENV;
  delete env.HUTCH_CONFIG_PRELOAD;
  try {
    const child = Bun.spawnSync(invocation.argv, {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toEqual({
      configuration: {
        scripts: { verify: "printf config" },
        dotenv: null,
        preload: null,
      },
      marker: false,
      argv: [realpathSync(invocation.file)],
    });
    expect(child.stderr.toString()).toBe("");
    expect(existsSync(marker)).toBe(false);
  } finally {
    invocation.cleanup();
  }
});

test("rejects user arguments after a config loader invocation", () => {
  const invocation = createHutchConfigInvocation();
  invocation.argv.push("--untrusted-config-argument");
  try {
    const child = Bun.spawnSync(invocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain(
      "--hutch-config-file requires <absolute-file> --hutch-private-root <absolute-root>",
    );
  } finally {
    invocation.cleanup();
  }
});

test("does not auto-serve or reimport a bound private config export", () => {
  const marker = join(root, "private-config-serve-marker.txt");
  const replacement = `
await Bun.write(${JSON.stringify(marker)}, "reimported");
process.stdout.write("reimported");
export default { fetch() { return new Response("unused"); } };
`;
  const source = `
void "export default { fetch() {} }";
await Bun.write(process.argv[1], ${JSON.stringify(replacement)});
process.stdout.write("serve-shaped");
`;
  const invocation = createHutchConfigInvocation(source);
  try {
    const child = Bun.spawnSync(invocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("serve-shaped");
    expect(child.stderr.toString()).toBe("");
    expect(existsSync(marker)).toBe(false);
  } finally {
    invocation.cleanup();
  }
}, { timeout: 15_000 });

test("inherits cwd and environment while retaining pipelines and redirection", () => {
  const child = runHutchShell(
    String.raw`printf '%s' "$HUTCH_SHELL_VALUE" | cat > task-output.txt`,
    [],
    {
      cwd: root,
      env: { HUTCH_SHELL_VALUE: "environment value $ & % ☃" },
    },
  );

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("");
  expect(child.stderr.toString()).toBe("");
  expect(readFileSync(join(root, "task-output.txt"), "utf8"))
    .toBe("environment value $ & % ☃");
});

test("loads cwd dotenv and bunfig preloads only after binding the shell wrapper", () => {
  const project = join(root, "shell-project-startup");
  const observedArgv = join(project, "preload-argv.json");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "HUTCH_SHELL_DOTENV=dotenv-value\n");
  writeFileSync(join(project, "bunfig.toml"), 'preload = "./shell-preload.mjs"\n');
  writeFileSync(
    join(project, "shell-preload.mjs"),
    String.raw`
import { writeFileSync } from "node:fs";
process.env.HUTCH_SHELL_PRELOAD = "preload-value";
writeFileSync(${JSON.stringify(observedArgv)}, JSON.stringify({
  processArgv: [...process.argv],
  bunArgv: [...Bun.argv],
  cottontailArgv: [...cottontail.argv],
  cottontailArgs: [...cottontail.args],
  processExecArgv: [...process.execArgv],
  cottontailExecArgv: [...cottontail.execArgv],
}));
process.argv.push("preload-process-argv");
if (Bun.argv !== process.argv) Bun.argv.push("preload-bun-argv");
cottontail.argv.push("preload-cottontail-argv");
cottontail.args.push("preload-cottontail-args");
process.execArgv.push("--preload-process-exec-argv");
cottontail.execArgv.push("--preload-cottontail-exec-argv");
writeFileSync(process.env.HUTCH_BOUND_WRAPPER_PATH, 'throw new Error("wrapper was reopened after project preload");\n');
`,
  );
  const argvChild = `${$.escape(process.execPath)} ${$.escape(portableChild)} argv-json "$@"`;
  const invocation = createHutchShellInvocation(
    String.raw`printf '%s|%s\n' "$HUTCH_SHELL_DOTENV" "$HUTCH_SHELL_PRELOAD"; ` +
      `${argvChild}; printf ''`,
    ["opaque-startup-argument"],
  );
  let child;
  try {
    child = Bun.spawnSync(invocation.argv, {
      cwd: project,
      env: { ...process.env, HUTCH_BOUND_WRAPPER_PATH: invocation.file },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("dotenv-value|preload-value\n[]");
    expect(child.stderr.toString()).toBe("");
    expect(JSON.parse(readFileSync(observedArgv, "utf8"))).toEqual({
      processArgv: [process.execPath],
      bunArgv: [process.execPath],
      cottontailArgv: ["cottontail"],
      cottontailArgs: [],
      processExecArgv: [],
      cottontailExecArgv: [],
    });
  } finally {
    invocation.cleanup();
  }
});

for (const replacement of ["symlink", "directory"] as const) {
  test(`does not clean a ${replacement} installed at the bound private root pathname`, () => {
    const project = join(root, `post-bind-${replacement}-project`);
    const victim = join(root, `post-bind-${replacement}-victim`);
    const victimMarker = join(victim, "victim-marker.txt");
    mkdirSync(project);
    mkdirSync(victim);
    writeFileSync(victimMarker, "victim-untouched");
    writeFileSync(join(project, "bunfig.toml"), 'preload = "./replace-root-preload.mjs"\n');

    const invocation = createHutchShellInvocation("printf replacement-safe");
    const parkedRoot = `${invocation.privateRoot}-parked`;
    writeFileSync(
      join(project, "replace-root-preload.mjs"),
      replacement === "symlink"
        ? String.raw`
import { renameSync, symlinkSync } from "node:fs";
renameSync(process.env.HUTCH_TEST_PRIVATE_ROOT, process.env.HUTCH_TEST_PARKED_ROOT);
symlinkSync(process.env.HUTCH_TEST_VICTIM, process.env.HUTCH_TEST_PRIVATE_ROOT, "dir");
`
        : String.raw`
import { renameSync } from "node:fs";
renameSync(process.env.HUTCH_TEST_PRIVATE_ROOT, process.env.HUTCH_TEST_PARKED_ROOT);
renameSync(process.env.HUTCH_TEST_VICTIM, process.env.HUTCH_TEST_PRIVATE_ROOT);
`,
    );

    try {
      const child = Bun.spawnSync(invocation.argv, {
        cwd: project,
        env: {
          ...process.env,
          HUTCH_TEST_PRIVATE_ROOT: invocation.privateRoot,
          HUTCH_TEST_PARKED_ROOT: parkedRoot,
          HUTCH_TEST_VICTIM: victim,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toBe("replacement-safe");
      expect(child.stderr.toString()).toBe("");
      expect(existsSync(join(parkedRoot, "hutch-shell-command.mjs"))).toBe(true);
      if (replacement === "symlink") {
        expect(lstatSync(invocation.privateRoot).isSymbolicLink()).toBe(true);
        expect(readFileSync(victimMarker, "utf8")).toBe("victim-untouched");
      } else {
        expect(lstatSync(invocation.privateRoot).isDirectory()).toBe(true);
        expect(readFileSync(join(invocation.privateRoot, "victim-marker.txt"), "utf8"))
          .toBe("victim-untouched");
      }
    } finally {
      privateRoots.delete(invocation.privateRoot);
      try {
        const replacementStat = lstatSync(invocation.privateRoot);
        rmSync(invocation.privateRoot, {
          recursive: !replacementStat.isSymbolicLink(),
          force: true,
        });
      } catch {}
      rmSync(parkedRoot, { recursive: true, force: true });
      rmSync(victim, { recursive: true, force: true });
    }
  }, {
    skip: process.platform === "win32" ? "POSIX pathname replacement contract" : false,
  });
}

test("forwards binary stdin through the Bun shell engine", () => {
  const input = Uint8Array.from([0x00, 0x41, 0x0d, 0x0a, 0xff, 0x42]);
  const child = runHutchShell("cat", [], { stdin: input });

  expect(child.exitCode).toBe(0);
  expect(Buffer.from(child.stdout).equals(Buffer.from(input))).toBe(true);
  expect(child.stderr.toString()).toBe("");
});

for (const [name, substitution] of [
  ["dollar-paren", "$(cat)"],
  ["backtick", "`cat`"],
] as const) {
  test(`feeds inherited stdin into a top-level ${name} substitution`, () => {
    const child = runHutchShell(`printf '<%s>' "${substitution}"`, [], {
      stdin: new TextEncoder().encode("top-level-substitution\n"),
    });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("<top-level-substitution>");
    expect(child.stderr.toString()).toBe("");
  });

  test(`feeds pipeline stdin into a ${name} substitution`, () => {
    const child = runHutchShell(
      `printf 'pipeline-substitution\\n' | printf '<%s>' "${substitution}"`,
    );

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("<pipeline-substitution>");
    expect(child.stderr.toString()).toBe("");
  });
}

test("runs external commands through the Bun shell engine", () => {
  const command = `${$.escape(process.execPath)} ${$.escape(portableChild)}`;
  const child = runHutchShell(command, ["delay"]);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("complete");
  expect(child.stderr.toString()).toBe("");
});

test("preserves output order across builtins and external commands", () => {
  const external = `${$.escape(process.execPath)} ${$.escape(portableChild)} delay`;
  const child = runHutchShell(`printf before; ${external}; printf after`);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("beforecompleteafter");
  expect(child.stderr.toString()).toBe("");
});

test("applies compound redirects before descendant passthrough", () => {
  const grouped = join(root, "grouped.txt");
  const conditional = join(root, "conditional.txt");
  const child = runHutchShell(
    `{ printf grouped; } > ${$.escape(grouped)}; ` +
    `if true; then printf conditional; fi > ${$.escape(conditional)}`,
  );

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("");
  expect(child.stderr.toString()).toBe("");
  expect(readFileSync(grouped, "utf8")).toBe("grouped");
  expect(readFileSync(conditional, "utf8")).toBe("conditional");
});

test("routes compound output through pipelines", () => {
  const consumer = `${$.escape(process.execPath)} ${$.escape(portableChild)} uppercase`;
  const child = runHutchShell(`{ printf grouped; } | ${consumer}`);

  expect(child.exitCode).toBe(0);
  expect(child.stdout.toString()).toBe("GROUPED");
  expect(child.stderr.toString()).toBe("");
});

test("emits pipeline diagnostics before later command output", () => {
  const combined = join(root, "pipeline-order.txt");
  const fd = openSync(combined, "w");
  const invocation = createHutchShellInvocation(
    "definitely_missing_hutch_command | cat; printf after",
  );
  let child;
  try {
    child = Bun.spawnSync(invocation.argv, { cwd: root, stdout: fd, stderr: fd });
  } finally {
    closeSync(fd);
    invocation.cleanup();
  }

  expect(child.exitCode).toBe(0);
  expect(readFileSync(combined, "utf8")).toBe(
    "bun: command not found: definitely_missing_hutch_command\nafter",
  );
});

test("preserves merged descriptor order inside a compound command", () => {
  const combined = join(root, "compound-merged-order.txt");
  const fd = openSync(combined, "w");
  const external = `${$.escape(process.execPath)} ${$.escape(portableChild)} cross-fd-order`;
  const invocation = createHutchShellInvocation(`{ ${external}; } 2>&1`);
  let child;
  try {
    child = Bun.spawnSync(invocation.argv, { cwd: root, stdout: fd, stderr: fd });
  } finally {
    closeSync(fd);
    invocation.cleanup();
  }

  expect(child.exitCode).toBe(0);
  expect(readFileSync(combined, "utf8")).toBe("errout");
});

for (const [name, wrap] of [
  ["direct command", (source: string) => source],
  ["group", (source: string) => `{ ${source}; }`],
  ["subshell", (source: string) => `(${source})`],
] as const) {
  test(`snapshots descriptor duplication order for a ${name}`, () => {
    const external = `${$.escape(process.execPath)} ${$.escape(portableChild)} cross-fd-order`;
    const producer = wrap(external);
    const stdoutOnly = join(root, `${name.replaceAll(" ", "-")}-stdout-only.txt`);
    const merged = join(root, `${name.replaceAll(" ", "-")}-merged.txt`);

    const duplicateFirst = runHutchShell(
      `${producer} 2>&1 > ${$.escape(stdoutOnly)}`,
    );
    expect(duplicateFirst.exitCode).toBe(0);
    expect(duplicateFirst.stdout.toString()).toBe("err");
    expect(duplicateFirst.stderr.toString()).toBe("");
    expect(readFileSync(stdoutOnly, "utf8")).toBe("out");

    const redirectFirst = runHutchShell(
      `${producer} > ${$.escape(merged)} 2>&1`,
    );
    expect(redirectFirst.exitCode).toBe(0);
    expect(redirectFirst.stdout.toString()).toBe("");
    expect(redirectFirst.stderr.toString()).toBe("");
    expect(readFileSync(merged, "utf8")).toBe("errout");
  }, { timeout: 15_000 });
}

test("emits expansion diagnostics before command output on a merged descriptor", () => {
  const combined = join(root, "expansion-merged-order.txt");
  const fd = openSync(combined, "w");
  const invocation = createHutchShellInvocation(
    "{ printf out$(definitely_missing_expansion_command); } 2>&1",
  );
  let child;
  try {
    child = Bun.spawnSync(invocation.argv, { cwd: root, stdout: fd, stderr: fd });
  } finally {
    closeSync(fd);
    invocation.cleanup();
  }

  expect(child.exitCode).toBe(0);
  expect(readFileSync(combined, "utf8")).toBe(
    "bun: command not found: definitely_missing_expansion_command\nout",
  );
});

for (const compound of [false, true]) {
  test(`routes duplicated stderr through a ${compound ? "compound " : ""}pipeline`, () => {
    const external = `${$.escape(process.execPath)} ${$.escape(portableChild)} cross-fd-order`;
    const producer = compound ? `{ ${external}; }` : external;
    const consumer = `${$.escape(process.execPath)} ${$.escape(portableChild)} uppercase`;
    const child = runHutchShell(`${producer} 2>&1 | ${consumer}`);

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe("ERROUT");
    expect(child.stderr.toString()).toBe("");
  });
}

for (const variant of ["group-stderr", "subshell-stdout"] as const) {
  test(`streams the unredirected fd through an enclosing ${variant}`, async () => {
    const external = `${$.escape(process.execPath)} ${$.escape(portableChild)} stdio-dual-handshake`;
    const redirected = join(root, `${variant}.txt`);
    const shell = variant === "group-stderr"
      ? `{ ${external}; } 2> ${$.escape(redirected)}`
      : `(${external}) > ${$.escape(redirected)}`;
    const invocation = createHutchShellInvocation(shell);
    const child = Bun.spawn(invocation.argv, {
      cwd: root,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let exited = false;
    try {
      const live = variant === "group-stderr" ? child.stdout : child.stderr;
      const reader = live.getReader();
      const first = await Promise.race([
        reader.read(),
        Bun.sleep(8_000).then(() => null),
      ]);
      if (first == null) throw new Error(`${variant} buffered the unredirected descriptor`);
      expect(first.done).toBe(false);
      expect(new TextDecoder().decode(first.value)).toBe(
        variant === "group-stderr" ? "stdout-ready\n" : "stderr-ready\n",
      );

      await child.stdin.write("payload\n");
      child.stdin.end();
      let rest = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        rest += new TextDecoder().decode(chunk.value);
      }
      expect(rest).toBe(
        variant === "group-stderr" ? "stdout:payload\n" : "stderr-done\n",
      );
      expect(await child.exited).toBe(0);
      exited = true;
      expect(readFileSync(redirected, "utf8")).toBe(
        variant === "group-stderr"
          ? "stderr-ready\nstderr-done\n"
          : "stdout-ready\nstdout:payload\n",
      );
    } finally {
      if (!exited) {
        child.kill();
        await child.exited.catch(() => {});
      }
      invocation.cleanup();
    }
  }, { timeout: 15_000 });
}

test("streams external output and inherited stdin through a subshell", async () => {
  const command = `${$.escape(process.execPath)} ${$.escape(portableChild)}`;
  const invocation = createHutchShellInvocation(`(${command} stdio-handshake)`);
  const child = Bun.spawn(invocation.argv, {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  try {
    const reader = child.stdout.getReader();
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(8_000).then(() => null),
    ]);
    if (first == null) throw new Error("external task output was buffered until process exit");
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("ready\n");

    await child.stdin.write("from-stdin\n");
    child.stdin.end();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toBe("from-stdin\n");
    expect(await child.exited).toBe(0);
    exited = true;
    expect(await child.stderr.text()).toBe("");
  } finally {
    if (!exited) {
      child.kill();
      await child.exited.catch(() => {});
    }
    invocation.cleanup();
  }
}, { timeout: 15_000 });

test("streams builtin cat output before stdin closes", async () => {
  const invocation = createHutchShellInvocation("cat");
  const child = Bun.spawn(invocation.argv, {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  try {
    const reader = child.stdout.getReader();
    await child.stdin.write("first-chunk\n");
    const first = await Promise.race([
      reader.read(),
      Bun.sleep(8_000).then(() => null),
    ]);
    if (first == null) throw new Error("builtin cat buffered output until stdin closed");
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe("first-chunk\n");
    child.stdin.end();
    expect(await child.exited).toBe(0);
    exited = true;
    expect(await child.stderr.text()).toBe("");
  } finally {
    if (!exited) {
      child.kill();
      await child.exited.catch(() => {});
    }
    invocation.cleanup();
  }
}, { timeout: 15_000 });

test("stops a streaming builtin when the pipeline consumer closes", async () => {
  const invocation = createHutchShellInvocation("yes | true");
  const child = Bun.spawn(invocation.argv, {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  try {
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(8_000).then(() => null),
    ]);
    if (exitCode == null) child.kill();
    await child.exited;
    exited = true;

    expect(exitCode).toBe(0);
    expect(await child.stderr.text()).toBe("");
  } finally {
    if (!exited) {
      child.kill();
      await child.exited.catch(() => {});
    }
    invocation.cleanup();
  }
}, { timeout: 15_000 });

for (const [name, command] of [
  ["sequential", "printf ready; cat"],
  ["boolean", "false || cat"],
  ["if branch", "if true; then cat; fi"],
] as const) {
  test(`preserves inherited stdin for a later ${name} command`, () => {
    const input = new TextEncoder().encode(`${name}-input`);
    const child = runHutchShell(command, [], { stdin: input });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe(
      name === "sequential" ? `ready${name}-input` : `${name}-input`,
    );
    expect(child.stderr.toString()).toBe("");
  });
}

test("does not wait for unused inherited stdin", async () => {
  const invocation = createHutchShellInvocation("printf done");
  const child = Bun.spawn(invocation.argv, {
    cwd: root,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let exited = false;
  try {
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(8_000).then(() => null),
    ]);
    if (exitCode == null) child.kill();
    child.stdin.end();
    await child.exited;
    exited = true;

    expect(exitCode).toBe(0);
    expect(await child.stdout.text()).toBe("done");
    expect(await child.stderr.text()).toBe("");
  } finally {
    if (!exited) {
      child.kill();
      await child.exited.catch(() => {});
    }
    invocation.cleanup();
  }
}, { timeout: 15_000 });

for (const readOnly of [false, true]) {
  test(`ignores a project-local COTTONTAIL_TMP_DIR in a ${readOnly ? "read-only" : "writable"} project`, () => {
    const project = join(root, readOnly ? "read-only-project" : "writable-project");
    mkdirSync(project);
    if (readOnly && process.platform !== "win32") chmodSync(project, 0o555);
    try {
      const child = runHutchShell("printf done", [], {
        cwd: project,
        env: { COTTONTAIL_TMP_DIR: project },
      });
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toBe("done");
      expect(child.stderr.toString()).toBe("");
      expect(existsSync(join(project, ".cottontail-tmp"))).toBe(false);
      expect(existsSync(join(project, "cottontail"))).toBe(false);
    } finally {
      if (readOnly && process.platform !== "win32") chmodSync(project, 0o755);
    }
  });
}

test("keeps the exact task environment while isolating native compilation", () => {
  const overlay = join(root, "poisoned-runtime-overlay");
  const runtimeCache = join(root, "poisoned-runtime-cache");
  const inspectPreload = join(root, "poisoned-inspect-preload.mjs");
  const inspectMarker = join(root, "inspect-preload-ran.txt");
  mkdirSync(join(overlay, "internal"), { recursive: true });
  mkdirSync(runtimeCache);
  writeFileSync(
    join(overlay, "internal", "bun-shell-runtime.js"),
    'throw new Error("untrusted runtime overlay was loaded");\n',
  );
  writeFileSync(
    inspectPreload,
    `await Bun.write(${JSON.stringify(inspectMarker)}, "ran");\n`,
  );
  const values: Record<string, string> = {
    BUN_DISABLE_TRANSPILER: "1",
    NODE_ENV: "task-node-environment",
    BUN_ENV: "task-bun-environment",
    NODE_PATH: join(root, "untrusted-node-path"),
    COTTONTAIL_RUNTIME_MODULES_DIR: overlay,
    COTTONTAIL_TEST_CLI_HEADER_PRINTED: "1",
    COTTONTAIL_TEST_FILE_COUNT: "97",
    COTTONTAIL_SPAWN_EXEC_PATH: join(root, "must-not-become-exec-path"),
    COTTONTAIL_SPAWN_ARGV0: "task-spawn-argv-zero",
    COTTONTAIL_SPAWN_ROUTING: "HUTCH_ROUTED_VALUE",
    COTTONTAIL_SPAWN_TOKEN: "task-spawn-token",
    HUTCH_ROUTED_VALUE: "task-routed-value",
    COTTONTAIL_IPC_BOOTSTRAP: "bun",
    COTTONTAIL_IPC_FD: "987654",
    COTTONTAIL_IPC_SERIALIZATION: "advanced",
    COTTONTAIL_IPC_STDIO: "1",
    COTTONTAIL_IPC_PIPE: "1",
    COTTONTAIL_IPC_PEER_PID: "424242",
    BUN_INSPECT: "task-inspect-address",
    BUN_INSPECT_CONNECT_TO: "task-inspect-connect-address",
    BUN_INSPECT_NOTIFY: "task-inspect-notify-address",
    BUN_INSPECT_PRELOAD: inspectPreload,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: runtimeCache,
    BUN_TMPDIR: join(root, "task bun tmp"),
    COTTONTAIL_TMP_DIR: join(root, "task cottontail tmp"),
    TMPDIR: join(root, "task tmpdir"),
    TEMP: join(root, "task temp"),
    TMP: join(root, "task tmp"),
    HOME: join(root, "task home"),
    XDG_CACHE_HOME: join(root, "task xdg cache"),
    XDG_DATA_HOME: join(root, "task xdg data"),
    LOCALAPPDATA: join(root, "task local app data"),
  };
  const variables = Object.keys(values).map(name => `"$${name}"`).join(" ");
  const invocation = createHutchShellInvocation(String.raw`printf '<%s>\n' ` + variables);
  const runtimeRoot = join(root, "exact-environment-runtime");
  mkdirSync(runtimeRoot);
  const launcher = join(runtimeRoot, process.platform === "win32" ? "hutch.exe" : "hutch");
  linkSync(process.execPath, launcher);
  // This hardlink emulates Hutch's vendored runtime layout. Mandatory runtime
  // capabilities must travel beside the executable just as they do in a real
  // app bundle; a hardlinked binary alone is intentionally not self-contained.
  symlinkSync(
    join(dirname(process.execPath), "cottontail-stdlib"),
    join(runtimeRoot, "cottontail-stdlib"),
    process.platform === "win32" ? "junction" : "dir",
  );
  symlinkSync(
    join(dirname(process.execPath), "cottontail-core"),
    join(runtimeRoot, "cottontail-core"),
    process.platform === "win32" ? "junction" : "dir",
  );
  invocation.argv[0] = launcher;
  try {
    const child = Bun.spawnSync(invocation.argv, {
      cwd: root,
      env: { ...process.env, ...values },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toBe(
      Object.values(values).map(value => `<${value}>\n`).join(""),
    );
    expect(child.stderr.toString()).toBe("");
    expect(existsSync(inspectMarker)).toBe(false);
    expect(readdirSync(runtimeCache)).toEqual([]);
  } finally {
    invocation.cleanup();
  }
});

test("keeps project storage targets unchanged for shell preload and config loading", () => {
  const project = join(root, "project-storage-isolation");
  mkdirSync(project);
  writeFileSync(join(project, ".env"), "HUTCH_STORAGE_DOTENV=dotenv\n");
  writeFileSync(join(project, "bunfig.toml"), 'preload = "./storage-preload.mjs"\n');
  writeFileSync(
    join(project, "storage-preload.mjs"),
    'process.env.HUTCH_STORAGE_PRELOAD = "preload";\n',
  );
  writeFileSync(
    join(project, "hutch.config.ts"),
    'export default { scripts: { verify: "printf config" } };\n',
  );

  const storageNames = [
    "BUN_TMPDIR",
    "COTTONTAIL_TMP_DIR",
    "TMPDIR",
    "TEMP",
    "TMP",
    "HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "LOCALAPPDATA",
    "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
  ] as const;
  const storageEnv: Record<string, string> = {};
  const readOnlyDirectories: string[] = [];
  for (const [index, name] of storageNames.entries()) {
    const directory = join(project, `storage-${index}-${name.toLowerCase()}`);
    mkdirSync(directory);
    writeFileSync(join(directory, "seed.txt"), `seed:${name}\n`);
    storageEnv[name] = directory;
    if (process.platform !== "win32" && index % 2 === 1) {
      chmodSync(join(directory, "seed.txt"), 0o444);
      chmodSync(directory, 0o555);
      readOnlyDirectories.push(directory);
    }
  }

  const before = snapshotTree(project);
  try {
    const shell = runHutchShell(
      String.raw`printf '%s|%s' "$HUTCH_STORAGE_DOTENV" "$HUTCH_STORAGE_PRELOAD"`,
      [],
      { cwd: project, env: storageEnv },
    );
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.toString()).toBe("dotenv|preload");
    expect(shell.stderr.toString()).toBe("");
    expect(snapshotTree(project)).toEqual(before);

    const configInvocation = createHutchConfigInvocation(String.raw`
const config = (await import(process.cwd() + "/hutch.config.ts")).default;
process.stdout.write(JSON.stringify(config));
`);
    try {
      const config = Bun.spawnSync(configInvocation.argv, {
        cwd: project,
        env: { ...process.env, ...storageEnv },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(config.exitCode).toBe(0);
      expect(JSON.parse(config.stdout.toString())).toEqual({
        scripts: { verify: "printf config" },
      });
      expect(config.stderr.toString()).toBe("");
    } finally {
      configInvocation.cleanup();
    }
    expect(snapshotTree(project)).toEqual(before);
  } finally {
    for (const directory of readOnlyDirectories) {
      chmodSync(directory, 0o755);
      chmodSync(join(directory, "seed.txt"), 0o644);
    }
  }
});

test("does not load a private temp ancestor bunfig for shell or config", () => {
  const ancestor = join(root, "malicious-private-ancestor");
  const project = join(root, "ancestor-bunfig-safe-project");
  const marker = join(ancestor, "ancestor-preload-ran.txt");
  mkdirSync(ancestor);
  mkdirSync(project);
  writeFileSync(join(ancestor, "bunfig.toml"), 'preload = "./ancestor-preload.mjs"\n');
  writeFileSync(
    join(ancestor, "ancestor-preload.mjs"),
    `await Bun.write(${JSON.stringify(marker)}, "ran");\n`,
  );

  const shellInvocation = createHutchShellInvocation("printf shell", [], ancestor);
  try {
    const shell = Bun.spawnSync(shellInvocation.argv, {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shell.exitCode).toBe(0);
    expect(shell.stdout.toString()).toBe("shell");
    expect(shell.stderr.toString()).toBe("");
    expect(existsSync(marker)).toBe(false);
  } finally {
    shellInvocation.cleanup();
  }

  const configInvocation = createHutchConfigInvocation(
    'process.stdout.write("config");\n',
    ancestor,
  );
  try {
    const config = Bun.spawnSync(configInvocation.argv, {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(config.exitCode).toBe(0);
    expect(config.stdout.toString()).toBe("config");
    expect(config.stderr.toString()).toBe("");
    expect(existsSync(marker)).toBe(false);
  } finally {
    configInvocation.cleanup();
  }
});

test("preserves terminal identity for top-level external commands", () => {
  const external = `${$.escape(process.execPath)} ${$.escape(portableChild)}`;
  const invocation = createHutchShellInvocation(external, ["tty"]);
  try {
    const argv = process.platform === "darwin"
      ? [scriptExecutable!, "-q", "/dev/null", ...invocation.argv]
      : [
          scriptExecutable!,
          "-q",
          "-e",
          "-c",
          invocation.argv.map(value => $.escape(value)).join(" "),
          "/dev/null",
        ];
    const child = Bun.spawnSync(argv, { cwd: root, stdout: "pipe", stderr: "pipe" });

    expect(child.exitCode).toBe(0);
    expect(child.stdout.toString()).toContain("[true,true,true]");
  } finally {
    invocation.cleanup();
  }
}, {
  skip: process.platform === "win32" || scriptExecutable == null
    ? "requires the POSIX script utility"
    : false,
  timeout: 15_000,
});

test("preserves stdout, stderr, and a nonzero shell status", () => {
  const child = runHutchShell("printf 'stdout'; printf 'stderr' >&2; exit 23");

  expect(child.exitCode).toBe(23);
  expect(child.stdout.toString()).toBe("stdout");
  expect(child.stderr.toString()).toBe("stderr");
});

test("stops a Hutch task when the exit builtin runs", () => {
  const child = runHutchShell("printf before; exit 4; printf after");

  expect(child.exitCode).toBe(4);
  expect(child.stdout.toString()).toBe("before");
  expect(child.stderr.toString()).toBe("");
});

test("exit without an operand keeps the preceding status", () => {
  const child = runHutchShell("false; exit; printf after");

  expect(child.exitCode).toBe(1);
  expect(child.stdout.toString()).toBe("");
  expect(child.stderr.toString()).toBe("");
});

for (const [name, source, expectedError] of [
  ["invalid numeric operand", "exit nope; printf after", "exit: numeric argument required\n"],
  ["too many operands", "exit 1 2; printf after", "exit: too many arguments\n"],
] as const) {
  test(`stops after an exit with ${name}`, () => {
    const child = runHutchShell(source);

    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toBe(expectedError);
  });
}

test("fails closed before executing Windows batch commands", () => {
  const batchRoot = join(root, "windows-batch");
  const marker = join(batchRoot, "batch-ran.txt");
  const commandProcessorMarker = join(batchRoot, "command-processor-ran.txt");
  mkdirSync(batchRoot);
  const body = `@echo off\r\n>"${marker}" echo batch-ran\r\n`;
  writeFileSync(join(batchRoot, "unsafe-cmd.cmd"), body);
  writeFileSync(join(batchRoot, "unsafe-bat.bat"), body);
  writeFileSync(
    join(batchRoot, "fake-command-processor.cmd"),
    `@echo off\r\n>"${commandProcessorMarker}" echo command-processor-ran\r\n`,
  );
  const env = {
    PATH: `${batchRoot};${process.env.PATH ?? ""}`,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: join(batchRoot, "fake-command-processor.cmd"),
  };

  for (const command of ["unsafe-cmd", "unsafe-bat"]) {
    const child = runHutchShell(command, ["%PATH%", "!PATH!", "^", '" & echo INJECTED'], { env });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("Windows batch commands are unsupported in Bun.$");
    expect(child.stderr.toString()).toContain("hutch pm");
  }
  expect(existsSync(marker)).toBe(false);
  expect(existsSync(commandProcessorMarker)).toBe(false);
}, {
  skip: process.platform !== "win32" ? "Windows batch resolution contract" : false,
});

test("returns status 1 for a malformed physical shell wrapper", () => {
  const invocation = createPrivateInvocation(
    "shell",
    "export const = ;\n",
    ["printf must-not-run"],
  );
  try {
    const child = Bun.spawnSync(invocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString().length).toBeGreaterThan(0);
  } finally {
    invocation.cleanup();
  }
});

test("normalizes private native storage under a restrictive caller umask", () => {
  const shellInvocation = createHutchShellInvocation("/bin/sh -c umask");
  const configInvocation = createHutchConfigInvocation(
    `process.stdout.write(process.umask().toString(8));\n`,
  );
  try {
    for (const invocation of [shellInvocation, configInvocation]) {
      const previousUmask = process.umask(0o777);
      let child;
      try {
        child = Bun.spawnSync(invocation.argv, {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
      } finally {
        process.umask(previousUmask);
      }

      expect(child.exitCode).toBe(0);
      expect(Number.parseInt(child.stdout.toString().trim(), 8)).toBe(0o777);
      expect(child.stderr.toString()).toBe("");
      expect(readdirSync(invocation.privateRoot).some(name => name.startsWith("run-"))).toBe(true);
      expectPrivateStoragePermissions(invocation.privateRoot);
    }
  } finally {
    shellInvocation.cleanup();
    configInvocation.cleanup();
  }
}, {
  skip: process.platform === "win32" ? "POSIX umask contract" : false,
});

test("rejects macro imports before starting their marker subprocess", () => {
  const variants = [
    ["called attribute", (path: string) => `
import * as markerMacros from ${JSON.stringify(path)} with { type: "macro" };
markerMacros.default();
`],
    ["unused attribute", (path: string) => `
import * as markerMacros from ${JSON.stringify(path)} with { type: "macro" };
void markerMacros;
`],
    ["macro prefix", (path: string) => `
import * as markerMacros from ${JSON.stringify(`macro:${path}`)};
markerMacros.default();
`],
  ] as const;

  for (const [name, privateSource] of variants) {
    const marker = join(root, `private-macro-${name.replaceAll(" ", "-")}-ran.txt`);
    const macroModule = join(root, `private-macro-${name.replaceAll(" ", "-")}.mjs`);
    writeFileSync(
      macroModule,
      `Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(
        `await Bun.write(${JSON.stringify(marker)}, "ran");`,
      )}]);\nexport default () => 1;\n`,
    );
    const invocation = createPrivateInvocation("config", privateSource(macroModule));
    try {
      const child = Bun.spawnSync(invocation.argv, {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect([name, child.exitCode]).toEqual([name, 1]);
      expect(child.stdout.toString()).toBe("");
      expect(child.stderr.toString()).toContain("Macros are disabled");
      expect(existsSync(marker)).toBe(false);
    } finally {
      invocation.cleanup();
    }
  }
}, { timeout: 15_000 });

test("rejects unsafe private root and wrapper permissions", () => {
  const rootInvocation = createHutchShellInvocation("printf unreachable");
  try {
    chmodSync(rootInvocation.privateRoot, 0o755);
    const child = Bun.spawnSync(rootInvocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("HutchPrivateUnsafePermissions");
  } finally {
    rootInvocation.cleanup();
  }

  const fileInvocation = createHutchShellInvocation("printf unreachable");
  try {
    chmodSync(fileInvocation.file, 0o644);
    const child = Bun.spawnSync(fileInvocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("HutchPrivateUnsafePermissions");
  } finally {
    fileInvocation.cleanup();
  }
}, {
  skip: process.platform === "win32" ? "POSIX owner/mode contract" : false,
});

test("rejects symlinked private roots and wrapper files", () => {
  const rootInvocation = createHutchShellInvocation("printf unreachable");
  const rootLink = join(root, "private-root-link");
  symlinkSync(rootInvocation.privateRoot, rootLink, "dir");
  rootInvocation.argv[2] = join(rootLink, "hutch-shell-command.mjs");
  rootInvocation.argv[4] = rootLink;
  try {
    const child = Bun.spawnSync(rootInvocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("invalid Hutch private file");
  } finally {
    rmSync(rootLink, { force: true });
    rootInvocation.cleanup();
  }

  const fileInvocation = createHutchShellInvocation("printf unreachable");
  const target = join(root, "private-wrapper-link-target.mjs");
  writeFileSync(target, shellWrapperSource);
  chmodSync(target, 0o600);
  rmSync(fileInvocation.file);
  symlinkSync(target, fileInvocation.file);
  try {
    const child = Bun.spawnSync(fileInvocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("invalid Hutch private file");
  } finally {
    fileInvocation.cleanup();
  }
}, {
  skip: process.platform === "win32" ? "POSIX no-follow contract" : false,
});

const windowsJunctionVictim = join(root, "windows-private-root-junction-victim");
const windowsJunctionRoot = join(root, "windows-private-root-junction");
const windowsJunctionWrapper = join(windowsJunctionRoot, "hutch-shell-command.mjs");
const windowsJunctionProject = join(root, "windows-private-root-junction-project");
let windowsJunctionSkip: false | string =
  process.platform === "win32" ? false : "Windows junction/reparse contract";
if (process.platform === "win32") {
  mkdirSync(windowsJunctionVictim);
  mkdirSync(windowsJunctionProject);
  writeFileSync(join(windowsJunctionVictim, "hutch-shell-command.mjs"), shellWrapperSource);
  try {
    symlinkSync(windowsJunctionVictim, windowsJunctionRoot, "junction");
  } catch (error) {
    windowsJunctionSkip = `Windows junction creation unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

test("rejects a Windows junction used as the private root", () => {
  const marker = join(root, "windows-private-root-junction-executed.txt");
  const markerSource = `await Bun.write(${JSON.stringify(marker)}, "executed");`;
  const command = `${$.escape(process.execPath)} -e ${$.escape(markerSource)}`;
  try {
    const child = Bun.spawnSync([
      process.execPath,
      "--hutch-shell-file",
      windowsJunctionWrapper,
      "--hutch-private-root",
      windowsJunctionRoot,
      command,
    ], { cwd: windowsJunctionProject, stdout: "pipe", stderr: "pipe" });

    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("invalid Hutch private file");
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(windowsJunctionRoot, { recursive: true, force: true });
  }
}, { skip: windowsJunctionSkip });

test("rejects wrapper paths outside the private root", () => {
  const invocation = createHutchShellInvocation("printf unreachable");
  const outside = join(root, "outside-private-wrapper.mjs");
  writeFileSync(outside, shellWrapperSource);
  if (process.platform !== "win32") chmodSync(outside, 0o600);
  invocation.argv[2] = outside;
  try {
    const child = Bun.spawnSync(invocation.argv, {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("HutchPrivateFileOutsideRoot");
  } finally {
    invocation.cleanup();
  }
});

test("rejects a private root that overlaps the project cwd", () => {
  const project = join(root, "private-root-overlap-project");
  mkdirSync(project);
  const invocation = createHutchShellInvocation("printf unreachable", [], project);
  try {
    const child = Bun.spawnSync(invocation.argv, {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(child.exitCode).toBe(1);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("HutchPrivateRootOverlapsProject");
  } finally {
    invocation.cleanup();
  }
});

test("reports a missing command before normal CLI dispatch", () => {
  const child = runHutchShell(undefined);

  expect(child.exitCode).toBe(1);
  expect(child.stdout.toString()).toBe("");
  expect(child.stderr.toString()).toContain(
    "--hutch-shell-file requires <absolute-file> --hutch-private-root <absolute-root> <command> [args...]",
  );
});

test("maps a child termination signal to the Bun shell status", () => {
  const command = `${$.escape(process.execPath)} ${$.escape(portableChild)}`;
  const child = runHutchShell(command, ["self-signal"]);

  expect(child.exitCode).toBe(143);
}, {
  skip: process.platform === "win32" ? "Windows termination has no POSIX signal status" : false,
});

test("a process-group signal reaches the active command tree", async () => {
  const command = `${$.escape(process.execPath)} ${$.escape(portableChild)}`;
  const invocation = createHutchShellInvocation(command, ["signal-tree"]);
  const child = Bun.spawn(invocation.argv, {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  const childPid = child.pid;
  let signalGroupPid: number | null = null;
  let exited = false;
  try {
    if (!Number.isSafeInteger(childPid) || childPid <= 1) {
      throw new Error(`invalid detached Hutch pid: ${childPid}`);
    }
    signalGroupPid = childPid;
    const reader = child.stdout.getReader();
    const pidChunk = await Promise.race([
      reader.read(),
      Bun.sleep(8_000).then(() => null),
    ]);
    if (pidChunk == null || pidChunk.done) {
      throw new Error("active child did not report its pid");
    }
    const grandchildPid = Number(new TextDecoder().decode(pidChunk.value).trim());
    if (!Number.isSafeInteger(grandchildPid) || grandchildPid <= 1) {
      throw new Error(`invalid reported task pid: ${grandchildPid}`);
    }
    process.kill(-signalGroupPid, "SIGTERM");
    expect(await child.exited).toBe(143);
    exited = true;
    let alive = true;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        process.kill(grandchildPid, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
        break;
      }
    }
    if (alive) {
      try { process.kill(-signalGroupPid, "SIGKILL"); } catch {}
    }
    expect(alive).toBe(false);
  } finally {
    if (!exited) {
      if (signalGroupPid != null) {
        try { process.kill(-signalGroupPid, "SIGKILL"); } catch {}
      } else {
        child.kill();
      }
      await child.exited.catch(() => {});
    }
    invocation.cleanup();
  }
}, {
  skip: process.platform === "win32" ? "Windows uses process-tree termination semantics" : false,
  timeout: 15_000,
});
