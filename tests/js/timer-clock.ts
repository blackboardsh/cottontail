const start = performance.now();
cottontail.sleep(100);
const delta = performance.now() - start;

if (delta < 50 || delta > 500) {
  throw new Error(`performance.now should use milliseconds, got ${delta}`);
}

let fired = false;
setTimeout(() => {
  fired = true;
}, 1);

for (let index = 0; index < 100; index += 1) {
  globalThis.__cottontailRunLoopTick();
  if (fired) break;
  cottontail.sleep(1);
}

if (!fired) {
  throw new Error("setTimeout did not fire under manual run-loop ticks");
}

let intervalCount = 0;
const interval = setInterval(() => {
  intervalCount += 1;
  clearInterval(interval);
}, 1);

for (let index = 0; index < 20; index += 1) {
  globalThis.__cottontailRunLoopTick();
  cottontail.sleep(1);
}

if (intervalCount !== 1) {
  throw new Error(`clearInterval inside callback should stop future ticks, got ${intervalCount}`);
}

console.log("timer clock passed");
