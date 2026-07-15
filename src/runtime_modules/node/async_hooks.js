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
    // Node semantics: the resource captures the async context (including
    // AsyncLocalStorage stores) that was active when it was created;
    // runInAsyncScope/bind re-enter that context.
    this._storageSnapshot = captureStorageSnapshot();
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
      if (this._storageSnapshot !== undefined) {
        return runWithStorageSnapshot(this._storageSnapshot, fn, thisArg, args);
      }
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

// Attach a settle-time callback with the native (unpatched) promise
// machinery: the patched Promise.prototype.then restores its captured
// storage snapshot after each reaction, which would clobber the restore.
function deferRestoreUntilSettled(thenable, restore) {
  const previousFlag = globalThis.__cottontailSuppressAsyncHookPromise;
  globalThis.__cottontailSuppressAsyncHookPromise = true;
  try {
    Promise.resolve(thenable).then(restore, restore);
  } finally {
    globalThis.__cottontailSuppressAsyncHookPromise = previousFlag;
  }
}

function captureStorageSnapshot() {
  return Array.from(storages, (storage) =>
    [storage, storage.enabled, storage._store, storage._hasStore, storage._disableGeneration ?? 0]);
}

function runWithStorageSnapshot(snapshot, fn, thisArg, args) {
  const frames = [];
  for (const entry of snapshot) {
    const [storage, enabled, store, hasStore, generation] = entry;
    // A disable() issued after the snapshot invalidates it for this storage.
    if ((storage._disableGeneration ?? 0) !== generation) continue;
    frames.push({
      storage,
      enabled,
      store,
      hasStore,
      prevEnabled: storage.enabled,
      prevStore: storage._store,
      prevHasStore: storage._hasStore,
    });
    storage.enabled = enabled;
    storage._store = store;
    storage._hasStore = hasStore;
  }
  try {
    return fn.apply(thisArg, args);
  } finally {
    for (const frame of frames) {
      // Only undo values this frame installed: an inner AsyncLocalStorage.run
      // with an async callback (or a nested wrapped callback) may have opened
      // a deferred context window that must survive this frame's exit; its
      // own settle handler restores it.
      const { storage } = frame;
      if (storage._store === frame.store && storage._hasStore === frame.hasStore && storage.enabled === frame.enabled) {
        storage.enabled = frame.prevEnabled;
        storage._store = frame.prevStore;
        storage._hasStore = frame.prevHasStore;
      }
    }
  }
}

// PromiseResolveThenableJob invokes `thenable.then` from the engine's
// microtask queue where the async context is gone. Hand the engine a wrapper
// whose `then` re-enters the context captured right now. The wrapper is never
// observable: the engine consumes it internally.
function contextWrappedThenable(thenable) {
  const originalThen = thenable.then;
  return {
    then: _wrapAsyncCallback(function then(...args) {
      return originalThen.apply(thenable, args);
    }),
  };
}

function isNonPromiseThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    !(value instanceof Promise) && typeof value.then === "function";
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

// process.nextTick callbacks share the native microtask queue (FIFO with
// queueMicrotask). Matching Node/Bun's nextTick-before-microtask priority
// would require an engine hook (e.g. JSC's onEachMicrotaskTick) - without it,
// reordering from JS breaks code that interleaves promise reactions.
let nativeQueueMicrotaskRef = null;

export function _enqueueNextTick(job) {
  (nativeQueueMicrotaskRef ?? queueMicrotask)(job);
}

function patchGlobalAsyncSchedulers() {
  const global = globalThis;
  if (typeof global.queueMicrotask === "function" && !global.queueMicrotask.__cottontailAsyncHooksPatched) {
    const nativeQueueMicrotask = global.queueMicrotask.bind(global);
    nativeQueueMicrotaskRef = nativeQueueMicrotask;
    global.queueMicrotask = function queueMicrotask(callback) {
      if (typeof callback !== "function") {
        throw nodeTypeError("ERR_INVALID_ARG_TYPE", 'The "callback" argument must be of type function.');
      }
      nativeQueueMicrotask(_wrapAsyncCallback(callback));
    };
    // The bundler suffixes identifiers when deduplicating; pin the name.
    Object.defineProperty(global.queueMicrotask, "name", { value: "queueMicrotask", configurable: true });
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
      // Resolving with a thenable defers to PromiseResolveThenableJob, which
      // calls `value.then` outside the current async context; wrap it so the
      // user's `then` observes the context active at Promise.resolve() time.
      const promise = nativeResolve(isNonPromiseThenable(value) ? contextWrappedThenable(value) : value);
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
          if (typeof callback === "function") {
            const callbackResult = runWithStorageSnapshot(snapshot, callback, this, [value]);
            // A returned thenable is adopted by the engine's
            // PromiseResolveThenableJob outside any context; wrap it so its
            // `then` re-enters this reaction's context (the attach-time
            // snapshot - the reaction's own stores are already restored by
            // the time the wrapper is built).
            if (isNonPromiseThenable(callbackResult)) {
              const originalThen = callbackResult.then;
              return {
                then: (...thenArgs) => runWithStorageSnapshot(snapshot, originalThen, callbackResult, thenArgs),
              };
            }
            return callbackResult;
          }
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
    this._disableGeneration = 0;
    this.name = options.name == null ? "" : String(options.name);
    this._defaultValue = Object.prototype.hasOwnProperty.call(options, "defaultValue") ? options.defaultValue : undefined;
    this._hasDefaultValue = Object.prototype.hasOwnProperty.call(options, "defaultValue");
    this._store = undefined;
    this._hasStore = false;
    storages.add(this);
  }

  disable() {
    this.enabled = false;
    // Invalidate every context snapshot captured before this point (Node's
    // disable() detaches the storage from all existing async contexts).
    this._disableGeneration += 1;
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
    const generation = this._disableGeneration;
    this.enabled = true;
    this._store = store;
    this._hasStore = true;
    storageStack.push(this);
    let restored = false;
    const restore = (onlyIfStillOurs) => {
      if (restored) return;
      restored = true;
      // disable() after this run started detaches the storage; don't undo it.
      if (this._disableGeneration !== generation) return;
      // The deferred (settle-time) restore must not clobber a store installed
      // by someone else in the meantime.
      if (onlyIfStillOurs && !(this._store === store && this._hasStore === true)) return;
      this._store = previous;
      this._hasStore = previousHasStore;
      this.enabled = previousEnabled;
    };
    let result;
    try {
      result = callback(...args);
    } catch (error) {
      storageStack.pop();
      restore(false);
      throw error;
    }
    storageStack.pop();
    // Async callback: JSC's `await` continuations bypass the patched
    // Promise.prototype.then, so a synchronous restore would clear the store
    // before the continuation observes it. Keep the store active until the
    // returned promise settles (engine-level async context propagation is not
    // reachable from the JSC C API). Attaching here - before the caller can
    // await - guarantees the restore reaction runs before the awaiter's.
    if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
      try {
        deferRestoreUntilSettled(result, () => restore(true));
        return result;
      } catch {
        // fall through to synchronous restore on scheduling failure
      }
    }
    restore(false);
    return result;
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
