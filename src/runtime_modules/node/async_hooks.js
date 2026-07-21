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
const nextTickJobs = [];
let nextTickJobHead = 0;
let drainingNextTickJobs = false;
let nextTickDrainScheduled = false;
let nextTickPriorityArmed = true;
const promiseAsyncIds = new WeakMap();
const gcTrackedAsyncResourceIds = new Set();
const destroyedAsyncResourceIds = new Set();

function syncNextTickHostState() {
  globalThis.cottontail?.nextTickState?.(
    nextTickJobHead < nextTickJobs.length,
    nextTickPriorityArmed,
  );
}

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

function napiAsyncContextResource(context, nativeResource = undefined) {
  if (context.nativeWeakResource) {
    if (nativeResource !== undefined) return nativeResource;
    context.nativeWeakResource = false;
    context.externallyManaged = false;
    context.resource = {};
    return context.resource;
  }
  if (!context.externallyManaged) return context.resource;
  const resource = context.resourceRef?.deref();
  if (resource !== undefined) return resource;
  context.externallyManaged = false;
  context.resourceRef = null;
  context.resource = {};
  return context.resource;
}

function napiAsyncInit(resource, type, nativeWeakResource = false) {
  const externallyManaged = resource !== undefined && resource !== null;
  const resourceObject = externallyManaged ? Object(resource) : {};
  const context = {
    asyncId: ++nextAsyncId,
    destroyed: false,
    externallyManaged,
    nativeWeakResource: externallyManaged && nativeWeakResource,
    resource: externallyManaged ? null : resourceObject,
    resourceRef: externallyManaged && !nativeWeakResource ? new WeakRef(resourceObject) : null,
    storageSnapshot: captureStorageSnapshot(),
    triggerAsyncId: currentAsyncId,
  };
  emitHook("init", context.asyncId, String(type), context.triggerAsyncId, resourceObject);
  return context;
}

function napiAsyncDestroy(context) {
  if (!context || context.destroyed) return;
  context.destroyed = true;
  emitHook("destroy", context.asyncId);
}

function napiCallbackDomain(context, receiver, nativeResource = undefined) {
  const resource = context ? napiAsyncContextResource(context, nativeResource) : receiver;
  const domain = resource?.domain;
  return domain && typeof domain.enter === "function" && typeof domain.exit === "function"
    ? domain
    : null;
}

function pushNapiStorageSnapshot(snapshot) {
  const frames = [];
  const context = { frames, dependencies: new Set() };
  for (const entry of snapshot ?? []) {
    const [storage, enabled, store, hasStore, generation] = entry;
    if ((storage._disableGeneration ?? 0) !== generation) continue;
    const frame = {
      storage,
      enabled,
      store,
      hasStore,
      generation,
      prevEnabled: storage.enabled,
      prevStore: storage._store,
      prevHasStore: storage._hasStore,
      prevHiddenContext: storage._hiddenContext,
    };
    frames.push(frame);
    storage.enabled = enabled;
    storage._store = store;
    storage._hasStore = hasStore;
    storage._hiddenContext = null;
    storageStack.push({ context, frame });
  }
  return { context, frames };
}

function popNapiStorageSnapshot(token) {
  const { frames } = token;
  if (frames.length > 0) storageStack.splice(-frames.length, frames.length);
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    const { storage } = frame;
    if ((storage._disableGeneration ?? 0) !== frame.generation) continue;
    if (storage.enabled !== frame.enabled || storage._store !== frame.store ||
        storage._hasStore !== frame.hasStore || storage._hiddenContext != null) continue;
    storage.enabled = frame.prevEnabled;
    storage._store = frame.prevStore;
    storage._hasStore = frame.prevHasStore;
    storage._hiddenContext = frame.prevHiddenContext;
  }
}

function enterNapiCallbackScope(context, nativeResource = undefined) {
  if (!context || context.destroyed) throw new TypeError("Invalid N-API async context");
  const token = {
    closed: false,
    context,
    domain: null,
    previousAsyncId: currentAsyncId,
    previousResource: currentResource,
    previousTriggerAsyncId: currentTriggerAsyncId,
    storage: null,
  };
  currentAsyncId = context.asyncId;
  currentTriggerAsyncId = context.triggerAsyncId;
  currentResource = napiAsyncContextResource(context, nativeResource);
  continuationResource = null;
  token.storage = pushNapiStorageSnapshot(context.storageSnapshot);
  try {
    emitHook("before", context.asyncId);
    token.domain = napiCallbackDomain(context, null, nativeResource);
    token.domain?.enter();
    return token;
  } catch (error) {
    popNapiStorageSnapshot(token.storage);
    currentAsyncId = token.previousAsyncId;
    currentTriggerAsyncId = token.previousTriggerAsyncId;
    currentResource = token.previousResource;
    throw error;
  }
}

