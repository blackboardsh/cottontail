import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test.skipIf(process.platform !== "win32")("Bun.build applies Windows metadata and GUI subsystem", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cottontail-windows-metadata-"));
  using cleanup = { [Symbol.dispose]: () => rmSync(directory, { recursive: true, force: true }) };
  const entrypoint = join(directory, "app.js");
  const outfile = join(directory, "metadata-app.exe");
  writeFileSync(entrypoint, 'console.log("metadata app");\n');

  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: {
      outfile,
      windows: {
        hideConsole: true,
        title: "Cottontail Metadata Test",
        publisher: "Cottontail",
        version: "7.6.5.4",
        description: "Windows metadata compatibility",
        copyright: "Copyright © Cottontail",
      },
    },
  });

  expect(result.success).toBe(true);
  expect(result.outputs).toHaveLength(1);
  expect(result.outputs[0].path).toBe(outfile);

  const executable = readFileSync(outfile);
  const peHeaderOffset = executable.readUInt32LE(0x3c);
  expect(executable.readUInt16LE(peHeaderOffset + 0x5c)).toBe(2);

  const metadata = JSON.parse(execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);" +
        "$value=(Get-Item -LiteralPath $env:COTTONTAIL_METADATA_EXE).VersionInfo;" +
        "[ordered]@{title=$value.ProductName;publisher=$value.CompanyName;" +
        "version=$value.ProductVersion;description=$value.FileDescription;" +
        "copyright=$value.LegalCopyright}|ConvertTo-Json -Compress",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, COTTONTAIL_METADATA_EXE: outfile },
    },
  ));
  expect(metadata).toEqual({
    title: "Cottontail Metadata Test",
    publisher: "Cottontail",
    version: "7.6.5.4",
    description: "Windows metadata compatibility",
    copyright: "Copyright © Cottontail",
  });
});

test("Bun.build validates compile.windows", () => {
  expect(() => Bun.build({
    entrypoints: [import.meta.path],
    compile: { windows: "invalid" as any },
  })).toThrow("compile.windows must be an object");

  expect(() => Bun.build({
    entrypoints: [import.meta.path],
    compile: { windows: { version: 123 as any } },
  })).toThrow("compile.windows.version must be a string");
});
