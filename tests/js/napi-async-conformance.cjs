"use strict";

const assert = require("node:assert");
const { resolve } = require("node:path");

if (!process.argv[3]) throw new Error("missing native addon path");
const addon = require(resolve(process.argv[3]));

Promise.all([
  addon.asyncDouble(21),
  addon.callThreadsafe((value) => value * 2),
]).then(([asyncResult, threadsafeResult]) => {
  assert.strictEqual(asyncResult, 42);
  assert.strictEqual(threadsafeResult, 42);
  console.log("napi async conformance passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