function leaveNapiCallbackScope(token, failed = false) {
  if (!token || token.closed) throw new TypeError("Invalid N-API callback scope");
  token.closed = true;
  try {
    if (!failed) {
      token.domain?.exit();
      emitHook("after", token.context.asyncId);
    }
  } finally {
    popNapiStorageSnapshot(token.storage);
    currentAsyncId = token.previousAsyncId;
    currentTriggerAsyncId = token.previousTriggerAsyncId;
    currentResource = token.previousResource;
  }
}

function napiMakeCallback(context, receiver, callback, args, nativeResource = undefined) {
  if (typeof callback !== "function") throw new TypeError("N-API callback must be a function");
  if (context?.destroyed) throw new TypeError("Invalid N-API async context");
  const previousAsyncId = currentAsyncId;
  const previousTriggerAsyncId = currentTriggerAsyncId;
  const previousResource = currentResource;
  const domain = napiCallbackDomain(context, receiver, nativeResource);
  let succeeded = false;
  if (context) {
    currentAsyncId = context.asyncId;
    currentTriggerAsyncId = context.triggerAsyncId;
    currentResource = napiAsyncContextResource(context, nativeResource);
    continuationResource = null;
  }
  try {
    if (context) emitHook("before", context.asyncId);
    domain?.enter();
    const invoke = () => Reflect.apply(callback, receiver, Array.from(args ?? []));
    const result = context
      ? runWithStorageSnapshot(context.storageSnapshot, invoke, undefined, [])
      : invoke();
    succeeded = true;
    return result;
  } finally {
    if (succeeded) {
      domain?.exit();
      if (context) emitHook("after", context.asyncId);
    }
    currentAsyncId = previousAsyncId;
    currentTriggerAsyncId = previousTriggerAsyncId;
    currentResource = previousResource;
  }
}

for (const [name, value] of [
  ["__cottontailNapiAsyncInit", napiAsyncInit],
  ["__cottontailNapiAsyncDestroy", napiAsyncDestroy],
  ["__cottontailNapiMakeCallback", napiMakeCallback],
  ["__cottontailNapiOpenCallbackScope", enterNapiCallbackScope],
  ["__cottontailNapiCloseCallbackScope", leaveNapiCallbackScope],
]) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
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
const deferredStorageContexts = [];

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") &&
    typeof value.then === "function";
}

function isPromise(value) {
  return typeof Promise === "function" && value instanceof Promise;
}

function registerContextDependency(context, thenable) {
  if (!isThenable(thenable)) return false;
  if (context.dependencies.has(thenable)) return false;
  context.dependencies.add(thenable);
  if (context.deferredActive) attachDeferredDependency(context, thenable);
  return true;
}

export function _registerAsyncContextDependency(thenable) {
  if (!isThenable(thenable)) return false;
  if (storageStack.length > 0) {
    return registerContextDependency(storageStack[storageStack.length - 1].context, thenable);
  }
  for (let i = deferredStorageContexts.length - 1; i >= 0; i--) {
    const context = deferredStorageContexts[i];
    if (context.frames.some((frame) => frame.storage.enabled === frame.enabled &&
      frame.storage._store === frame.store && frame.storage._hasStore === frame.hasStore)) {
      return registerContextDependency(context, thenable);
    }
  }
  return false;
}

function finishDeferredContext(context) {
  if (!context.deferredActive || context.deferredPending !== 0 || context.deferredAttaching) return;
  context.deferredActive = false;
  const index = deferredStorageContexts.lastIndexOf(context);
  if (index >= 0) deferredStorageContexts.splice(index, 1);
  context.onDeferredSettled();
}

function attachDeferredDependency(context, dependency) {
  context.deferredPending += 1;
  let finished = false;
  const settled = () => {
    if (finished) return;
    finished = true;
    context.dependencies.delete(dependency);
    context.deferredPending -= 1;
    finishDeferredContext(context);
  };
  try {
    deferRestoreUntilSettled(dependency, settled);
  } catch {
    settled();
  }
}

