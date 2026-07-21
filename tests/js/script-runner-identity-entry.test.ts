import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = mkdtempSync(join(tmpdir(), "cottontail-entry-identity-"));
const runnerTemp = join(root, "runner-temp");

afterAll(() => rmSync(root, { recursive: true, force: true }));

test("transformed entries retain their original runtime identity", () => {
  const dependency = join(root, "dependency.ts");
  const entry = join(root, "entry.ts");
  writeFileSync(dependency, 'export default "identity-ok";\n');
  writeFileSync(entry, `
    import { open } from "node:fs/promises";

    const dependency = await import("./dependency.ts");
    const handle = await open(__filename, "r");
    const source = await handle.readFile("utf8");
    await handle.close();

    console.log(JSON.stringify({
      filename: __filename,
      dirname: __dirname,
      metaPath: import.meta.path,
      metaFilename: import.meta.filename,
      metaFile: import.meta.file,
      metaDir: import.meta.dir,
      metaUrl: import.meta.url,
      sourceReadable: source.includes("transformed entries retain"),
      dependency: dependency.default,
    }));
  `);

  const child = Bun.spawnSync([process.execPath, entry], {
    env: { ...process.env, COTTONTAIL_TMP_DIR: runnerTemp },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.toString();
  const stderr = child.stderr.toString();
  const entryIdentity = realpathSync(entry);
  expect({ exitCode: child.exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({
    filename: entryIdentity,
    dirname: dirname(entryIdentity),
    metaPath: entryIdentity,
    metaFilename: entryIdentity,
    metaFile: basename(entryIdentity),
    metaDir: dirname(entryIdentity),
    metaUrl: pathToFileURL(entryIdentity).href,
    sourceReadable: true,
    dependency: "identity-ok",
  });

  expect(readdirSync(root).filter(name => name.startsWith(".cottontail-compat-"))).toEqual([]);
  expect(readdirSync(join(runnerTemp, "cottontail", "run"))).toEqual([]);
});
