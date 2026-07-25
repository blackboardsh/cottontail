import { $ } from "bun";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function environmentWithPath(path: string) {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH")),
    PATH: path,
  };
}

const tempDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tempDir, "COTTONTAIL_TMP_DIR missing");

if (cottontail.platform() === "win32") {
  const root = join(tempDir, "bun-which-windows-extension");
  const command = "cottontail-which-probe";
  const executable = join(root, `${command}.exe`);
  const slashCommand = "cottontail-slash-probe";
  const slashExecutable = join(root, `${slashCommand}.cmd`);
  const pathBin = join(root, "path-bin");
  const shellCwd = join(root, "shell-cwd");
  const shellCommand = "cottontail-shell-path-probe";
  const shellExecutable = join(pathBin, `${shellCommand}.cmd`);
  const batchCmdCommand = "cottontail-batch-cmd-probe";
  const batchBatCommand = "cottontail-batch-bat-probe";
  const unicodeCwd = join(root, "工作 目录-开始-🚀");
  const relativeUnicodeBin = "工具-bin";
  const unicodeBin = join(unicodeCwd, relativeUnicodeBin);
  const unicodeCommand = "cottontail-unicode-path-probe";
  const unicodeExecutable = join(unicodeBin, `${unicodeCommand}.cmd`);

  rmSync(root, { recursive: true, force: true });
  mkdirSync(pathBin, { recursive: true });
  mkdirSync(shellCwd, { recursive: true });
  mkdirSync(unicodeBin, { recursive: true });
  try {
    writeFileSync(executable, "");
    writeFileSync(slashExecutable, "@echo slash-path-ok\r\n");
    writeFileSync(shellExecutable, "@echo path-only-ok\r\n");
    writeFileSync(join(shellCwd, `${shellCommand}.cmd`), "@echo implicit-cwd-bug\r\n");
    writeFileSync(
      join(pathBin, `${batchCmdCommand}.cmd`),
      "@echo off\r\n@echo %~1^|%~2\r\n@exit /b 0\r\n",
    );
    writeFileSync(
      join(pathBin, `${batchBatCommand}.bat`),
      "@echo off\r\n@echo %~1^|%~2\r\n@exit /b 7\r\n",
    );
    writeFileSync(unicodeExecutable, "@echo unicode-path-ok\r\n");
    const expected = realpathSync(executable).replaceAll("/", "\\").toLowerCase();
    const explicitExtension = Bun.which(`${command}.exe`, { PATH: root });
    const inferredExtension = Bun.which(command, { PATH: root });

    assert(
      inferredExtension?.replaceAll("/", "\\").toLowerCase() === expected,
      `Bun.which extensionless lookup mismatch: ${String(inferredExtension)}`,
    );
    assert(
      explicitExtension?.replaceAll("/", "\\").toLowerCase() === expected,
      `Bun.which extension-present lookup mismatch: ${String(explicitExtension)}`,
    );

    const systemRoot = process.env.SystemRoot;
    assert(systemRoot, "SystemRoot missing");
    const canonicalSystemRoot = realpathSync(systemRoot);
    assert(
      Bun.which("cmd.exe", { PATH: join(systemRoot.toUpperCase(), "system32") }) ===
        join(canonicalSystemRoot, "system32", "cmd.exe"),
      "Bun.which did not preserve the filesystem spelling of the Windows directory",
    );

    assert(
      Bun.which(join(root, slashCommand)) === slashExecutable,
      "Bun.which did not infer .cmd for an absolute slash path",
    );
    assert(
      Bun.which(`.\\${slashCommand}`, { cwd: root }) === `${root}\\.\\${slashCommand}.cmd`,
      "Bun.which did not preserve a relative backslash path against options.cwd",
    );
    const forwardSlashExecutable = join(root, slashCommand).replaceAll("\\", "/");
    assert(
      Bun.which(forwardSlashExecutable) === `${forwardSlashExecutable}.cmd`,
      "Bun.which did not preserve an absolute path's slash spelling",
    );

    const originalCwd = process.cwd();
    try {
      process.chdir(root);
      assert(
        Bun.which(`./${slashCommand}`) === slashExecutable,
        "Bun.which did not resolve a slash path against process.cwd()",
      );
    } finally {
      process.chdir(originalCwd);
    }

    assert(
      Bun.which(shellCommand, { PATH: pathBin }) === shellExecutable,
      "Bun.which did not find a .cmd command on PATH",
    );
    assert(
      Bun.which(shellCommand, { PATH: join(root, "missing-path") }) === null,
      "Bun.which implicitly searched the current directory",
    );

    const pathResult = await $`${{ raw: shellCommand }}`
      .cwd(shellCwd)
      .env(environmentWithPath(pathBin))
      .quiet()
      .nothrow();
    assert(pathResult.exitCode === 0, `Bun shell PATH command failed: ${pathResult.stderr}`);
    assert(pathResult.text().trim() === "path-only-ok", "Bun shell did not execute the PATH command");

    const batchCmdResult = await $`${{ raw: batchCmdCommand }} ${"hello world"} ${"second value"}`
      .cwd(shellCwd)
      .env(environmentWithPath(pathBin))
      .quiet()
      .nothrow();
    assert(batchCmdResult.exitCode === 0, `Bun shell .cmd mediation failed: ${batchCmdResult.stderr}`);
    assert(
      batchCmdResult.text().trim() === "hello world|second value",
      `Bun shell .cmd argument quoting mismatch: ${batchCmdResult.text()}`,
    );

    const batchBatResult = await $`${{ raw: batchBatCommand }} ${"hello world"} ${"second value"}`
      .cwd(shellCwd)
      .env(environmentWithPath(pathBin))
      .quiet()
      .nothrow();
    assert(batchBatResult.exitCode === 7, `Bun shell .bat exit code mismatch: ${batchBatResult.exitCode}`);
    assert(
      batchBatResult.text().trim() === "hello world|second value",
      `Bun shell .bat argument quoting mismatch: ${batchBatResult.text()}`,
    );

    assert(
      Bun.which(unicodeCommand, { PATH: unicodeBin }) === unicodeExecutable,
      "Bun.which did not find a command in a non-ASCII PATH directory",
    );
    assert(
      Bun.which(unicodeCommand, { PATH: relativeUnicodeBin, cwd: unicodeCwd }) ===
        join(relativeUnicodeBin, `${unicodeCommand}.cmd`),
      "Bun.which did not resolve a relative PATH entry against options.cwd",
    );

    const unicodeAbsoluteResult = await $`${{ raw: unicodeCommand }}`
      .cwd(unicodeCwd)
      .env(environmentWithPath(unicodeBin))
      .quiet()
      .nothrow();
    assert(unicodeAbsoluteResult.exitCode === 0, `Bun shell non-ASCII PATH failed: ${unicodeAbsoluteResult.stderr}`);
    assert(unicodeAbsoluteResult.text().trim() === "unicode-path-ok", "Bun shell non-ASCII PATH output mismatch");

    const unicodeRelativeResult = await $`${{ raw: unicodeCommand }}`
      .cwd(unicodeCwd)
      .env(environmentWithPath(relativeUnicodeBin))
      .quiet()
      .nothrow();
    assert(unicodeRelativeResult.exitCode === 0, `Bun shell relative PATH failed: ${unicodeRelativeResult.stderr}`);
    assert(unicodeRelativeResult.text().trim() === "unicode-path-ok", "Bun shell relative PATH output mismatch");

    const implicitCwdResult = await $`${{ raw: shellCommand }}`
      .cwd(shellCwd)
      .env(environmentWithPath(join(root, "missing-path")))
      .quiet()
      .nothrow();
    assert(implicitCwdResult.exitCode !== 0, "Bun shell implicitly executed a command from cwd");
    assert(!implicitCwdResult.text().includes("implicit-cwd-bug"), "Bun shell ran the cwd command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("bun which windows extension passed");
