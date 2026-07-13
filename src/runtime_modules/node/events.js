export const captureRejectionSymbol = Symbol.for("nodejs.rejection");
export const errorMonitor = Symbol("events.errorMonitor");
export const kMaxEventTargetListeners = Symbol("events.maxEventTargetListeners");
export const kMaxEventTargetListenersWarned = Symbol("events.maxEventTargetListenersWarned");
export let captureRejections = false;
export let defaultMaxListeners = 10;
export const usingDomains = false;

function eventMap(emitter) {
  if (!(emitter._events instanceof Map)) emitter._events = new Map();
  return emitter._events;
}

export default class EventEmitter {
  constructor(options = {}) {
    this._events = new Map();
    this._maxListeners = undefined;
    this.captureRejections = options.captureRejections ?? captureRejections;
  }

  on(name, handler) {
    if (typeof handler !== "function") throw new TypeError("listener must be a function");
    const events = eventMap(this);
    const handlers = events.get(name) ?? [];
    handlers.push(handler);
    events.set(name, handlers);
    return this;
  }

  addListener(name, handler) {
    return this.on(name, handler);
  }

  prependListener(name, handler) {
    if (typeof handler !== "function") throw new TypeError("listener must be a function");
    const events = eventMap(this);
    const handlers = events.get(name) ?? [];
    handlers.unshift(handler);
    events.set(name, handlers);
    return this;
  }

  once(name, handler) {
    const self = this;
    const wrapped = function (...args) {
      self.off(name, wrapped);
      Reflect.apply(handler, this, args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  }

  prependOnceListener(name, handler) {
    const self = this;
    const wrapped = function (...args) {
      self.off(name, wrapped);
      Reflect.apply(handler, this, args);
    };
    wrapped.listener = handler;
    return this.prependListener(name, wrapped);
  }

  off(name, handler) {
    const events = eventMap(this);
    const handlers = events.get(name);
    if (!handlers || handlers.length === 0) return this;
    let index = -1;
    for (let position = handlers.length - 1; position >= 0; position -= 1) {
      if (handlers[position] === handler || handlers[position].listener === handler) {
        index = position;
        break;
      }
    }
    if (index < 0) return this;
    const [removed] = handlers.splice(index, 1);
    if (handlers.length === 0) events.delete(name);
    if (events.has("removeListener")) {
      this.emit("removeListener", name, removed.listener ?? removed);
    }
    return this;
  }

  removeListener(name, handler) {
    return this.off(name, handler);
  }

  removeAllListeners(name = undefined) {
    const events = eventMap(this);
    if (!events.has("removeListener")) {
      if (name == null) events.clear();
      else events.delete(name);
      return this;
    }
    if (name == null) {
      // Remove everything except "removeListener" first so its meta-listeners
      // observe each removal, then remove those last (Node semantics).
      for (const key of [...events.keys()]) {
        if (key === "removeListener") continue;
        this.removeAllListeners(key);
      }
      this.removeAllListeners("removeListener");
      return this;
    }
    const handlers = events.get(name);
    if (!handlers) return this;
    for (let position = handlers.length - 1; position >= 0; position -= 1) {
      this.off(name, handlers[position]);
    }
    return this;
  }

  emit(name, ...args) {
    const events = eventMap(this);
    const handlers = [...(events.get(name) ?? [])];
    const monitors = name === "error" ? [...(events.get(errorMonitor) ?? [])] : [];
    for (const handler of monitors) Reflect.apply(handler, this, args);
    if (name === "error" && handlers.length === 0) throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
    for (const handler of handlers) {
      const result = Reflect.apply(handler, this, args);
      if ((this.captureRejections ?? captureRejections) && result && typeof result.then === "function") {
        result.catch((error) => this.emit("error", error));
      }
    }
    return handlers.length > 0;
  }

  listeners(name) {
    return [...(eventMap(this).get(name) ?? [])].map((item) => item.listener ?? item);
  }

  rawListeners(name) {
    return [...(eventMap(this).get(name) ?? [])];
  }

  listenerCount(name, listener = undefined) {
    const handlers = eventMap(this).get(name) ?? [];
    return listener == null ? handlers.length : handlers.filter((item) => item === listener || item.listener === listener).length;
  }

  eventNames() {
    return [...eventMap(this).keys()];
  }

  setMaxListeners(value) {
    this._maxListeners = Number(value);
    return this;
  }

  getMaxListeners() {
    return this._maxListeners ?? defaultMaxListeners;
  }
}

export { EventEmitter };

export class EventEmitterAsyncResource extends EventEmitter {
  constructor(options = {}) {
    super(options);
    this.asyncResource = options.asyncResource;
    this.asyncId = typeof this.asyncResource?.asyncId === "function" ? this.asyncResource.asyncId() : 0;
    this.triggerAsyncId = typeof this.asyncResource?.triggerAsyncId === "function" ? this.asyncResource.triggerAsyncId() : 0;
  }

  emitDestroy() {
    this.asyncResource?.emitDestroy?.();
  }
}

export function listenerCount(emitter, eventName) {
  return emitter?.listenerCount?.(eventName) ?? 0;
}

export function getEventListeners(emitter, eventName) {
  if (typeof emitter?.listeners === "function") return emitter.listeners(eventName);
  const eventTargetListeners = emitter?.__ctEventListeners?.get?.(String(eventName));
  if (eventTargetListeners) return eventTargetListeners.map((entry) => entry.listener ?? entry);
  if (eventName === "abort" && emitter?._listeners instanceof Set) return [...emitter._listeners];
  return [];
}

export function setMaxListeners(n, ...eventTargets) {
  for (const target of eventTargets) {
    if (typeof target?.setMaxListeners === "function") target.setMaxListeners(n);
    else if (target) target[kMaxEventTargetListeners] = Number(n);
  }
}

export function getMaxListeners(emitterOrTarget) {
  return emitterOrTarget?.getMaxListeners?.() ?? emitterOrTarget?.[kMaxEventTargetListeners] ?? defaultMaxListeners;
}

export function addAbortListener(signal, listener) {
  if (signal?.aborted) {
    queueMicrotask(listener);
    return { [Symbol.dispose]() {} };
  }
  signal?.addEventListener?.("abort", listener, { once: true });
  return {
    [Symbol.dispose]() {
      signal?.removeEventListener?.("abort", listener);
    },
  };
}

export function once(emitter, name, options = undefined) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      emitter.off?.(name, onEvent);
      emitter.off?.("error", onError);
      emitter.removeEventListener?.(name, onEvent);
      options?.signal?.removeEventListener?.("abort", onAbort);
    };
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      reject(options.signal.reason ?? new Error("AbortError"));
    };
    if (typeof emitter.once === "function") {
      emitter.once(name, onEvent);
    } else if (typeof emitter.addEventListener === "function") {
      emitter.addEventListener(name, onEvent, { once: true });
    }
    if (name !== "error") emitter.once?.("error", onError);
    options?.signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function makeAbortError(signal) {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  if (signal && "reason" in signal) error.cause = signal.reason;
  return error;
}

