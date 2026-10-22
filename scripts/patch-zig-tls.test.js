import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { patchZigTls, tlsPatch } from "./patch-zig-tls.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function withSources(action) {
  const temporary = await mkdtemp(path.join(tmpdir(), "cottontail-zig-policy-"));
  const pristine = new Map();
  try {
    for (const file of tlsPatch.files) {
      let source = (await readFile(path.join(root, "vendors/zig", file.path), "utf8")).replace(/\r\n/g, "\n");
      if (sha256(source) === file.patchedSha256) {
        for (const edit of [...file.edits].reverse()) {
          assert.equal(source.split(edit.after).length, 2);
          source = source.replace(edit.after, edit.before);
        }
      }
      assert.equal(sha256(source), file.pristineSha256);
      pristine.set(file.path, source);
      const target = path.join(temporary, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, source);
    }
    await action(temporary, pristine);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

test("Zig TLS patch is authenticated, repeatable and recognizes missing policy", async () => {
  await withSources(async temporary => {
    await assert.rejects(patchZigTls(temporary, { checkOnly: true }), /security patch missing/);
    assert.deepEqual(await patchZigTls(temporary), { changed: true });
    for (const file of tlsPatch.files) {
      assert.equal(sha256(await readFile(path.join(temporary, file.path))), file.patchedSha256);
    }
    assert.deepEqual(await patchZigTls(temporary), { changed: false });
    assert.deepEqual(await patchZigTls(temporary, { checkOnly: true }), { changed: false });
  });
});

test("unknown Zig sources fail before any standard library file is modified", async () => {
  await withSources(async (temporary, pristine) => {
    const last = tlsPatch.files.at(-1);
    await writeFile(path.join(temporary, last.path), pristine.get(last.path) + "// local modification\n");
    await assert.rejects(patchZigTls(temporary), /Zig TLS source drift/);
    for (const file of tlsPatch.files.slice(0, -1)) {
      assert.equal(await readFile(path.join(temporary, file.path), "utf8"), pristine.get(file.path));
    }
  });
});

test("interrupted patches and Windows line endings safely converge on the pinned policy", async () => {
  await withSources(async (temporary, pristine) => {
    await patchZigTls(temporary);
    const last = tlsPatch.files.at(-1);
    await writeFile(path.join(temporary, last.path), pristine.get(last.path).replace(/\n/g, "\r\n"));
    assert.deepEqual(await patchZigTls(temporary), { changed: true });
    for (const file of tlsPatch.files) {
      assert.equal(sha256(await readFile(path.join(temporary, file.path))), file.patchedSha256);
    }
  });
});

test("policy checking never rewrites CRLF source files", async () => {
  await withSources(async temporary => {
    await patchZigTls(temporary);
    const file = tlsPatch.files[0];
    const target = path.join(temporary, file.path);
    const source = (await readFile(target, "utf8")).replace(/\n/g, "\r\n");
    await writeFile(target, source);
    assert.deepEqual(await patchZigTls(temporary, { checkOnly: true }), { changed: false });
    assert.equal(await readFile(target, "utf8"), source);
  });
});