function activateDeferredContext(context, onSettled) {
  context.deferredActive = true;
  context.deferredPending = 0;
  context.deferredAttaching = true;
  context.onDeferredSettled = onSettled;
  deferredStorageContexts.push(context);
  for (const dependency of context.dependencies) attachDeferredDependency(context, dependency);
  context.deferredAttaching = false;
  finishDeferredContext(context);
}

function sameStorageState(left, right) {
  return left.storage === right.storage && left.store === right.store &&
    left.hasStore === right.hasStore && left.enabled === right.enabled &&
    left.generation === right.generation;
}

function findParentStorageEntry(frame) {
  for (let i = storageStack.length - 1; i >= 0; i--) {
    if (storageStack[i].frame.storage === frame.storage) return storageStack[i];
  }
  for (let i = deferredStorageContexts.length - 1; i >= 0; i--) {
    const context = deferredStorageContexts[i];
    const parentFrame = context.frames.find((candidate) => candidate.storage === frame.storage && !candidate.restored);
    if (parentFrame) return { context, frame: parentFrame };
  }
  return null;
}

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
      generation,
      prevEnabled: storage.enabled,
      prevStore: storage._store,
      prevHasStore: storage._hasStore,
      prevHiddenContext: storage._hiddenContext,
      prevVisibleStore: storage.getStore(),
      hiddenContext: null,
    });
    storage.enabled = enabled;
    storage._store = store;
    storage._hasStore = hasStore;
    storage._hiddenContext = null;
  }
  const restore = (restoreFrames, onlyIfStillOurs) => {
    for (const frame of restoreFrames) {
      if (frame.restored) continue;
      frame.restored = true;
      // Only undo values this frame installed: an inner AsyncLocalStorage.run
      // with an async callback (or a nested wrapped callback) may have opened
      // a deferred context window that must survive this frame's exit; its
      // own settle handler restores it.
      const { storage } = frame;
      const ownsHiddenContext = frame.hiddenContext == null
        ? storage._hiddenContext == null
        : storage._hiddenContext == null || storage._hiddenContext === frame.hiddenContext;
      if (!onlyIfStillOurs || ((storage._disableGeneration ?? 0) === frame.generation &&
        storage._store === frame.store && storage._hasStore === frame.hasStore &&
        storage.enabled === frame.enabled && ownsHiddenContext)) {
        storage.enabled = frame.prevEnabled;
        storage._store = frame.prevStore;
        storage._hasStore = frame.prevHasStore;
        storage._hiddenContext = frame.prevHiddenContext;
      }
    }
  };
  const context = { frames, dependencies: new Set() };
  for (const frame of frames) storageStack.push({ context, frame });
  let result;
  try {
    result = fn.apply(thisArg, args);
  } catch (error) {
    storageStack.length -= frames.length;
    restore(frames, true);
    throw error;
  }
  storageStack.length -= frames.length;
  if (isPromise(result)) registerContextDependency(context, result);
  const dependencies = [...context.dependencies];
  if (frames.length > 0 && dependencies.length > 0) {
    const adoptedFrames = new Set();
    for (const frame of frames) {
      const parent = findParentStorageEntry(frame);
      if (parent != null) {
        for (const dependency of dependencies) registerContextDependency(parent.context, dependency);
        if (sameStorageState(parent.frame, frame)) adoptedFrames.add(frame);
      }
    }
    restore([...adoptedFrames], true);
    const ownedFrames = frames.filter((frame) => !adoptedFrames.has(frame));
    if (ownedFrames.length === 0) return result;
    let deferredPending = true;
    for (const frame of ownedFrames) {
      const { storage } = frame;
      if (storage._store !== frame.store || storage._hasStore !== frame.hasStore ||
        storage.enabled !== frame.enabled || storage._hiddenContext != null) continue;
      frame.hiddenContext = { active: true, value: frame.prevVisibleStore };
      storage._hiddenContext = frame.hiddenContext;
    }
    (nativeQueueMicrotaskRef ?? queueMicrotask)(() => {
      if (!deferredPending) return;
      for (const frame of ownedFrames) {
        if (frame.hiddenContext == null) continue;
        frame.hiddenContext.active = false;
        if (frame.storage._hiddenContext === frame.hiddenContext) frame.storage._hiddenContext = null;
      }
    });
    activateDeferredContext(context, () => {
      deferredPending = false;
      for (const frame of ownedFrames) {
        if (frame.hiddenContext != null && frame.storage._hiddenContext === frame.hiddenContext) {
          frame.storage._hiddenContext = null;
        }
      }
      restore(ownedFrames, true);
    });
    return result;
  }
  restore(frames, true);
  return result;
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

