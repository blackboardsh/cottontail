// JS-side port of Bun's collection -> Order boundary. Cottontail delegates
// execution to node:test, but bun:test registrations must be complete before
// that runner starts so preload hooks, source order, filtering, and seeded
// randomization observe Bun's collection semantics.

const argv = Array.from(globalThis.process?.argv ?? []).slice(2).map(String);

function cliOption(name) {
  const equals = argv.find((argument) => argument.startsWith(`${name}=`));
  if (equals != null) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

const configuredSeed = cliOption("--seed");
const randomizationEnabled = argv.includes("--randomize") || argv.some((argument) => argument.startsWith("--randomize=")) ||
  configuredSeed !== undefined;
const parsedSeed = Number(configuredSeed);
const randomizationSeed = randomizationEnabled
  ? (Number.isFinite(parsedSeed) && configuredSeed !== "" ? Math.trunc(parsedSeed) >>> 0 : Math.floor(Math.random() * 0x100000000) >>> 0)
  : null;

const perFileRandoms = new Map();
let rootScope;
let seedReported = false;

function basename(path) {
  const normalized = String(path ?? "").replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

function createRandom(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function randomForFile(filePath) {
  const path = String(filePath ?? "").replaceAll("\\", "/");
  let random = perFileRandoms.get(path);
  if (!random) {
    random = createRandom((randomizationSeed + hashString(basename(path))) >>> 0);
    perFileRandoms.set(path, random);
  }
  return random;
}

function shuffle(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
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
    return shuffle(entries, randomForFile(entries[0]?.filePath));
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
  const groups = shuffle([...groupsByFile.values()], createRandom(randomizationSeed));
  return groups.flatMap((group) => shuffle(group, randomForFile(group[0]?.filePath)));
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
