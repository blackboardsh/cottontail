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

let destroyedDuringCallback = true;
const lifecycleTimer = setTimeout(() => {
  destroyedDuringCallback = lifecycleTimer._destroyed;
}, 1);
for (let index = 0; index < 20 && !lifecycleTimer._destroyed; index += 1) {
  globalThis.__cottontailRunLoopTick();
  cottontail.sleep(1);
}
if (destroyedDuringCallback || !lifecycleTimer._destroyed) {
  throw new Error("one-shot timer _destroyed lifecycle does not match Node");
}

let refreshCount = 0;
const refreshedTimer = setTimeout(() => {
  refreshCount += 1;
  if (refreshCount === 1) refreshedTimer.refresh();
}, 1);
for (let index = 0; index < 30 && refreshCount < 2; index += 1) {
  globalThis.__cottontailRunLoopTick();
  cottontail.sleep(1);
}
if (refreshCount !== 2 || !refreshedTimer._destroyed) {
  throw new Error(`one-shot timer refresh lifecycle mismatch, got ${refreshCount} callbacks`);
}

const exceptionEvents: string[] = [];
let exceptionPhase = 0;
const onTimerException = (error: Error) => {
  if (error.message !== "timer checkpoint sentinel") throw error;
  exceptionEvents.push("caught");
};
process.on("uncaughtException", onTimerException);
setImmediate(() => {
  exceptionPhase = 1;
  exceptionEvents.push("throw");
  process.nextTick(() => exceptionEvents.push(`tick:${exceptionPhase}`));
  throw new Error("timer checkpoint sentinel");
});
setImmediate(() => {
  exceptionPhase = 2;
  exceptionEvents.push("after");
});
for (let index = 0; index < 20 && exceptionEvents.length < 4; index += 1) {
  globalThis.__cottontailRunLoopTick();
  cottontail.sleep(1);
}
process.off("uncaughtException", onTimerException);
if (exceptionEvents.join(",") !== "throw,caught,after,tick:2") {
  throw new Error(`timer exception checkpoint mismatch: ${exceptionEvents.join(",")}`);
}

console.log("timer clock passed");