export function _wrapAsyncCallback(callback, options = undefined) {
  if (typeof callback !== "function") return callback;
  const drainJobs = options?.drainJobs !== false;
  const existing = callback[asyncWrappedCallback];
  if (existing) {
    if (existing.drainJobs === drainJobs || typeof existing.callback !== "function") return callback;
    callback = existing.callback;
  }
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
      const callbackThis = this;
      const result = runWithStorageSnapshot(snapshot, () => {
        const callbackResult = callback.apply(callbackThis, args);
        // JSC does not expose its async-context hooks through the public C API.
        // Drain reactions before leaving the captured snapshot so promises
        // resolved by a synchronous host callback inherit that callback's store.
        if (drainJobs && !drainingWrappedCallbackJobs && typeof globalThis.cottontail?.drainJobs === "function") {
          drainingWrappedCallbackJobs = true;
          try {
            globalThis.cottontail.drainJobs();
          } finally {
            drainingWrappedCallbackJobs = false;
          }
        }
        return callbackResult;
      }, undefined, []);
      if (snapshotResource !== defaultExecutionResource) continuationResource = snapshotResource;
      return result;
    } finally {
      currentAsyncId = previousAsyncId;
      currentTriggerAsyncId = previousTriggerAsyncId;
      currentResource = previousResource;
    }
  };
  Object.defineProperty(wrapped, asyncWrappedCallback, {
    __proto__: null,
    value: { callback, drainJobs },
  });
  return wrapped;
}

Object.defineProperty(globalThis, "__cottontailWrapAsyncCallback", {
  value: _wrapAsyncCallback,
  configurable: true,
  writable: true,
});

let nativeQueueMicrotaskRef = null;

function drainNextTickJobs() {
  if (drainingNextTickJobs || nextTickJobHead >= nextTickJobs.length) return 0;
  drainingNextTickJobs = true;
  nextTickDrainScheduled = false;
  nextTickPriorityArmed = false;
  const start = nextTickJobHead;
  try {
    while (nextTickJobHead < nextTickJobs.length) {
      nextTickJobs[nextTickJobHead++]();
    }
    return nextTickJobHead - start;
  } finally {
    if (nextTickJobHead > 0) nextTickJobs.splice(0, nextTickJobHead);
    nextTickJobHead = 0;
    drainingNextTickJobs = false;
    syncNextTickHostState();
  }
}

function drainNextTicksBeforeMicrotask() {
  if (nextTickPriorityArmed && nextTickJobHead < nextTickJobs.length) drainNextTickJobs();
}

function nextTickMicrotaskCheckpoint() {
  nextTickDrainScheduled = false;
  drainNextTicksBeforeMicrotask();
}

export function _enqueueNextTick(job) {
  const wasEmpty = nextTickJobHead >= nextTickJobs.length;
  nextTickJobs.push(job);
  if (wasEmpty) syncNextTickHostState();
  if (!nextTickPriorityArmed || nextTickDrainScheduled || drainingNextTickJobs) return;
  nextTickDrainScheduled = true;
  (nativeQueueMicrotaskRef ?? queueMicrotask)(nextTickMicrotaskCheckpoint);
}

Object.defineProperty(globalThis, "__cottontailDrainNextTicks", {
  value(beginTurn = false) {
    const drained = drainNextTickJobs();
    if (beginTurn) nextTickPriorityArmed = true;
    syncNextTickHostState();
    return drained;
  },
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, "__cottontailBeforeMicrotask", {
  value: drainNextTicksBeforeMicrotask,
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, "__cottontailBeginNextTickTurn", {
  value() {
    drainNextTickJobs();
    nextTickPriorityArmed = true;
    syncNextTickHostState();
  },
  configurable: true,
  writable: true,
});

function wrapAsyncContextCallbacks(value, callbackNames) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const name of callbackNames) {
    let callback;
    try {
      callback = value[name];
    } catch {
      continue;
    }
    if (typeof callback !== "function") continue;
    descriptors[name] = {
      value: _wrapAsyncCallback(function(...args) {
        return callback.apply(value, args);
      }),
      writable: true,
      enumerable: descriptors[name]?.enumerable ?? true,
      configurable: true,
    };
  }
  return Object.create(Object.getPrototypeOf(value), descriptors);
}

