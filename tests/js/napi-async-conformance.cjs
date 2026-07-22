"use strict";

const assert = require("node:assert");
const { AsyncLocalStorage } = require("node:async_hooks");
const { resolve } = require("node:path");

if (!process.argv[3]) throw new Error("missing native addon path");
const addon = require(resolve(process.argv[3]));
const storage = new AsyncLocalStorage();
let contextResult;
storage.run({ offset: 21 }, () => {
  contextResult = addon.callThreadsafe(value => value + (storage.getStore()?.offset ?? -1000));
});

Promise.all([
  addon.asyncDouble(21),
  addon.callThreadsafe((value) => value * 2),
  contextResult,
]).then(([asyncResult, threadsafeResult, threadsafeContextResult]) => {
  assert.strictEqual(asyncResult, 42);
  assert.strictEqual(threadsafeResult, 42);
  assert.strictEqual(threadsafeContextResult, 42);
  console.log("napi async conformance passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
