const [left, right] = await Promise.all([Promise.resolve(20), Promise.resolve(22)]);

if (left + right !== 42) {
  throw new Error(`expected async result 42, got ${left + right}`);
}

const microtaskValue = await new Promise((resolve) => queueMicrotask(() => resolve(42)));
if (microtaskValue !== 42) {
  throw new Error(`expected queueMicrotask result 42, got ${microtaskValue}`);
}

const immediateValue = await new Promise((resolve) => setImmediate(() => resolve(42)));
if (immediateValue !== 42) {
  throw new Error(`expected setImmediate result 42, got ${immediateValue}`);
}

console.log('async passed');

export {};
