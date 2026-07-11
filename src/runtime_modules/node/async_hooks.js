let nextAsyncId = 1;
let currentAsyncId = 1;
let currentTriggerAsyncId = 0;
let currentResource = {};
const defaultExecutionResource = currentResource;
let continuationResource = null;
const hooks = new Set();
const storages = new Set();
const asyncWrappedCallback = Symbol.for("cottontail.async_hooks.wrappedCallback");
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");
let drainingWrappedCallbackJobs = false;
const promiseAsyncIds = new WeakMap();
const gcTrackedAsyncResourceIds = new Set();
const destroyedAsyncResourceIds = new Set();

function nodeTypeError(code, message) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function nodeRangeError(code, message) {
  const error = new RangeError(message);
  error.code = code;
  return error;
}

function emitHook(name, ...args) {
  for (const hook of [...hooks]) {
    const callback = hook[name];
    if (typeof callback === "function" && hook.enabled) {
      try {
        callback(...args);
      } catch (error) {
        const fatal = error instanceof Error ? error : new Error(String(error));
        try {
          globalThis.__ctError = fatal;
        } catch {}
        throw fatal;
      }
    }
  }
}

function registerPromiseResource(promise, triggerAsyncIdValue = currentAsyncId) {
  if (!promise || (typeof promise !== "object" && typeof promise !== "function")) return 0;
  const existing = promiseAsyncIds.get(promise);
  if (existing != null) return existing;
  const asyncId = ++nextAsyncId;
  promiseAsyncIds.set(promise, asyncId);
  emitHook("init", asyncId, "PROMISE", triggerAsyncIdValue, promise);
  return asyncId;
}

export function executionAsyncId() {
  return currentAsyncId;
}

export function triggerAsyncId() {
  return currentTriggerAsyncId;
}

export function executionAsyncResource() {
  if (currentResource === defaultExecutionResource && continuationResource != null) return continuationResource;
  return currentResource;
}

export function createHook(callbacks = {}) {
  for (const name of ["init", "before", "after", "destroy", "promiseResolve"]) {
    if (callbacks?.[name] !== undefined && typeof callbacks[name] !== "function") {
      throw nodeTypeError("ERR_ASYNC_CALLBACK", `hook.${name} must be a function`);
    }
  }
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
    if (type === undefined) {
      throw nodeTypeError("ERR_INVALID_ARG_TYPE", "The \"type\" argument must be of type string");
    }
    if (String(type).length === 0) {
      throw nodeTypeError("ERR_ASYNC_TYPE", "Invalid async resource type");
    }
    const triggerAsyncIdValue = typeof options === "number" ? options : options?.triggerAsyncId ?? currentAsyncId;
    if (!Number.isInteger(triggerAsyncIdValue) || triggerAsyncIdValue < -1) {
      throw nodeRangeError("ERR_INVALID_ASYNC_ID", "Invalid asyncId value");
    }
    this.type = String(type);
    this.asyncIdValue = ++nextAsyncId;
    this.triggerAsyncIdValue = triggerAsyncIdValue;
    this.requireManualDestroy = typeof options === "object" && options?.requireManualDestroy === true;
    if (!this.requireManualDestroy) gcTrackedAsyncResourceIds.add(this.asyncIdValue);
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
    continuationResource = null;
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
    if (destroyedAsyncResourceIds.has(this.asyncIdValue)) return;
    destroyedAsyncResourceIds.add(this.asyncIdValue);
    gcTrackedAsyncResourceIds.delete(this.asyncIdValue);
    emitHook("destroy", this.asyncIdValue);
  }

  bind(fn, thisArg = undefined) {
    return (...args) => this.runInAsyncScope(fn, thisArg, ...args);
  }

  static bind(fn, type = "bound-anonymous-fn", thisArg = undefined) {
    return new AsyncResource(type).bind(fn, thisArg);
  }
}

Object.defineProperty(globalThis, "__cottontailAsyncHooksOnGc", {
  value: () => {
  for (const asyncId of [...gcTrackedAsyncResourceIds]) {
    if (destroyedAsyncResourceIds.has(asyncId)) continue;
    destroyedAsyncResourceIds.add(asyncId);
    gcTrackedAsyncResourceIds.delete(asyncId);
    emitHook("destroy", asyncId);
  }
  },
  configurable: true,
  writable: true,
});

const storageStack = [];

function captureStorageSnapshot() {
  return Array.from(storages, (storage) => [storage, storage.enabled, storage._store, storage._hasStore]);
}

function runWithStorageSnapshot(snapshot, fn, thisArg, args) {
  const previous = snapshot.map(([storage]) => [storage, storage.enabled, storage._store, storage._hasStore]);
  for (const [storage, enabled, store, hasStore] of snapshot) {
    storage.enabled = enabled;
    storage._store = store;
    storage._hasStore = hasStore;
  }
  try {
    return fn.apply(thisArg, args);
  } finally {
    for (const [storage, enabled, store, hasStore] of previous) {
      storage.enabled = enabled;
      storage._store = store;
      storage._hasStore = hasStore;
    }
  }
}

