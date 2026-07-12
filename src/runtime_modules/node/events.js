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
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.on(name, wrapped);
  }

  prependOnceListener(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    wrapped.listener = handler;
    return this.prependListener(name, wrapped);
  }

  off(name, handler) {
    const events = eventMap(this);
    const handlers = events.get(name) ?? [];
    events.set(name, handlers.filter((item) => item !== handler && item.listener !== handler));
    if ((events.get(name) ?? []).length === 0) events.delete(name);
    return this;
  }

  removeListener(name, handler) {
    return this.off(name, handler);
  }

  removeAllListeners(name = undefined) {
    const events = eventMap(this);
    if (name == null) events.clear();
    else events.delete(name);
    return this;
  }

  emit(name, ...args) {
    const events = eventMap(this);
    const handlers = [...(events.get(name) ?? [])];
    const monitors = name === "error" ? [...(events.get(errorMonitor) ?? [])] : [];
    for (const handler of monitors) handler(...args);
    if (name === "error" && handlers.length === 0) throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
    for (const handler of handlers) {
      const result = handler(...args);
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

async function *eventIterator(emitter, name, options = undefined) {
  const queue = [];
  let done = false;
  let notify = null;
  const listener = (...args) => {
    queue.push(args);
    notify?.();
  };
  const abort = () => {
    done = true;
    notify?.();
  };
  emitter.on?.(name, listener);
  options?.signal?.addEventListener?.("abort", abort, { once: true });
  try {
    while (!done) {
      if (queue.length === 0) await new Promise((resolve) => { notify = resolve; });
      notify = null;
      while (queue.length > 0) yield queue.shift();
    }
  } finally {
    emitter.off?.(name, listener);
    options?.signal?.removeEventListener?.("abort", abort);
  }
}

export function on(emitter, name, options = undefined) {
  return eventIterator(emitter, name, options);
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
