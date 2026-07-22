// JS-side port of Bun's collection -> Order boundary. Cottontail delegates
// execution to node:test, but bun:test registrations must be complete before
// that runner starts so preload hooks, source order, filtering, and seeded
// randomization observe Bun's collection semantics.

import { bunTestRuntimeOptions } from "./bun-test-config.js";

const testOptions = bunTestRuntimeOptions();
const randomizationEnabled = testOptions.randomize;
const parsedSeed = Number(testOptions.seed);
const randomizationSeed = randomizationEnabled
  ? (Number.isFinite(parsedSeed) && testOptions.seed !== null ? Math.trunc(parsedSeed) >>> 0 : Math.floor(Math.random() * 0x100000000) >>> 0)
  : null;

let rootScope;
let seedReported = false;

const u64Mask = (1n << 64n) - 1n;

function rotateLeft64(value, amount) {
  const bits = BigInt(amount);
  return ((value << bits) | (value >> (64n - bits))) & u64Mask;
}

function createRandom(seed) {
  let splitMixState = BigInt(seed) & u64Mask;
  const splitMixNext = () => {
    splitMixState = (splitMixState + 0x9e3779b97f4a7c15n) & u64Mask;
    let value = splitMixState;
    value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & u64Mask;
    value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & u64Mask;
    return (value ^ (value >> 31n)) & u64Mask;
  };
  const state = [splitMixNext(), splitMixNext(), splitMixNext(), splitMixNext()];
  const next = () => {
    const result = (rotateLeft64((state[0] + state[3]) & u64Mask, 23) + state[0]) & u64Mask;
    const shifted = (state[1] << 17n) & u64Mask;
    state[2] ^= state[0];
    state[3] ^= state[1];
    state[1] ^= state[2];
    state[0] ^= state[3];
    state[2] ^= shifted;
    state[3] = rotateLeft64(state[3], 45);
    return result;
  };
  return lessThan => {
    const bound = BigInt(lessThan);
    for (;;) {
      const value = next();
      const product = value * bound;
      const low = product & u64Mask;
      if (low < bound) {
        const threshold = ((1n << 64n) - bound) % bound;
        if (low < threshold) continue;
      }
      return Number(product >> 64n);
    }
  };
}

const randomizationRandom = randomizationEnabled ? createRandom(BigInt(randomizationSeed)) : null;

function shuffle(values, random) {
  for (let index = 0; index + 1 < values.length; index += 1) {
    const target = index + random(values.length - index);
    [values[index], values[target]] = [values[target], values[index]];
  }
  return values;
}

function captureContext(register) {
  return {
    register,
    directoryPath: globalThis.__dirname,
    filePath: globalThis.__cottontailRegisteringTestFile ?? globalThis.__filename ?? "",
    filename: globalThis.__filename,
    layer: globalThis.__cottontailTestRegistrationLayer,
  };
}

function setOrDelete(name, value) {
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
}

function runRegistration(operation) {
  const previous = {
    directoryPath: globalThis.__dirname,
    filePath: globalThis.__cottontailRegisteringTestFile,
    filename: globalThis.__filename,
    layer: globalThis.__cottontailTestRegistrationLayer,
  };
  setOrDelete("__dirname", operation.directoryPath);
  setOrDelete("__filename", operation.filename);
  setOrDelete("__cottontailRegisteringTestFile", operation.filePath || undefined);
  setOrDelete("__cottontailTestRegistrationLayer", operation.layer);
  try {
    return operation.register();
  } finally {
    setOrDelete("__dirname", previous.directoryPath);
    setOrDelete("__filename", previous.filename);
    setOrDelete("__cottontailRegisteringTestFile", previous.filePath);
    setOrDelete("__cottontailTestRegistrationLayer", previous.layer);
  }
}

function orderedEntries(scope) {
  const entries = scope.entries.splice(0);
  if (!randomizationEnabled || entries.length < 2) return entries;

  if (scope !== rootScope) {
    return shuffle(entries, randomizationRandom);
  }

  const groupsByFile = new Map();
  for (const entry of entries) {
    const key = String(entry.filePath ?? "");
    let group = groupsByFile.get(key);
    if (!group) {
      group = [];
      groupsByFile.set(key, group);
    }
    group.push(entry);
  }
  const groups = shuffle([...groupsByFile.values()], randomizationRandom);
  return groups.flatMap((group) => shuffle(group, randomizationRandom));
}

export function createBunTestOrderScope(parent = null) {
  const scope = { parent, hooks: [], entries: [], collecting: false, flushing: false };
  if (!parent && !rootScope) rootScope = scope;
  return scope;
}

export function beginBunTestCollection(scope) {
  scope.collecting = true;
}

export function enqueueBunTestEntry(scope, register) {
  if (scope.collecting || (scope === rootScope && globalThis.__cottontailLoadingTestModules)) {
    scope.entries.push(captureContext(register));
    return undefined;
  }
  return register();
}

export function enqueueBunTestHook(scope, register) {
  if (scope.collecting || (scope === rootScope && globalThis.__cottontailLoadingTestModules)) {
    scope.hooks.push(captureContext(register));
    return undefined;
  }
  return register();
}

export function flushBunTestOrderScope(scope) {
  if (scope.flushing) return;
  scope.flushing = true;
  scope.collecting = false;
  try {
    for (const hook of scope.hooks.splice(0)) runRegistration(hook);
    for (const entry of orderedEntries(scope)) runRegistration(entry);
  } finally {
    scope.flushing = false;
  }
}

export function reportBunTestRandomizationSeed() {
  if (!randomizationEnabled || seedReported) return;
  seedReported = true;
  globalThis.console?.error?.(`--seed=${randomizationSeed}`);
}