function patchAsyncContextConstructor(global, name, callbackGroups) {
  const nativeConstructor = global[name];
  if (typeof nativeConstructor !== "function" || nativeConstructor.__cottontailAsyncHooksPatched) return;
  let wrappedConstructor;
  wrappedConstructor = new Proxy(nativeConstructor, {
    construct(target, args, newTarget) {
      const wrappedArgs = Array.from(args);
      for (const [index, callbackNames] of callbackGroups) {
        if (index < wrappedArgs.length) {
          wrappedArgs[index] = wrapAsyncContextCallbacks(wrappedArgs[index], callbackNames);
        }
      }
      return Reflect.construct(target, wrappedArgs, newTarget === wrappedConstructor ? target : newTarget);
    },
  });
  Object.defineProperty(nativeConstructor, "__cottontailAsyncHooksPatched", { value: true, configurable: true });
  try {
    Object.defineProperty(nativeConstructor.prototype, "constructor", {
      value: wrappedConstructor,
      writable: true,
      configurable: true,
    });
  } catch {}
  Object.defineProperty(global, name, {
    value: wrappedConstructor,
    writable: true,
    configurable: true,
  });
}

export function _patchAsyncContextGlobals() {
  const global = globalThis;
  patchAsyncContextConstructor(global, "ReadableStream", [
    [0, ["start", "pull", "cancel"]],
    [1, ["size"]],
  ]);
  patchAsyncContextConstructor(global, "WritableStream", [
    [0, ["start", "write", "close", "abort"]],
    [1, ["size"]],
  ]);
  patchAsyncContextConstructor(global, "TransformStream", [
    [0, ["start", "transform", "flush", "cancel"]],
    [1, ["size"]],
    [2, ["size"]],
  ]);
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
      const wrapped = _wrapAsyncCallback(callback);
      nativeQueueMicrotask(function runQueuedMicrotask() {
        drainNextTicksBeforeMicrotask();
        return wrapped();
      });
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
        drainNextTicksBeforeMicrotask();
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
  _patchAsyncContextGlobals();
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
    this._hiddenContext = null;
    storages.add(this);
  }

  disable() {
    this.enabled = false;
    // Invalidate every context snapshot captured before this point (Node's
    // disable() detaches the storage from all existing async contexts).
    this._disableGeneration += 1;
    this._store = undefined;
    this._hasStore = false;
    this._hiddenContext = null;
  }

  getStore() {
    if (this._hiddenContext?.active) return this._hiddenContext.value;
    if (!this.enabled) return undefined;
    return this._hasStore ? this._store : (this._hasDefaultValue ? this._defaultValue : undefined);
  }

  enterWith(store) {
    this._hiddenContext = null;
    this.enabled = true;
    this._store = store;
    this._hasStore = true;
  }

  run(store, callback, ...args) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const previous = this._store;
    const previousHasStore = this._hasStore;
    const previousEnabled = this.enabled;
    const previousHiddenContext = this._hiddenContext;
    const previousVisibleStore = this.getStore();
    const generation = this._disableGeneration;
    this._hiddenContext = null;
    this.enabled = true;
    this._store = store;
    this._hasStore = true;
    const context = {
      dependencies: new Set(),
      frames: [{
        storage: this,
        enabled: true,
        store,
        hasStore: true,
        generation,
      }],
    };
    storageStack.push({ context, frame: context.frames[0] });
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
      this._hiddenContext = previousHiddenContext;
    };
    let deferredPending = false;
    const hiddenContext = { active: false, value: previousVisibleStore };
    (nativeQueueMicrotaskRef ?? queueMicrotask)(() => {
      if (!deferredPending) return;
      hiddenContext.active = false;
      if (this._hiddenContext === hiddenContext) this._hiddenContext = null;
    });
    let result;
    try {
      result = callback(...args);
    } catch (error) {
      storageStack.pop();
      restore(false);
      throw error;
    }
    storageStack.pop();
    // JSC's await continuations bypass Promise.prototype.then. Keep the
    // continuation's store installed, but mask it from synchronous parent
    // code until the microtask queued before the first continuation runs.
    // The settle reaction is attached before the caller can await, so it
    // restores the parent before the caller resumes.
    if (isPromise(result)) registerContextDependency(context, result);
    const dependencies = [...context.dependencies];
    if (dependencies.length > 0) {
      deferredPending = true;
      hiddenContext.active = true;
      this._hiddenContext = hiddenContext;
      activateDeferredContext(context, () => {
        deferredPending = false;
        if (this._hiddenContext === hiddenContext) this._hiddenContext = null;
        restore(true);
      });
      return result;
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
