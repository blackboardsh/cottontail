// Port of Bun 1.3.10's bun.js/test/ScopeFunctions.zig modifier state machine.

const noEachTable = Symbol("bun:test no each table");
const scopeState = new WeakMap();

function stateFor(scope) {
  const state = scopeState.get(scope);
  if (!state) throw new Error("Expected callee to be ScopeFunctions");
  return state;
}

function formatScope(state) {
  let output = state.kind;
  if (state.concurrent === true) output += ".concurrent";
  else if (state.concurrent === false) output += ".serial";
  if (state.mode !== "normal") output += `.${state.mode}`;
  if (state.only) output += ".only";
  if (state.eachTable !== noEachTable) output += ".each()";
  return output;
}

function registrationOptions(state) {
  const options = {};
  if (state.mode !== "normal") options[state.mode] = true;
  if (state.concurrent === true) options.concurrent = true;
  else if (state.concurrent === false) options.serial = true;
  if (state.only) options.only = true;
  return options;
}

function extendScope(scope, extension, operation, functionName) {
  const state = stateFor(scope);
  if (extension.mode === "failing" && state.kind === "describe") {
    throw new Error(`Cannot ${operation} on ${formatScope(state)}`);
  }
  if (extension.only) state.assertOnlyAllowed();

  if (
    (extension.mode && state.mode !== "normal") ||
    (extension.concurrent !== undefined && state.concurrent !== null) ||
    (extension.only && state.only)
  ) {
    throw new Error(`Cannot ${operation} on ${formatScope(state)}`);
  }

  return state.create({
    ...state,
    mode: extension.mode ?? state.mode,
    concurrent: extension.concurrent ?? state.concurrent,
    only: extension.only ?? state.only,
    cache: new Map(),
  }, functionName);
}

function cachedExtension(scope, property, extension) {
  const state = stateFor(scope);
  if (state.cache.has(property)) return state.cache.get(property);
  const result = extendScope(scope, extension, `get .${property}`, property);
  state.cache.set(property, result);
  return result;
}

function conditionalExtension(scope, condition, extension, operation, invert, functionName) {
  const state = stateFor(scope);
  if (Boolean(condition) !== invert) {
    return extendScope(scope, extension, operation, functionName);
  }
  return state.create({ ...state, cache: new Map() }, functionName);
}

const scopePrototype = Object.create(Function.prototype);

Object.defineProperties(scopePrototype, {
  skip: { configurable: true, get() { return cachedExtension(this, "skip", { mode: "skip" }); } },
  todo: { configurable: true, get() { return cachedExtension(this, "todo", { mode: "todo" }); } },
  failing: { configurable: true, get() { return cachedExtension(this, "failing", { mode: "failing" }); } },
  concurrent: { configurable: true, get() { return cachedExtension(this, "concurrent", { concurrent: true }); } },
  serial: { configurable: true, get() { return cachedExtension(this, "serial", { concurrent: false }); } },
  only: { configurable: true, get() { return cachedExtension(this, "only", { only: true }); } },
  if: {
    configurable: true,
    value: function scopeIf(condition) {
      if (arguments.length === 0) throw new Error("Expected condition to be a boolean");
      return conditionalExtension(this, condition, { mode: "skip" }, "call .if()", true, "if");
    },
  },
  skipIf: {
    configurable: true,
    value: function skipIf(condition) {
      if (arguments.length === 0) throw new Error("Expected condition to be a boolean");
      return conditionalExtension(this, condition, { mode: "skip" }, "call .skipIf()", false, "skipIf");
    },
  },
  todoIf: {
    configurable: true,
    value: function todoIf(condition) {
      if (arguments.length === 0) throw new Error("Expected condition to be a boolean");
      return conditionalExtension(this, condition, { mode: "todo" }, "call .todoIf()", false, "todoIf");
    },
  },
  failingIf: {
    configurable: true,
    value: function failingIf(condition) {
      if (arguments.length === 0) throw new Error("Expected condition to be a boolean");
      return conditionalExtension(this, condition, { mode: "failing" }, "call .failingIf()", false, "failingIf");
    },
  },
  concurrentIf: {
    configurable: true,
    value: function concurrentIf(condition) {
      if (arguments.length === 0) throw new Error("Expected condition to be a boolean");
      return conditionalExtension(this, condition, { concurrent: true }, "call .concurrentIf()", false, "concurrentIf");
    },
  },
  serialIf: {
    configurable: true,
    value: function serialIf(condition) {
      if (arguments.length === 0) throw new Error("Expected condition to be a boolean");
      return conditionalExtension(this, condition, { concurrent: false }, "call .serialIf()", false, "serialIf");
    },
  },
  each: {
    configurable: true,
    value: function each(table) {
      const state = stateFor(this);
      const rows = state.validateEachTable(table);
      if (state.eachTable !== noEachTable) {
        throw new Error(`Cannot each on ${formatScope(state)}`);
      }
      return state.create({ ...state, eachTable: rows, cache: new Map() }, "each");
    },
  },
  [Symbol.toStringTag]: { configurable: true, value: "ScopeFunctions" },
});

export function createBunScopeFunction({ kind, invoke, validateEachTable, assertOnlyAllowed }) {
  function create(state, functionName) {
    const scope = (...args) => {
      const current = stateFor(scope);
      return invoke(
        args,
        registrationOptions(current),
        formatScope(current),
        current.eachTable === noEachTable ? undefined : current.eachTable,
      );
    };
    Object.setPrototypeOf(scope, scopePrototype);
    Object.defineProperties(scope, {
      length: { configurable: true, value: 1 },
      name: { configurable: true, value: `bound ${functionName}` },
    });
    scopeState.set(scope, state);
    return scope;
  }

  return create({
    kind,
    mode: "normal",
    concurrent: null,
    only: false,
    eachTable: noEachTable,
    cache: new Map(),
    validateEachTable,
    assertOnlyAllowed,
    create,
  }, kind);
}
