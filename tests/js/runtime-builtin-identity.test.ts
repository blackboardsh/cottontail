import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const inspectionSource = readFileSync(join(import.meta.dir, "fixtures/runtime-builtin-identity.js"), "utf8");

for (const mode of ["static-first", "dynamic-first", "all-static"]) {
  test(`builtin identity survives embedded dependencies with ${mode} loading`, () => {
    const directory = mkdtempSync(join(tmpdir(), "cottontail-builtin-identity-"));
    try {
      const fixtureFile = join(directory, "input.txt");
      const workerPath = join(directory, "worker.mjs");
      const entryPath = join(directory, "main.mjs");
      writeFileSync(fixtureFile, "stream-preload-cycle");
      const prefix = mode === "dynamic-first"
        ? 'require(["node", "fs"].join(":"));\nconst StaticStream = await import(["node", "stream"].join(":"));\n'
        : 'import * as StaticStream from "node:stream";\n' + (mode === "all-static" ? [
          'import * as StaticFs from "node:fs";',
          'import * as StaticCrypto from "node:crypto";',
          'import * as StaticChildProcess from "node:child_process";',
          '',
        ].join("\n") : "");
      const source = prefix + `const fixtureFile = ${JSON.stringify(fixtureFile)};\n` + inspectionSource;
      writeFileSync(workerPath, source + "\npostMessage(await inspectStreamIdentity());\n");
      writeFileSync(entryPath, source + `
        if (!process.versions.cottontail) throw new Error("This regression must execute Cottontail");
        const main = await inspectStreamIdentity();
        const worker = new Worker(${JSON.stringify(workerPath)}, { type: "module" });
        let timer;
        try {
          const child = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Builtin identity worker timed out")), 15_000);
            worker.onmessage = event => resolve(event.data);
            worker.onerror = event => reject(new Error(String(event.message ?? event)));
          });
          console.log(JSON.stringify({ main, worker: child }));
        } finally { clearTimeout(timer); worker.terminate(); }
      `);
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(JSC_|COTTONTAIL_|DASH_|ELECTROBUN_)/.test(key)) delete env[key];
      }
      if (process.env.COTTONTAIL_RUNTIME_MODULES_DIR) {
        env.COTTONTAIL_RUNTIME_MODULES_DIR = process.env.COTTONTAIL_RUNTIME_MODULES_DIR;
      }
      env.COTTONTAIL_TMP_DIR = join(directory, "runtime-cache");
      const child = Bun.spawnSync({
        cmd: [process.execPath, "--smol", entryPath],
        cwd: directory, env, stdout: "pipe", stderr: "pipe", timeout: 60_000,
      });
      const stderr = new TextDecoder().decode(child.stderr);
      if (child.exitCode !== 0) throw new Error(`Builtin identity regression failed: ${stderr}`);
      expect(stderr).toBe("");
      const result = JSON.parse(new TextDecoder().decode(child.stdout).trim());
      for (const [name, value] of Object.entries(result) as [string, any][]) {
        expect(value.isMainThread).toBe(name === "main");
        expect(value.stages).toEqual(["initial", "after-fs", "after-child-process"].map(stage => ({
          stage, classIdentity: true, functionIdentity: true, defaultIdentity: true, plainAliasIdentity: true,
        })));
        expect(value.cycle).toEqual({
          fsPromisesIdentity: true, fsNamespaceDefault: true, fsReadStreamBase: true,
          fsWriteStreamBase: true, readThroughCycle: true,
        });
        expect(value.dependent).toEqual({
          childIdentity: true, childNamespaceDefault: true, netSocketBase: true,
        });
        expect(value.builtins).toEqual(mode === "all-static" ? ["node:fs", "node:crypto", "node:child_process"].map(specifier => ({
          specifier, namedIdentity: true, namespaceDefault: true,
        })) : []);
        expect(value.mutability).toEqual({
          fsGetterOnly: true, fsAssignmentRejected: true, cryptoAssignmentAccepted: true,
          cryptoDynamicSeesAssignment: true, cryptoAliasIdentity: true, restored: true,
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 65_000);
}
