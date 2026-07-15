import { AsyncResource } from "./async_hooks.js";

export const captureRejectionSymbol = Symbol.for("nodejs.rejection");
export const errorMonitor = Symbol("events.errorMonitor");
export const kMaxEventTargetListeners = Symbol("events.maxEventTargetListeners");
export const kMaxEventTargetListenersWarned = Symbol("events.maxEventTargetListenersWarned");
export let captureRejections = false;
export let defaultMaxListeners = 10;
export const usingDomains = false;

const kCapture = Symbol("kCapture");
const kFirstEventParam = Symbol.for("nodejs.kFirstEventParam");

function checkListener(listener) {
  if (typeof listener !== "function") {
    const error = new TypeError(
      `The "listener" argument must be of type function. Received ${listener === null ? "null" : typeof listener}`,
    );
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
}

// Node-style function constructor: callable via EventEmitter.call(this) from
// legacy function subclasses, and usable with `class X extends EventEmitter`.
function EventEmitter(opts) {
  EventEmitter.init.call(this, opts);
}
export default EventEmitter;
export { EventEmitter };

EventEmitter.EventEmitter = EventEmitter;

// Matches Node: backing storage defaults live on the prototype and are
// enumerable so `Object.assign(foo, EventEmitter.prototype)` clones them.
EventEmitter.prototype._events = undefined;
EventEmitter.prototype._eventsCount = 0;
EventEmitter.prototype._maxListeners = undefined;

Object.defineProperty(EventEmitter.prototype, kCapture, {
  value: false,
  writable: true,
  enumerable: false,
});

Object.defineProperty(EventEmitter, "captureRejections", {
  get() {
    return EventEmitter.prototype[kCapture];
  },
  set(value) {
    EventEmitter.prototype[kCapture] = Boolean(value);
  },
  enumerable: true,
  configurable: true,
});

Object.defineProperty(EventEmitter, "defaultMaxListeners", {
  get() {
    return defaultMaxListeners;
  },
  set(value) {
    if (typeof value !== "number" || value < 0 || Number.isNaN(value)) {
      const error = new RangeError(
        `The value of "defaultMaxListeners" is out of range. It must be a non-negative number. Received ${value}`,
      );
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    defaultMaxListeners = value;
  },
  enumerable: true,
  configurable: true,
});

export function init(opts) {
  if (this._events === undefined || this._events === Object.getPrototypeOf(this)?._events) {
    this._events = { __proto__: null };
    this._eventsCount = 0;
  }
  this._maxListeners = this._maxListeners || undefined;
  if (opts?.captureRejections) {
    this[kCapture] = Boolean(opts.captureRejections);
  } else {
    this[kCapture] = EventEmitter.prototype[kCapture];
  }
}
EventEmitter.init = init;

function _getMaxListeners(that) {
  return that._maxListeners === undefined ? EventEmitter.defaultMaxListeners : that._maxListeners;
}

EventEmitter.prototype.setMaxListeners = function setMaxListeners(n) {
  n = Number(n);
  if (typeof n !== "number" || n < 0 || Number.isNaN(n)) {
    const error = new RangeError(
      `The value of "n" is out of range. It must be a non-negative number. Received ${n}`,
    );
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.getMaxListeners = function getMaxListeners() {
  return _getMaxListeners(this);
};

function addCatch(that, promise, type, args) {
  if (!that[kCapture]) return;
  try {
    const then = promise.then;
    if (typeof then === "function") {
      then.call(promise, undefined, function (err) {
        const schedule = globalThis.process?.nextTick ?? queueMicrotask;
        schedule(() => emitUnhandledRejectionOrErr(that, err, type, args));
      });
    }
  } catch (err) {
    that.emit("error", err);
  }
}

function emitUnhandledRejectionOrErr(ee, err, type, args) {
  if (typeof ee[captureRejectionSymbol] === "function") {
    ee[captureRejectionSymbol](err, type, ...args);
  } else {
    // Disable capture-rejections while producing the error event to avoid
    // infinite recursion when the 'error' handler itself rejects.
    const prev = ee[kCapture];
    try {
      ee[kCapture] = false;
      ee.emit("error", err);
    } finally {
      ee[kCapture] = prev;
    }
  }
}

EventEmitter.prototype.emit = function emit(type, ...args) {
  let doError = type === "error";

  const events = this._events;
  if (events !== undefined) {
    if (doError && events[errorMonitor] !== undefined) this.emit(errorMonitor, ...args);
    doError = doError && events.error === undefined;
  } else if (!doError) {
    return false;
  }

  if (doError) {
    let er;
    if (args.length > 0) er = args[0];
    if (er instanceof Error) throw er; // Unhandled 'error' event
    let stringified;
    if (er === undefined) stringified = undefined;
    else if (typeof er === "string") stringified = `'${er}'`;
    else {
      try {
        stringified = String(er);
      } catch {
        stringified = "";
      }
    }
    const err = new Error(`Unhandled error.${stringified === undefined ? "" : ` (${stringified})`}`);
    err.code = "ERR_UNHANDLED_ERROR";
    err.context = er;
    throw err;
  }

  const handler = events[type];
  if (handler === undefined) return false;

  if (typeof handler === "function") {
    const result = handler.apply(this, args);
    if (result !== undefined && result !== null) addCatch(this, result, type, args);
  } else {
    const len = handler.length;
    const listeners = handler.slice();
    for (let i = 0; i < len; ++i) {
      const result = listeners[i].apply(this, args);
      if (result !== undefined && result !== null) addCatch(this, result, type, args);
    }
  }

  return true;
};

function _addListener(target, type, listener, prepend) {
  checkListener(listener);

  let events = target._events;
  let existing;
  if (events === undefined) {
    events = target._events = { __proto__: null };
    target._eventsCount = 0;
  } else {
    // Emit "newListener" first so that listeners on "newListener" don't see
    // the listener being added.
    if (events.newListener !== undefined) {
      target.emit("newListener", type, listener.listener ?? listener);
      events = target._events;
    }
    existing = events[type];
  }

  if (existing === undefined) {
    events[type] = listener;
    ++target._eventsCount;
  } else {
    if (typeof existing === "function") {
      existing = events[type] = prepend ? [listener, existing] : [existing, listener];
    } else if (prepend) {
      existing.unshift(listener);
    } else {
      existing.push(listener);
    }

    const m = _getMaxListeners(target);
    if (m > 0 && existing.length > m && !existing.warned) {
      existing.warned = true;
      const w = new Error(
        `Possible EventEmitter memory leak detected. ${existing.length} ${String(type)} listeners added to ${
          target.constructor?.name ?? "EventEmitter"
        }. MaxListeners is ${m}. Use emitter.setMaxListeners() to increase limit`,
      );
      w.name = "MaxListenersExceededWarning";
      w.emitter = target;
      w.type = type;
      w.count = existing.length;
      try {
        globalThis.process?.emitWarning?.(w);
      } catch {}
    }
  }

  return target;
}

EventEmitter.prototype.addListener = function addListener(type, listener) {
  return _addListener(this, type, listener, false);
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.prependListener = function prependListener(type, listener) {
  return _addListener(this, type, listener, true);
};

function onceWrapper(...args) {
  if (!this.fired) {
    this.target.removeListener(this.type, this.wrapFn);
    this.fired = true;
    return this.listener.apply(this.target, args);
  }
}

function _onceWrap(target, type, listener) {
  const state = { fired: false, wrapFn: undefined, target, type, listener };
  const wrapped = onceWrapper.bind(state);
  wrapped.listener = listener;
  state.wrapFn = wrapped;
  return wrapped;
}

EventEmitter.prototype.once = function once(type, listener) {
  checkListener(listener);
  this.on(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.prependOnceListener = function prependOnceListener(type, listener) {
  checkListener(listener);
  this.prependListener(type, _onceWrap(this, type, listener));
  return this;
};

EventEmitter.prototype.removeListener = function removeListener(type, listener) {
  checkListener(listener);

  const events = this._events;
  if (events === undefined) return this;

  const list = events[type];
  if (list === undefined) return this;

  if (list === listener || list.listener === listener) {
    if (--this._eventsCount === 0) this._events = { __proto__: null };
    else {
      delete events[type];
      if (events.removeListener) this.emit("removeListener", type, list.listener || listener);
    }
  } else if (typeof list !== "function") {
    let position = -1;
    let originalListener;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === listener || list[i].listener === listener) {
        originalListener = list[i].listener;
        position = i;
        break;
      }
    }
    if (position < 0) return this;

    if (position === 0) list.shift();
    else list.splice(position, 1);

    if (list.length === 1) events[type] = list[0];

    if (events.removeListener !== undefined) {
      this.emit("removeListener", type, originalListener || listener);
    }
  }

  return this;
};

EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function removeAllListeners(type) {
  const events = this._events;
  if (events === undefined) return this;

  // Not listening for removeListener, no need to emit
  if (events.removeListener === undefined) {
    if (arguments.length === 0) {
      this._events = { __proto__: null };
      this._eventsCount = 0;
    } else if (events[type] !== undefined) {
      if (--this._eventsCount === 0) this._events = { __proto__: null };
      else delete events[type];
    }
    return this;
  }

  // Emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (const key of Reflect.ownKeys(events)) {
      if (key === "removeListener") continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners("removeListener");
    this._events = { __proto__: null };
    this._eventsCount = 0;
    return this;
  }

  const listeners = events[type];
  if (typeof listeners === "function") {
    this.removeListener(type, listeners);
  } else if (listeners !== undefined) {
    // LIFO order
    for (let i = listeners.length - 1; i >= 0; i--) {
      this.removeListener(type, listeners[i]);
    }
  }

  return this;
};

function unwrapListeners(arr) {
  const ret = new Array(arr.length);
  for (let i = 0; i < ret.length; ++i) ret[i] = arr[i].listener ?? arr[i];
  return ret;
}

EventEmitter.prototype.listeners = function listeners(type) {
  const events = this._events;
  if (events === undefined) return [];
  const evlistener = events[type];
  if (evlistener === undefined) return [];
  if (typeof evlistener === "function") return [evlistener.listener ?? evlistener];
  return unwrapListeners(evlistener);
};

EventEmitter.prototype.rawListeners = function rawListeners(type) {
  const events = this._events;
  if (events === undefined) return [];
  const evlistener = events[type];
  if (evlistener === undefined) return [];
  if (typeof evlistener === "function") return [evlistener];
  return evlistener.slice();
};

EventEmitter.prototype.listenerCount = function listenerCount(type, listener) {
  const events = this._events;
  if (events !== undefined) {
    const evlistener = events[type];
    if (typeof evlistener === "function") {
      if (listener != null) {
        return listener === evlistener || listener === evlistener.listener ? 1 : 0;
      }
      return 1;
    } else if (evlistener !== undefined) {
      if (listener != null) {
        let matching = 0;
        for (let i = 0; i < evlistener.length; ++i) {
          if (evlistener[i] === listener || evlistener[i].listener === listener) matching++;
        }
        return matching;
      }
      return evlistener.length;
    }
  }
  return 0;
};

EventEmitter.prototype.eventNames = function eventNames() {
  return this._eventsCount > 0 ? Reflect.ownKeys(this._events) : [];
};

export class EventEmitterAsyncResource extends EventEmitter {
  constructor(options = {}) {
    super(options);
    const resourceOptions = typeof options === "string" ? { name: options } : options;
    this.asyncResource = resourceOptions.asyncResource ?? new AsyncResource(
      resourceOptions.name ?? "EventEmitterAsyncResource",
      resourceOptions,
    );
    this.asyncId = this.asyncResource.asyncId();
    this.triggerAsyncId = this.asyncResource.triggerAsyncId();
  }

  emit(eventName, ...args) {
    return this.asyncResource.runInAsyncScope(EventEmitter.prototype.emit, this, eventName, ...args);
  }

  emitDestroy() {
    this.asyncResource?.emitDestroy?.();
  }
}

export function listenerCount(emitter, eventName) {
  if (typeof emitter?.listenerCount === "function") return emitter.listenerCount(eventName);
  return EventEmitter.prototype.listenerCount.call(emitter, eventName);
}

export function getEventListeners(emitter, eventName) {
  if (typeof emitter?.listeners === "function") return emitter.listeners(eventName);
  const eventTargetListeners = emitter?.__ctEventListeners?.get?.(String(eventName));
  if (eventTargetListeners) return eventTargetListeners.map((entry) => entry.listener ?? entry);
  if (eventName === "abort" && emitter?._listeners instanceof Set) return [...emitter._listeners];
  return [];
}

export function setMaxListeners(n = defaultMaxListeners, ...eventTargets) {
  if (eventTargets.length === 0) {
    EventEmitter.defaultMaxListeners = n;
    return;
  }
  for (const target of eventTargets) {
    if (typeof target?.setMaxListeners === "function") target.setMaxListeners(n);
    else if (target) target[kMaxEventTargetListeners] = Number(n);
  }
}

export function getMaxListeners(emitterOrTarget) {
  if (typeof emitterOrTarget?.getMaxListeners === "function") return emitterOrTarget.getMaxListeners();
  return emitterOrTarget?.[kMaxEventTargetListeners] ?? defaultMaxListeners;
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
  const error = new Error("The operation was aborted.");
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
  const firstEventParam = options?.[kFirstEventParam] === true;
  const toValue = (args) => (firstEventParam ? args[0] : args);

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
    if (unconsumedPromises.length > 0) unconsumedPromises.shift().resolve({ value: toValue(args), done: false });
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
        return Promise.resolve({ value: toValue(unconsumedEvents.shift()), done: false });
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

Object.assign(EventEmitter, {
  EventEmitterAsyncResource,
  addAbortListener,
  captureRejectionSymbol,
  errorMonitor,
  getEventListeners,
  getMaxListeners,
  kMaxEventTargetListeners,
  kMaxEventTargetListenersWarned,
  listenerCount,
  on,
  once,
  setMaxListeners,
  usingDomains,
});
