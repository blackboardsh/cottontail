"use strict";

const assert = require("node:assert");
const { basename, dirname, resolve, sep } = require("node:path");

if (!process.argv[2]) throw new Error("missing native addon path");
if (typeof cottontail?.nativeAddonLoad !== "function") throw new Error("native addon bridge is unavailable");

const target = resolve(process.argv[2]);
const directory = dirname(target);
const alias = `${directory}${sep}..${sep}${basename(directory)}${sep}${basename(target)}`;

const first = cottontail.nativeAddonLoad(target, {});
assert.strictEqual(first.first, 1);
assert.strictEqual(first.second, 2);
assert.strictEqual(first.reentrant, 3);

const replayed = cottontail.nativeAddonLoad(alias, {});
assert.strictEqual(replayed.first, 4);
assert.strictEqual(replayed.second, 5);
assert.strictEqual(replayed.reentrant, 6);

console.log("napi registration conformance passed");
