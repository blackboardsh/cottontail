import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const filename = fileURLToPath(import.meta.url);
assert.equal(basename(filename), "runtime-bootstrap-builtins.mjs");
assert.equal(fileURLToPath(pathToFileURL(filename)), filename);
assert.equal(readFileSync(join(dirname(filename), basename(filename)), "utf8").includes("runtime-bootstrap-builtins-ok"), true);
assert.equal(createHash("sha256").update("cottontail").digest("hex").length, 64);

let streamed = "";
for await (const chunk of Readable.from(["runtime", "-", "bootstrap"])) streamed += chunk;
assert.equal(streamed, "runtime-bootstrap");
assert.equal(Bun.version, "1.3.10");

console.log("runtime-bootstrap-builtins-ok");