export function _wrapAsyncCallback(callback) {
  if (typeof callback !== "function" || callback[asyncWrappedCallback]) return callback;
  const snapshot = captureStorageSnapshot();
  const snapshotAsyncId = currentAsyncId;
  const snapshotTriggerAsyncId = currentTriggerAsyncId;
  const snapshotResource = currentResource;
  const wrapped = function(...args) {
    const previousAsyncId = currentAsyncId;
    const previousTriggerAsyncId = currentTriggerAsyncId;
    const previousResource = currentResource;
    currentAsyncId = snapshotAsyncId;
    currentTriggerAsyncId = snapshotTriggerAsyncId;
    currentResource = snapshotResource;
    continuationResource = null;
    try {
      const result = runWithStorageSnapshot(snapshot, callback, this, args);
      if (!drainingWrappedCallbackJobs && typeof globalThis.cottontail?.drainJobs === "function") {
        drainingWrappedCallbackJobs = true;
        try {
          globalThis.cottontail.drainJobs();
        } finally {
          drainingWrappedCallbackJobs = false;
        }
      }
      if (snapshotResource !== defaultExecutionResource) continuationResource = snapshotResource;
      return result;
    } finally {
      currentAsyncId = previousAsyncId;
      currentTriggerAsyncId = previousTriggerAsyncId;
      currentResource = previousResource;
    }
  };
  Object.defineProperty(wrapped, asyncWrappedCallback, { __proto__: null, value: true });
  return wrapped;
}

function patchGlobalAsyncSchedulers() {
  const global = globalThis;
  if (typeof global.queueMicrotask === "function" && !global.queueMicrotask.__cottontailAsyncHooksPatched) {
    const nativeQueueMicrotask = global.queueMicrotask.bind(global);
    global.queueMicrotask = (callback) => nativeQueueMicrotask(_wrapAsyncCallback(callback));
    global.queueMicrotask.__cottontailAsyncHooksPatched = true;
  }
  for (const [setName, clearName] of [["setTimeout", "clearTimeout"], ["setInterval", "clearInterval"], ["setImmediate", "clearImmediate"]]) {
    if (typeof global[setName] !== "function" || global[setName].__cottontailAsyncHooksPatched) continue;
    const nativeScheduler = global[setName];
    const nativeSet = nativeScheduler.bind(global);
    if (setName === "setImmediate") {
      const nativeClear = typeof global[clearName] === "function" ? global[clearName].bind(global) : undefined;
      const wrappedScheduler = (callback, ...args) => {
        const snapshot = captureStorageSnapshot();
        const asyncId = ++nextAsyncId;
        const trigger = currentAsyncId;
        let handle;
        let destroyed = false;
        const emitDestroyOnce = () => {
          if (destroyed) return;
          destroyed = true;
          emitHook("destroy", asyncId);
        };
        const runImmediate = (...innerArgs) => {
          if (destroyed) return undefined;
          const previousAsyncId = currentAsyncId;
          const previousTriggerAsyncId = currentTriggerAsyncId;
          const previousResource = currentResource;
          currentAsyncId = asyncId;
          currentTriggerAsyncId = trigger;
          currentResource = handle;
          continuationResource = null;
          emitHook("before", asyncId);
          try {
            return runWithStorageSnapshot(snapshot, callback, this, innerArgs);
          } finally {
            emitHook("after", asyncId);
            if (handle !== defaultExecutionResource) continuationResource = handle;
            currentAsyncId = previousAsyncId;
            currentTriggerAsyncId = previousTriggerAsyncId;
            currentResource = previousResource;
            emitDestroyOnce();
          }
        };
        handle = nativeSet(runImmediate, ...args);
        if (handle && (typeof handle === "object" || typeof handle === "function")) {
          Object.defineProperty(handle, "__cottontailAsyncDestroy", {
            value: emitDestroyOnce,
            configurable: true,
          });
        }
        emitHook("init", asyncId, "Immediate", trigger, handle);
        return handle;
      };
      if (typeof nativeScheduler[promisifyCustom] === "function") {
        Object.defineProperty(wrappedScheduler, promisifyCustom, {
          value: nativeScheduler[promisifyCustom],
          configurable: true,
        });
      }
      global[setName] = wrappedScheduler;
      global[setName].__cottontailAsyncHooksPatched = true;
      if (nativeClear) {
        global[clearName] = (handle) => {
          const result = nativeClear(handle);
          handle?.__cottontailAsyncDestroy?.();
          return result;
        };
      }
      continue;
    }
    const wrappedScheduler = (callback, delay, ...args) => nativeSet(_wrapAsyncCallback(callback), delay, ...args);
    if (typeof nativeScheduler[promisifyCustom] === "function") {
      Object.defineProperty(wrappedScheduler, promisifyCustom, {
        value: nativeScheduler[promisifyCustom],
        configurable: true,
      });
    }
    global[setName] = wrappedScheduler;
    global[setName].__cottontailAsyncHooksPatched = true;
    if (typeof global[clearName] === "function") global[clearName] = global[clearName].bind(global);
  }
  if (typeof global.Promise === "function" && !global.Promise.prototype.then.__cottontailAsyncHooksPatched) {
    const nativeThen = global.Promise.prototype.then;
    const nativeFinally = global.Promise.prototype.finally;
    const nativeResolve = global.Promise.resolve.bind(global.Promise);
    global.Promise.resolve = function resolve(value) {
      if (globalThis.__cottontailSuppressAsyncHookPromise === true) return nativeResolve(value);
      const promise = nativeResolve(value);
      const asyncId = registerPromiseResource(promise, currentAsyncId);
      emitHook("promiseResolve", asyncId);
      return promise;
    };
    global.Promise.resolve.__cottontailAsyncHooksPatched = true;
    global.Promise.prototype.then = function then(onFulfilled, onRejected) {
      if (globalThis.__cottontailSuppressAsyncHookPromise === true) {
        return nativeThen.call(this, onFulfilled, onRejected);
      }
      const trigger = promiseAsyncIds.get(this) ?? currentAsyncId;
      const snapshot = captureStorageSnapshot();
      let child;
      let childAsyncId = 0;
      const runPromiseCallback = (callback, value, isReject) => {
        const previousAsyncId = currentAsyncId;
        const previousTriggerAsyncId = currentTriggerAsyncId;
        const previousResource = currentResource;
        currentAsyncId = childAsyncId || trigger;
        currentTriggerAsyncId = trigger;
        currentResource = child ?? previousResource;
        continuationResource = null;
        if (childAsyncId) emitHook("before", childAsyncId);
        try {
          if (typeof callback === "function") return runWithStorageSnapshot(snapshot, callback, this, [value]);
          if (isReject) throw value;
          return value;
        } finally {
          if (childAsyncId) emitHook("after", childAsyncId);
          if (childAsyncId) emitHook("promiseResolve", childAsyncId);
          if (childAsyncId) emitHook("destroy", childAsyncId);
          if (currentResource !== defaultExecutionResource) continuationResource = currentResource;
          currentAsyncId = previousAsyncId;
          currentTriggerAsyncId = previousTriggerAsyncId;
          currentResource = previousResource;
        }
      };
      child = nativeThen.call(
        this,
        (value) => runPromiseCallback(onFulfilled, value, false),
        (error) => runPromiseCallback(onRejected, error, true),
      );
      childAsyncId = registerPromiseResource(child, trigger);
      return child;
    };
    global.Promise.prototype.then.__cottontailAsyncHooksPatched = true;
    global.Promise.prototype.catch = function catchPromise(onRejected) {
      return this.then(undefined, onRejected);
    };
    global.Promise.prototype.catch.__cottontailAsyncHooksPatched = true;
    if (typeof nativeFinally === "function") {
      global.Promise.prototype.finally = function finallyPromise(onFinally) {
        return nativeFinally.call(this, _wrapAsyncCallback(onFinally));
      };
      global.Promise.prototype.finally.__cottontailAsyncHooksPatched = true;
    }
  }
}