// Matches Node's lib/events.js `on()`: listeners (including the implicit
// "error" listener) are attached eagerly when on() is called, and abort/close
// tear everything down synchronously.
export function on(emitter, name, options = undefined) {
  const signal = options?.signal;
  if (signal?.aborted) throw makeAbortError(signal);

  const unconsumedEvents = [];
  const unconsumedPromises = [];
  let error = null;
  let finished = false;
  const removers = [];

  function addListener(target, event, handler) {
    if (typeof target.on === "function") {
      target.on(event, handler);
      removers.push(() => target.removeListener?.(event, handler) ?? target.off?.(event, handler));
    } else if (typeof target.addEventListener === "function") {
      const wrapped = (arg) => handler(arg);
      target.addEventListener(event, wrapped);
      removers.push(() => target.removeEventListener?.(event, wrapped));
    }
  }

  function eventHandler(...args) {
    if (unconsumedPromises.length > 0) unconsumedPromises.shift().resolve({ value: args, done: false });
    else unconsumedEvents.push(args);
  }

  function errorHandler(err) {
    if (unconsumedPromises.length > 0) unconsumedPromises.shift().reject(err);
    else error = err;
    closeHandler();
  }

  function closeHandler() {
    if (!finished) {
      finished = true;
      for (const remove of removers.splice(0)) remove();
      if (signal) signal.removeEventListener?.("abort", abortListener);
    }
    const doneResult = { value: undefined, done: true };
    while (unconsumedPromises.length > 0) unconsumedPromises.shift().resolve(doneResult);
    return Promise.resolve(doneResult);
  }

  function abortListener() {
    errorHandler(makeAbortError(signal));
  }

  addListener(emitter, name, eventHandler);
  if (name !== "error" && typeof emitter.on === "function") {
    addListener(emitter, "error", errorHandler);
  }
  const closeEvents = options?.close;
  if (closeEvents?.length) {
    for (const closeEvent of closeEvents) addListener(emitter, closeEvent, closeHandler);
  }
  signal?.addEventListener?.("abort", abortListener, { once: true });

  return {
    next() {
      if (unconsumedEvents.length > 0) {
        return Promise.resolve({ value: unconsumedEvents.shift(), done: false });
      }
      if (error) {
        const p = Promise.reject(error);
        error = null;
        return p;
      }
      if (finished) return closeHandler();
      return new Promise((resolve, reject) => {
        unconsumedPromises.push({ resolve, reject });
      });
    },
    return() {
      return closeHandler();
    },
    throw(err) {
      if (!err || !(err instanceof Error)) {
        throw new TypeError(`The "EventEmitter.AsyncIterator" property must be an instance of Error. Received ${typeof err}`);
      }
      errorHandler(err);
      return Promise.resolve({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

export function init() {
  return undefined;
}

Object.assign(EventEmitter, {
  EventEmitter,
  EventEmitterAsyncResource,
  addAbortListener,
  captureRejectionSymbol,
  captureRejections,
  defaultMaxListeners,
  errorMonitor,
  getEventListeners,
  getMaxListeners,
  init,
  kMaxEventTargetListeners,
  kMaxEventTargetListenersWarned,
  listenerCount,
  on,
  once,
  setMaxListeners,
  usingDomains,
});
