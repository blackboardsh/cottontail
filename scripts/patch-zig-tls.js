#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const tlsPatch = JSON.parse(await readFile(path.join(root, "scripts/zig-tls-patch.json"), "utf8"));
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Both endpoints are authenticated: never guess how to patch an unknown Zig
// release or a locally modified standard library.
export async function patchZigTls(zigRoot, { checkOnly = false } = {}) {
  const writes = [];
  for (const file of tlsPatch.files) {
    const target = path.join(zigRoot, file.path);
    const raw = await readFile(target, "utf8");
    let source = raw.replace(/\r\n/g, "\n");
    const actual = sha256(source);
    if (actual === file.patchedSha256) {
      if (raw !== source && !checkOnly) writes.push({ target, source });
      continue;
    }
    if (actual !== file.pristineSha256) throw new Error(`Zig TLS source drift: ${file.path}`);
    if (checkOnly) throw new Error(`Zig TLS security patch missing: ${file.path}`);
    for (const edit of file.edits) {
      if (source.split(edit.before).length !== 2) throw new Error(`Ambiguous Zig TLS edit: ${file.path}`);
      source = source.replace(edit.before, edit.after);
    }
    if (sha256(source) !== file.patchedSha256) throw new Error(`Zig TLS patch hash mismatch: ${file.path}`);
    writes.push({ target, source });
  }
  // Validate every source before mutating any. Atomic file replacement also
  // permits retry after a process interruption between files.
  for (const { target, source } of writes) {
    const temporary = `${target}.cottontail-tls-tmp`;
    await writeFile(temporary, source);
    await rename(temporary, target);
  }
  return { changed: writes.length > 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const zigRoot = path.join(root, "vendors/zig");
  const version = (await readFile(path.join(zigRoot, ".zig-version"), "utf8")).trim();
  if (version !== tlsPatch.version) throw new Error(`Expected Zig ${tlsPatch.version}, found ${version}`);
  await patchZigTls(zigRoot, { checkOnly: process.argv.includes("--check") });
  console.log(`OK Zig ${version}: compromised TLS key policy ${tlsPatch.policyVersion}`);
}