export class AsyncLocalStorage {
  constructor(options = {}) {
    if (options === null || typeof options !== "object") {
      throw nodeTypeError("ERR_INVALID_ARG_TYPE", "The \"options\" argument must be an object");
    }
    this.enabled = true;
    this.name = options.name == null ? "" : String(options.name);
    this._defaultValue = Object.prototype.hasOwnProperty.call(options, "defaultValue") ? options.defaultValue : undefined;
    this._hasDefaultValue = Object.prototype.hasOwnProperty.call(options, "defaultValue");
    this._store = undefined;
    this._hasStore = false;
    storages.add(this);
  }

  disable() {
    this.enabled = false;
    this._store = undefined;
    this._hasStore = false;
  }

  getStore() {
    if (!this.enabled) return undefined;
    return this._hasStore ? this._store : (this._hasDefaultValue ? this._defaultValue : undefined);
  }

  enterWith(store) {
    this.enabled = true;
    this._store = store;
    this._hasStore = true;
  }

  run(store, callback, ...args) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const previous = this._store;
    const previousHasStore = this._hasStore;
    const previousEnabled = this.enabled;
    this.enabled = true;
    this._store = store;
    this._hasStore = true;
    storageStack.push(this);
    try {
      return callback(...args);
    } finally {
      storageStack.pop();
      this._store = previous;
      this._hasStore = previousHasStore;
      this.enabled = previousEnabled;
    }
  }

  exit(callback, ...args) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const previous = this._store;
    const previousHasStore = this._hasStore;
    this._store = undefined;
    this._hasStore = false;
    try {
      return callback(...args);
    } finally {
      this._store = previous;
      this._hasStore = previousHasStore;
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

export default {
  AsyncLocalStorage,
  AsyncResource,
  asyncWrapProviders,
  createHook,
  executionAsyncId,
  executionAsyncResource,
  triggerAsyncId,
};
