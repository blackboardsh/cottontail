const [left, right] = await Promise.all([Promise.resolve(20), Promise.resolve(22)]);

if (left + right !== 42) {
  throw new Error(`expected async result 42, got ${left + right}`);
}

console.log('async passed');

export {};
