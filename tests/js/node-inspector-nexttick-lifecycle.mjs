import assert from "node:assert/strict";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);
const { AsyncLocalStorage } = require("node:async_hooks");

async function checkInspectorLoading(specifier) {
  const storage = new AsyncLocalStorage();
  const store = { specifier };
  const observed = [];
  let timeout;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${specifier} stranded a nextTick callback`)), 2_000);
      const checked = (callback) => () => {
        try {
          callback();
        } catch (error) {
          reject(error);
        }
      };
      storage.run(store, () => {
        // Load the capability after the regular process/async_hooks runtime has
        // queued work. The second tick must still run after a microtask, once
        // the first tick has consumed this turn's nextTick priority.
        process.nextTick(checked(() => {
          assert.equal(storage.getStore(), store);
          observed.push("first tick");
          queueMicrotask(checked(() => {
            assert.equal(storage.getStore(), store);
            observed.push("microtask");
            process.nextTick(checked(() => {
              assert.equal(storage.getStore(), store);
              observed.push("second tick");
              resolve();
            }));
          }));
        }));
        const inspector = require(specifier);
        assert.equal(typeof inspector.Session, "function");
      });
    });
    assert.deepEqual(observed, ["first tick", "microtask", "second tick"]);
    console.log(`ok nextTick lifecycle after ${specifier}`);
  } finally {
    clearTimeout(timeout);
    storage.disable();
  }
}

await checkInspectorLoading("node:inspector");
await checkInspectorLoading("node:inspector/promises");
console.log("node inspector nextTick lifecycle passed");
