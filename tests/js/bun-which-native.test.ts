import { which as importedWhich } from "bun";
import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const isWindows = process.platform === "win32";
const executableSuffix = isWindows ? ".cmd" : "";

function writeExecutable(path: string) {
  writeFileSync(path, isWindows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWindows) chmodSync(path, 0o755);
}

test("Bun.which performs PATH searches natively without changing its public surface", () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-native-which-"));
  const absoluteBin = join(root, "absolute-bin");
  const relativeCwd = join(root, "relative-cwd");
  const relativeBinName = "relative-bin";
  const relativeBin = join(relativeCwd, relativeBinName);
  const unicodeBin = join(root, "工具-bin");
  const command = "cottontail-which-probe";
  const unicodeCommand = "cottontail-unicode-probe";
  const executable = join(absoluteBin, command + executableSuffix);
  const relativeExecutable = join(relativeBin, command + executableSuffix);
  const unicodeExecutable = join(unicodeBin, unicodeCommand + executableSuffix);

  mkdirSync(absoluteBin, { recursive: true });
  mkdirSync(join(relativeCwd, "child"), { recursive: true });
  mkdirSync(relativeBin, { recursive: true });
  mkdirSync(unicodeBin, { recursive: true });
  writeExecutable(executable);
  writeExecutable(relativeExecutable);
  writeExecutable(unicodeExecutable);

  try {
    expect(Bun.which.length).toBe(1);
    expect(Bun.which).toBe(importedWhich);
    expect(Bun.which(command, { PATH: absoluteBin })).toBe(executable);
    expect(Bun.which(command, { Path: absoluteBin })).toBe(executable);
    expect(Bun.which(command, { path: absoluteBin })).toBe(executable);
    expect(Bun.which("missing-command", { PATH: absoluteBin })).toBeNull();
    expect(Bun.which(unicodeCommand, { PATH: unicodeBin })).toBe(unicodeExecutable);

    expect(Bun.which(command, { PATH: relativeBinName, cwd: relativeCwd })).toBe(
      join(relativeBinName, command + executableSuffix),
    );
    expect(Bun.which(command, { PATH: `${join(root, "missing")}${delimiter}${absoluteBin}` })).toBe(
      executable,
    );
    expect(Bun.which(command, { PATH: `${delimiter}${absoluteBin}${delimiter}` })).toBe(executable);

    const getterOrder: string[] = [];
    const commandObject = {
      toString() {
        getterOrder.push("command");
        return command;
      },
    };
    const options = {
      get cwd() {
        getterOrder.push("cwd");
        return relativeCwd;
      },
      get PATH() {
        getterOrder.push("PATH");
        return relativeBinName;
      },
    };
    expect(Bun.which(commandObject as never, options)).toBe(
      join(relativeBinName, command + executableSuffix),
    );
    expect(getterOrder).toEqual(["command", "cwd", "PATH"]);

    expect(Bun.which(0 as never, { PATH: absoluteBin })).toBeNull();
    expect(Bun.which(false as never, { PATH: absoluteBin })).toBeNull();
    expect(() => Bun.which({ toString() { throw new Error("command coercion"); } } as never)).toThrow(
      "command coercion",
    );
    expect(() => Bun.which(command, {
      get cwd() {
        throw new Error("cwd getter");
      },
    })).toThrow("cwd getter");
    expect(() => Bun.which(command, {
      get PATH() {
        throw new Error("PATH getter");
      },
    })).toThrow("PATH getter");
    expect(Bun.which("😀".repeat(2048), { PATH: "" })).toBeNull();
    expect(() => Bun.which("x".repeat(4097))).toThrow("bin path is too long");
    expect(typeof (Bun as unknown as { whichSync?: unknown }).whichSync).toBe("undefined");

    const directoryCandidate = join(absoluteBin, "directory-candidate");
    mkdirSync(directoryCandidate);
    if (!isWindows) chmodSync(directoryCandidate, 0o755);
    expect(Bun.which("directory-candidate", { PATH: absoluteBin })).toBeNull();

    if (!isWindows) {
      const nonExecutable = join(absoluteBin, "not-executable");
      writeFileSync(nonExecutable, "not executable\n");
      chmodSync(nonExecutable, 0o644);
      expect(Bun.which("not-executable", { PATH: absoluteBin })).toBeNull();

      const otherExecutable = join(absoluteBin, "other-executable");
      writeFileSync(otherExecutable, "#!/bin/sh\nexit 0\n");
      chmodSync(otherExecutable, 0o001);
      expect(Bun.which("other-executable", { PATH: absoluteBin })).toBe(otherExecutable);

      const linked = join(absoluteBin, "linked-executable");
      symlinkSync(executable, linked);
      expect(Bun.which("linked-executable", { PATH: absoluteBin })).toBe(linked);

      const brokenLink = join(absoluteBin, "broken-link");
      symlinkSync(join(absoluteBin, "missing-target"), brokenLink);
      expect(Bun.which("broken-link", { PATH: absoluteBin })).toBeNull();

      const directoryLink = join(absoluteBin, "directory-link");
      symlinkSync(directoryCandidate, directoryLink);
      expect(Bun.which("directory-link", { PATH: absoluteBin })).toBeNull();

      const backslashCommand = "backslash\\command";
      writeExecutable(join(absoluteBin, backslashCommand));
      expect(Bun.which(backslashCommand, { PATH: absoluteBin, cwd: root })).toBeNull();
    } else {
      const ignoredPathextCommand = "ignored-pathext";
      writeFileSync(join(absoluteBin, `${ignoredPathextCommand}.custom`), "");
      expect(Bun.which(ignoredPathextCommand, {
        PATH: absoluteBin,
        PATHEXT: ".custom",
      } as never)).toBeNull();
    }

    const previousPath = process.env.PATH;
    process.env.PATH = absoluteBin;
    try {
      expect(Bun.which(command)).toBe(executable);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    const direct = `.${isWindows ? "\\" : "/"}${command}${executableSuffix}`;
    expect(Bun.which(direct, { cwd: absoluteBin })).toBe(
      isWindows ? `${absoluteBin}\\${direct}` : executable,
    );

    const originalCwd = process.cwd();
    process.chdir(root);
    try {
      expect(Bun.which(command, {
        cwd: "relative-cwd/child/..",
        PATH: "./relative-bin/./nested/..",
      })).toBe(join("relative-bin", command + executableSuffix));
    } finally {
      process.chdir(originalCwd);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bun.which skips empty PATH segments instead of searching cwd", () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-native-which-empty-"));
  const command = "cottontail-empty-path-probe";
  writeExecutable(join(root, command + executableSuffix));
  try {
    expect(Bun.which(command, {
      PATH: `${delimiter}${join(root, "missing")}${delimiter}`,
      cwd: root,
    })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Bun.which PATH search is safe across concurrent Workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "cottontail-native-which-workers-"));
  const command = "cottontail-worker-which-probe";
  const executable = join(root, command + executableSuffix);
  writeExecutable(executable);

  const source = [
    `const command = ${JSON.stringify(command)};`,
    `const options = { PATH: ${JSON.stringify(root)} };`,
    `const expected = ${JSON.stringify(executable)};`,
    "for (let index = 0; index < 100; index += 1) {",
    "  if (Bun.which(command, options) !== expected) throw new Error('worker which mismatch');",
    "}",
    "postMessage('ok');",
  ].join("\n");
  const workers = Array.from({ length: 4 }, () => new Worker(
    `data:text/javascript,${encodeURIComponent(source)}`,
    { type: "module" },
  ));

  try {
    const results = await Promise.all(workers.map(worker => new Promise<string>((resolve, reject) => {
      worker.onmessage = event => resolve(String(event.data));
      worker.onerror = event => reject(new Error(String(event.message ?? event)));
    })));
    expect(results).toEqual(["ok", "ok", "ok", "ok"]);
  } finally {
    for (const worker of workers) worker.terminate();
    rmSync(root, { recursive: true, force: true });
  }
});
