let nextAsyncId = 1;
let currentAsyncId = 1;
let currentTriggerAsyncId = 0;
let currentResource = {};
const hooks = new Set();
const storages = new Set();
const asyncWrappedCallback = Symbol.for("cottontail.async_hooks.wrappedCallback");

function emitHook(name, ...args) {
  for (const hook of [...hooks]) {
    const callback = hook[name];
    if (typeof callback === "function" && hook.enabled) callback(...args);
  }
}

export function executionAsyncId() {
  return currentAsyncId;
}

export function triggerAsyncId() {
  return currentTriggerAsyncId;
}

export function executionAsyncResource() {
  return currentResource;
}

export function createHook(callbacks = {}) {
  const hook = {
    enabled: false,
    init: callbacks.init,
    before: callbacks.before,
    after: callbacks.after,
    destroy: callbacks.destroy,
    promiseResolve: callbacks.promiseResolve,
    enable() {
      this.enabled = true;
      hooks.add(this);
      return this;
    },
    disable() {
      this.enabled = false;
      hooks.delete(this);
      return this;
    },
  };
  return hook;
}

export class AsyncResource {
  constructor(type, options = {}) {
    this.type = String(type);
    this.asyncIdValue = ++nextAsyncId;
    this.triggerAsyncIdValue = options?.triggerAsyncId ?? currentAsyncId;
    emitHook("init", this.asyncIdValue, this.type, this.triggerAsyncIdValue, this);
  }

  asyncId() {
    return this.asyncIdValue;
  }

  triggerAsyncId() {
    return this.triggerAsyncIdValue;
  }

  runInAsyncScope(fn, thisArg = undefined, ...args) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    const previousAsyncId = currentAsyncId;
    const previousTrigger = currentTriggerAsyncId;
    const previousResource = currentResource;
    currentAsyncId = this.asyncIdValue;
    currentTriggerAsyncId = this.triggerAsyncIdValue;
    currentResource = this;
    emitHook("before", this.asyncIdValue);
    try {
      return fn.apply(thisArg, args);
    } finally {
      emitHook("after", this.asyncIdValue);
      currentAsyncId = previousAsyncId;
      currentTriggerAsyncId = previousTrigger;
      currentResource = previousResource;
    }
  }

  emitDestroy() {
    emitHook("destroy", this.asyncIdValue);
  }

  bind(fn, thisArg = undefined) {
    return (...args) => this.runInAsyncScope(fn, thisArg, ...args);
  }

  static bind(fn, type = "bound-anonymous-fn", thisArg = undefined) {
    return new AsyncResource(type).bind(fn, thisArg);
  }
}

const storageStack = [];

function captureStorageSnapshot() {
  return Array.from(storages, (storage) => [storage, storage.enabled, storage._store]);
}

function runWithStorageSnapshot(snapshot, fn, thisArg, args) {
  const previous = snapshot.map(([storage]) => [storage, storage.enabled, storage._store]);
  for (const [storage, enabled, store] of snapshot) {
    storage.enabled = enabled;
    storage._store = store;
  }
  try {
    return fn.apply(thisArg, args);
  } finally {
    for (const [storage, enabled, store] of previous) {
      storage.enabled = enabled;
      storage._store = store;
    }
  }
}

export function _wrapAsyncCallback(callback) {
  if (typeof callback !== "function" || callback[asyncWrappedCallback]) return callback;
  const snapshot = captureStorageSnapshot();
  const wrapped = function(...args) {
    return runWithStorageSnapshot(snapshot, callback, this, args);
  };
  Object.defineProperty(wrapped, asyncWrappedCallback, { value: true });
  return wrapped;
}

function patchGlobalAsyncSchedulers() {
  const global = globalThis;
  if (typeof global.queueMicrotask === "function" && !global.queueMicrotask.__cottontailAsyncHooksPatched) {
    const nativeQueueMicrotask = global.queueMicrotask.bind(global);
    global.queueMicrotask = (callback) => nativeQueueMicrotask(_wrapAsyncCallback(callback));
    global.queueMicrotask.__cottontailAsyncHooksPatched = true;
  }
  for (const [setName, clearName] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"]]) {
    if (typeof global[setName] !== "function" || global[setName].__cottontailAsyncHooksPatched) continue;
    const nativeSet = global[setName].bind(global);
    global[setName] = (callback, delay, ...args) => nativeSet(_wrapAsyncCallback(callback), delay, ...args);
    global[setName].__cottontailAsyncHooksPatched = true;
    if (typeof global[clearName] === "function") global[clearName] = global[clearName].bind(global);
  }
}

export class AsyncLocalStorage {
  constructor() {
    this.enabled = true;
    this._store = undefined;
    storages.add(this);
  }

  disable() {
    this.enabled = false;
    this._store = undefined;
  }

  getStore() {
    return this.enabled ? this._store : undefined;
  }

  enterWith(store) {
    this.enabled = true;
    this._store = store;
  }

  run(store, callback, ...args) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const previous = this._store;
    const previousEnabled = this.enabled;
    this.enabled = true;
    this._store = store;
    storageStack.push(this);
    try {
      return callback(...args);
    } finally {
      storageStack.pop();
      this._store = previous;
      this.enabled = previousEnabled;
    }
  }

  exit(callback, ...args) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const previous = this._store;
    this._store = undefined;
    try {
      return callback(...args);
    } finally {
      this._store = previous;
    }
  }

  bind(fn) {
    const store = this._store;
    return (...args) => this.run(store, fn, ...args);
  }

  snapshot() {
    const store = this._store;
    return (fn, ...args) => this.run(store, fn, ...args);
  }

  static bind(fn) {
    return _wrapAsyncCallback(fn);
  }

  static snapshot() {
    const snapshot = captureStorageSnapshot();
    return (fn, ...args) => runWithStorageSnapshot(snapshot, fn, undefined, args);
  }
}

patchGlobalAsyncSchedulers();

export const asyncWrapProviders = Object.freeze({
  NONE: 0,
  PROMISE: 1,
  TIMERWRAP: 2,
  Timeout: 3,
  Immediate: 4,
  TickObject: 5,
});

// COTTONTAIL-COMPAT: node:async_hooks async propagation - synchronous scopes plus timer and microtask AsyncLocalStorage snapshots are tracked; full promise-chain propagation needs native scheduler hooks.

export default {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};
