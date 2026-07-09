export const captureRejectionSymbol = Symbol.for("nodejs.rejection");
export const errorMonitor = Symbol("events.errorMonitor");
export const kMaxEventTargetListeners = Symbol("events.maxEventTargetListeners");
export const kMaxEventTargetListenersWarned = Symbol("events.maxEventTargetListenersWarned");
export let captureRejections = false;
export let defaultMaxListeners = 10;
export const usingDomains = false;

export default class EventEmitter {
  constructor(options = {}) {
    this._events = new Map();
    this._maxListeners = undefined;
    this.captureRejections = options.captureRejections ?? captureRejections;
  }

  on(name, handler) {
    if (typeof handler !== "function") throw new TypeError("listener must be a function");
    const handlers = this._events.get(name) ?? [];
    handlers.push(handler);
    this._events.set(name, handlers);
    return this;
  }

  addListener(name, handler) {
    return this.on(name, handler);
  }

  prependListener(name, handler) {
    if (typeof handler !== "function") throw new TypeError("listener must be a function");
    const handlers = this._events.get(name) ?? [];
    handlers.unshift(handler);
    this._events.set(name, handlers);
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
    const handlers = this._events.get(name) ?? [];
    this._events.set(name, handlers.filter((item) => item !== handler && item.listener !== handler));
    if ((this._events.get(name) ?? []).length === 0) this._events.delete(name);
    return this;
  }

  removeListener(name, handler) {
    return this.off(name, handler);
  }

  removeAllListeners(name = undefined) {
    if (name == null) this._events.clear();
    else this._events.delete(name);
    return this;
  }

  emit(name, ...args) {
    const handlers = [...(this._events.get(name) ?? [])];
    const monitors = name === "error" ? [...(this._events.get(errorMonitor) ?? [])] : [];
    for (const handler of monitors) handler(...args);
    if (name === "error" && handlers.length === 0) throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
    for (const handler of handlers) {
      const result = handler(...args);
      if (this.captureRejections && result && typeof result.then === "function") {
        result.catch((error) => this.emit("error", error));
      }
    }
    return handlers.length > 0;
  }

  listeners(name) {
    return [...(this._events.get(name) ?? [])].map((item) => item.listener ?? item);
  }

  rawListeners(name) {
    return [...(this._events.get(name) ?? [])];
  }

  listenerCount(name, listener = undefined) {
    const handlers = this._events.get(name) ?? [];
    return listener == null ? handlers.length : handlers.filter((item) => item === listener || item.listener === listener).length;
  }

  eventNames() {
    return [...this._events.keys()];
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
    emitter.once?.(name, onEvent);
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
