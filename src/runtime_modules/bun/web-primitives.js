export function createWebPrimitives(nodeInspect) {
  const inspectCustomSymbol = Symbol.for("nodejs.util.inspect.custom");
  const domExceptionCodes = {
    IndexSizeError: 1,
    DOMStringSizeError: 2,
    HierarchyRequestError: 3,
    WrongDocumentError: 4,
    InvalidCharacterError: 5,
    NoDataAllowedError: 6,
    NoModificationAllowedError: 7,
    NotFoundError: 8,
    NotSupportedError: 9,
    InUseAttributeError: 10,
    InvalidStateError: 11,
    SyntaxError: 12,
    InvalidModificationError: 13,
    NamespaceError: 14,
    InvalidAccessError: 15,
    ValidationError: 16,
    TypeMismatchError: 17,
    SecurityError: 18,
    NetworkError: 19,
    AbortError: 20,
    URLMismatchError: 21,
    QuotaExceededError: 22,
    TimeoutError: 23,
    InvalidNodeTypeError: 24,
    DataCloneError: 25,
  };
  
  class CottontailDOMException extends Error {
    constructor(message = "", nameOrOptions = "Error") {
      let name = "Error";
      let hasCause = false;
      let cause;
      if (typeof nameOrOptions === "object" && nameOrOptions !== null) {
        if (nameOrOptions.name !== undefined) name = String(nameOrOptions.name);
        if ("cause" in nameOrOptions) {
          hasCause = true;
          cause = nameOrOptions.cause;
        }
      } else if (nameOrOptions !== undefined) {
        name = String(nameOrOptions);
      }
      super(String(message));
      this.name = name;
      if (hasCause) {
        Object.defineProperty(this, "cause", {
          value: cause,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      }
      // Match WebKit/Bun: DOMException instances do not carry a stack trace.
      this.stack = undefined;
    }
  
    get code() {
      return domExceptionCodes[this.name] ?? 0;
    }
  
    get [Symbol.toStringTag]() {
      return "DOMException";
    }
  }
  
  Object.defineProperty(CottontailDOMException, "name", {
    value: "DOMException",
    configurable: true,
  });
  
  {
    const domExceptionLegacyConstants = {
      INDEX_SIZE_ERR: 1,
      DOMSTRING_SIZE_ERR: 2,
      HIERARCHY_REQUEST_ERR: 3,
      WRONG_DOCUMENT_ERR: 4,
      INVALID_CHARACTER_ERR: 5,
      NO_DATA_ALLOWED_ERR: 6,
      NO_MODIFICATION_ALLOWED_ERR: 7,
      NOT_FOUND_ERR: 8,
      NOT_SUPPORTED_ERR: 9,
      INUSE_ATTRIBUTE_ERR: 10,
      INVALID_STATE_ERR: 11,
      SYNTAX_ERR: 12,
      INVALID_MODIFICATION_ERR: 13,
      NAMESPACE_ERR: 14,
      INVALID_ACCESS_ERR: 15,
      VALIDATION_ERR: 16,
      TYPE_MISMATCH_ERR: 17,
      SECURITY_ERR: 18,
      NETWORK_ERR: 19,
      ABORT_ERR: 20,
      URL_MISMATCH_ERR: 21,
      QUOTA_EXCEEDED_ERR: 22,
      TIMEOUT_ERR: 23,
      INVALID_NODE_TYPE_ERR: 24,
      DATA_CLONE_ERR: 25,
    };
    for (const [constantName, constantValue] of Object.entries(domExceptionLegacyConstants)) {
      const descriptor = {
        value: constantValue,
        writable: false,
        enumerable: true,
        configurable: false,
      };
      Object.defineProperty(CottontailDOMException, constantName, descriptor);
      Object.defineProperty(CottontailDOMException.prototype, constantName, descriptor);
    }
  }
  
  const eventState = new WeakMap();
  const eventTargetWeakHandler = Symbol.for("nodejs.internal.event_target.kWeakHandler");
  const eventTargetResistStopPropagation = Symbol.for("nodejs.internal.event_target.kResistStopPropagation");
  const NativeWeakRef = globalThis.WeakRef;
  
  function internalWeakRef(target) {
    return new NativeWeakRef(target);
  }
  
  function eventStateFor(event) {
    const state = eventState.get(event);
    if (!state) throw new TypeError("Illegal invocation");
    return state;
  }
  
  function setEventTarget(event, target, currentTarget) {
    const state = eventState.get(event);
    if (state) {
      if (state.target == null) state.target = target;
      state.currentTarget = currentTarget;
      return true;
    }
    return false;
  }
  
  function markEventTrusted(event) {
    const state = eventState.get(event);
    if (state) {
      state.isTrusted = true;
      return;
    }
    try {
      Object.defineProperty(event, "isTrusted", { value: true, configurable: true });
    } catch {}
  }
  
  // Shared unforgeable-style isTrusted getter: the WHATWG spec installs
  // isTrusted as an own accessor on every event instance, with the same getter
  // function shared between instances (observable via getOwnPropertyDescriptor).
  function sharedIsTrustedGetter() {
    return eventStateFor(this).isTrusted;
  }
  Object.defineProperty(sharedIsTrustedGetter, "name", { value: "isTrusted", configurable: true });
  
  class CottontailEvent {
    constructor(type, init = undefined) {
      const options = init != null && typeof init === "object" ? init : {};
      eventState.set(this, {
        type: String(type),
        bubbles: Boolean(options.bubbles),
        cancelable: Boolean(options.cancelable),
        composed: Boolean(options.composed),
        defaultPrevented: false,
        target: null,
        currentTarget: null,
        isTrusted: false,
        cancelBubble: false,
        stopImmediate: false,
        eventPhase: 0,
        returnValue: true,
        timeStamp: typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now(),
      });
      Object.defineProperty(this, "isTrusted", {
        get: sharedIsTrustedGetter,
        enumerable: true,
        configurable: false,
      });
    }
  
    get type() {
      return eventStateFor(this).type;
    }
  
    get bubbles() {
      return eventStateFor(this).bubbles;
    }
  
    get cancelable() {
      return eventStateFor(this).cancelable;
    }
  
    get composed() {
      return eventStateFor(this).composed;
    }
  
    get defaultPrevented() {
      return eventStateFor(this).defaultPrevented;
    }
  
    get target() {
      return eventStateFor(this).target;
    }
  
    get srcElement() {
      return eventStateFor(this).target;
    }
  
    get currentTarget() {
      return eventStateFor(this).currentTarget;
    }
  
    get eventPhase() {
      return eventStateFor(this).eventPhase;
    }
  
    get timeStamp() {
      return eventStateFor(this).timeStamp;
    }
  
    get cancelBubble() {
      return eventStateFor(this).cancelBubble;
    }
  
    set cancelBubble(value) {
      if (value) eventStateFor(this).cancelBubble = true;
    }
  
    get returnValue() {
      return !eventStateFor(this).defaultPrevented;
    }
  
    set returnValue(value) {
      const state = eventStateFor(this);
      if (!value && state.cancelable) state.defaultPrevented = true;
    }
  
    composedPath() {
      const state = eventStateFor(this);
      return state.currentTarget == null ? [] : [state.currentTarget];
    }
  
    stopPropagation() {
      eventStateFor(this).cancelBubble = true;
    }
  
    stopImmediatePropagation() {
      const state = eventStateFor(this);
      state.cancelBubble = true;
      state.stopImmediate = true;
    }
  
    preventDefault() {
      const state = eventStateFor(this);
      if (state.cancelable) state.defaultPrevented = true;
    }
  
    initEvent(type, bubbles = false, cancelable = false) {
      const state = eventStateFor(this);
      if (state.eventPhase !== 0) return;
      state.type = String(type);
      state.bubbles = Boolean(bubbles);
      state.cancelable = Boolean(cancelable);
    }
  
    get [Symbol.toStringTag]() {
      return "Event";
    }
  }
  
  Object.defineProperty(CottontailEvent.prototype, "isTrusted", {
    get: sharedIsTrustedGetter,
    enumerable: true,
    configurable: true,
  });
  
  for (const [name, value] of [["NONE", 0], ["CAPTURING_PHASE", 1], ["AT_TARGET", 2], ["BUBBLING_PHASE", 3]]) {
    Object.defineProperty(CottontailEvent, name, { value, enumerable: true });
    Object.defineProperty(CottontailEvent.prototype, name, { value, enumerable: true });
  }
  
  class CottontailCustomEvent extends CottontailEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.detail = init.detail ?? null;
    }
  
    initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
      this.initEvent(type, bubbles, cancelable);
      this.detail = detail;
    }
  }
  
  class CottontailErrorEvent extends CottontailEvent {
    constructor(type = "error", init = {}) {
      super(type, init);
      this.message = String(init.message ?? "");
      this.filename = String(init.filename ?? "");
      this.lineno = Number(init.lineno ?? 0);
      this.colno = Number(init.colno ?? 0);
      this.error = init.error ?? null;
    }
  
    [inspectCustomSymbol]() {
      let errorText;
      if (this.error == null) {
        errorText = this.error === undefined ? "undefined" : "null";
      } else if (this.error instanceof globalThis.Error) {
        errorText = `error: ${String(this.error.message ?? "")}\n`;
      } else {
        errorText = nodeInspect(this.error);
      }
      return `ErrorEvent {\n  type: ${JSON.stringify(String(this.type))},\n  message: ${JSON.stringify(String(this.message))},\n  error: ${errorText},\n}`;
    }
  }
  
  class CottontailCloseEvent extends CottontailEvent {
    constructor(type = "close", init = {}) {
      super(type, init);
      this.wasClean = Boolean(init.wasClean);
      this.code = Number(init.code ?? 0);
      this.reason = String(init.reason ?? "");
    }
  }
  
  class CottontailFile extends Blob {
    constructor(parts, name, options = {}) {
      if (arguments.length < 2) throw new TypeError("File constructor requires file bits and name");
      if (parts == null || typeof parts[Symbol.iterator] !== "function") throw new TypeError("File bits must be iterable");
      super(parts, options);
      this.name = String(name);
      this.lastModified = Number(options.lastModified ?? Date.now());
    }
  }
  
  function BunFile(parts, name, options = {}) {
    if (!new.target) throw new TypeError("Class constructor File cannot be invoked without 'new'");
    return Reflect.construct(CottontailFile, [parts, name, options], new.target);
  }
  BunFile.prototype = CottontailFile.prototype;
  
  Object.defineProperty(CottontailCustomEvent, "name", { value: "CustomEvent", configurable: true });
  Object.defineProperty(CottontailErrorEvent, "name", { value: "ErrorEvent", configurable: true });
  Object.defineProperty(CottontailCloseEvent, "name", { value: "CloseEvent", configurable: true });
  Object.defineProperty(CottontailFile, "name", { value: "File", configurable: true });
  Object.defineProperty(BunFile, "name", { value: "File", configurable: true });
  Object.defineProperty(CottontailCustomEvent.prototype, Symbol.toStringTag, { value: "CustomEvent", configurable: true });
  Object.defineProperty(CottontailErrorEvent.prototype, Symbol.toStringTag, { value: "ErrorEvent", configurable: true });
  Object.defineProperty(CottontailCloseEvent.prototype, Symbol.toStringTag, { value: "CloseEvent", configurable: true });
  
  const eventTargetListenerMaps = new WeakMap();
  const eventHandlerAttributeOrders = new WeakMap();
  let eventListenerOrder = 0;
  
  function setEventHandlerAttributeOrder(target, type, handler) {
    let orders = eventHandlerAttributeOrders.get(target);
    if (!orders) {
      orders = new Map();
      eventHandlerAttributeOrders.set(target, orders);
    }
    if (typeof handler === "function") {
      if (!orders.has(type)) orders.set(type, ++eventListenerOrder);
    } else {
      orders.delete(type);
    }
  }
  
  function eventTargetListenersFor(target) {
    const listeners = eventTargetListenerMaps.get(target);
    if (!listeners) throw new TypeError("Can only call this method on instances of EventTarget");
    return listeners;
  }
  
  class CottontailEventTarget {
    constructor() {
      const listeners = new Map();
      eventTargetListenerMaps.set(this, listeners);
      Object.defineProperty(this, "__ctEventListeners", {
        value: listeners,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    }
  
    addEventListener(type, listener, options = undefined) {
      const listeners = eventTargetListenersFor(this);
      if (listener == null) return;
      const name = String(type);
      const opts = options && typeof options === "object" ? options : {};
      const capture = options === true || Boolean(opts.capture);
      const signal = opts.signal;
      if (signal != null && signal.aborted) return;
      const list = listeners.get(name) ?? [];
      if (!list.some((entry) => entry.listener === listener && entry.capture === capture)) {
        list.push({
          listener,
          capture,
          once: Boolean(opts.once),
          weak: Boolean(opts[eventTargetWeakHandler]),
          resistStopPropagation: Boolean(opts[eventTargetResistStopPropagation]),
          order: ++eventListenerOrder,
        });
        if (signal != null && typeof signal.addEventListener === "function") {
          signal.addEventListener("abort", () => {
            this.removeEventListener(name, listener, { capture });
          }, { once: true, [eventTargetWeakHandler]: true });
        }
      }
      listeners.set(name, list);
    }
  
    removeEventListener(type, listener, options = undefined) {
      const listeners = eventTargetListenersFor(this);
      const name = String(type);
      const capture = options === true || Boolean(options && typeof options === "object" && options.capture);
      const list = listeners.get(name);
      if (list) {
        listeners.set(name, list.filter((entry) => !(entry.listener === listener && entry.capture === capture)));
      }
      refreshAbortSignalRetention(this);
    }
  
    dispatchEvent(event) {
      const listeners = eventTargetListenersFor(this);
      const state = eventState.get(event);
      if (state) {
        state.target = this;
        state.currentTarget = this;
        state.eventPhase = 2;
        state.stopImmediate = false;
        state.cancelBubble = false;
        const list = [...(listeners.get(state.type) ?? [])];
        const handler = this[`on${state.type}`];
        if (typeof handler === "function") {
          list.push({ listener: handler, capture: false, once: false, order: eventHandlerAttributeOrders.get(this)?.get(state.type) ?? Infinity });
        }
        list.sort((a, b) => a.order - b.order);
        for (const entry of list) {
          if (state.stopImmediate && !entry.resistStopPropagation) continue;
          const listener = entry.listener;
          if (entry.once) this.removeEventListener(state.type, listener, { capture: entry.capture });
          if (typeof listener === "function") listener.call(this, event);
          else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(event);
        }
        state.eventPhase = 0;
        state.currentTarget = null;
        return !state.defaultPrevented;
      }
      // Legacy path: internal call sites dispatch plain objects that carry a
      // type/target shape but are not real Event instances.
      const dispatched = event && typeof event === "object" ? event : new CottontailEvent(String(event));
      if (!setEventTarget(dispatched, this, this)) {
        try {
          if (!dispatched.target) dispatched.target = this;
          dispatched.currentTarget = this;
        } catch {}
      }
      const dispatchedType = String(dispatched.type);
      const list = [...(listeners.get(dispatchedType) ?? [])];
      const handler = this[`on${dispatchedType}`];
      if (typeof handler === "function") {
        list.push({ listener: handler, capture: false, once: false, order: eventHandlerAttributeOrders.get(this)?.get(dispatchedType) ?? Infinity });
      }
      list.sort((a, b) => a.order - b.order);
      for (const entry of list) {
        const listener = entry.listener;
        if (entry.once) this.removeEventListener(dispatched.type, listener, { capture: entry.capture });
        if (typeof listener === "function") listener.call(this, dispatched);
        else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(dispatched);
      }
      return !dispatched.defaultPrevented;
    }
  
    get [Symbol.toStringTag]() {
      return "EventTarget";
    }
  }
  Object.defineProperty(CottontailEventTarget, "name", { value: "EventTarget", configurable: true });
  
  function makeAbortError() {
    const DOMExceptionClass = globalThis.DOMException ?? CottontailDOMException;
    return new DOMExceptionClass("The operation was aborted.", "AbortError");
  }
  
  function makeTimeoutError() {
    const DOMExceptionClass = globalThis.DOMException ?? CottontailDOMException;
    return new DOMExceptionClass("The operation timed out.", "TimeoutError");
  }
  
  function nodeTypeError(code, message) {
    const error = new TypeError(message);
    error.code = code;
    return error;
  }
  
  function invalidAbortSignalArgument(name, value) {
    const received = value === null ? "null" : value === undefined ? "undefined" : typeof value;
    return nodeTypeError(
      "ERR_INVALID_ARG_TYPE",
      `The "${name}" argument must be an instance of AbortSignal. Received ${received}`,
    );
  }
  
  const abortSignalConstructToken = Symbol("CottontailAbortSignalConstruct");
  const abortSignalState = new WeakMap();
  const abortControllerState = new WeakMap();
  const abortDependantSignals = Symbol("kDependantSignals");
  const activeAbortSignals = new Set();
  const abortQueue = [];
  let drainingAbortQueue = false;
  
  const abortTimeoutFinalizer = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry(timer => {
        try { clearTimeout(timer); } catch {}
      })
    : null;
  
  class WeakDependantSignalSet {
    constructor() {
      this.refs = new Set();
    }
  
    add(ref) {
      this.refs.add(ref);
      return this;
    }
  
    delete(ref) {
      return this.refs.delete(ref);
    }
  
    prune() {
      for (const ref of [...this.refs]) {
        if (!ref.deref()) this.refs.delete(ref);
      }
    }
  
    get size() {
      this.prune();
      return this.refs.size;
    }
  
    [Symbol.iterator]() {
      this.prune();
      return this.refs[Symbol.iterator]();
    }
  }
  
  const dependantFinalizer = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((held) => {
        const source = held?.source?.deref?.();
        if (!source) return;
        const state = abortSignalState.get(source);
        state?.dependants?.delete(held.ref);
        refreshAbortSignalRetention(source);
      })
    : null;
  
  const sourceFinalizer = typeof FinalizationRegistry === "function"
    ? new FinalizationRegistry((held) => {
        const dependantRef = held?.dependant;
        setImmediate(() => {
          const dependant = dependantRef?.deref?.();
          if (!dependant) return;
          const state = abortSignalState.get(dependant);
          state?.sourceSignals?.delete(held.sourceRef);
          refreshAbortSignalRetention(dependant);
        });
      })
    : null;
  
  function abortSignalStateFor(signal) {
    const state = abortSignalState.get(signal);
    if (!state) throw new TypeError("Value is not an AbortSignal");
    return state;
  }
  
  function abortControllerStateFor(controller) {
    const state = abortControllerState.get(controller);
    if (!state) throw new TypeError("Value is not an AbortController");
    return state;
  }
  
  function isAbortSignal(value) {
    return abortSignalState.has(value);
  }
  
  function cleanupDependants(state) {
    state.dependants.prune();
  }
  
  function addDependantSignal(source, dependant, dependantRef, sourceRef) {
    const state = abortSignalStateFor(source);
    state.dependants.add(dependantRef);
    dependantFinalizer?.register(dependant, { source: sourceRef, ref: dependantRef });
    refreshAbortSignalRetention(source);
  }
  
  function enqueueDependants(state) {
    cleanupDependants(state);
    for (const ref of state.dependants) {
      const dependant = ref.deref();
      if (dependant) abortQueue.push([dependant, state.reason]);
    }
  }
  
  function drainAbortQueue() {
    if (drainingAbortQueue) return;
    drainingAbortQueue = true;
    try {
      while (abortQueue.length > 0) {
        const [signal, reason] = abortQueue.shift();
        abortSignal(signal, reason);
      }
    } finally {
      drainingAbortQueue = false;
    }
  }
  
  function abortSignal(signal, reason) {
    const state = abortSignalStateFor(signal);
    if (state.aborted) return;
    state.aborted = true;
    state.reason = reason;
    if (state.timeoutTimer != null) {
      clearTimeout(state.timeoutTimer);
      abortTimeoutFinalizer?.unregister(state.timeoutTimer);
      state.timeoutTimer = null;
    }
    activeAbortSignals.delete(signal);
    const EventClass = globalThis.Event ?? CottontailEvent;
    const event = new EventClass("abort");
    markEventTrusted(event);
    signal.dispatchEvent(event);
    enqueueDependants(state);
    drainAbortQueue();
  }
  
  function refreshAbortSignalRetention(target) {
    const state = abortSignalState.get(target);
    if (!state || state.aborted) {
      activeAbortSignals.delete(target);
      return;
    }
    const listeners = (target.__ctEventListeners?.get?.("abort") ?? []).filter((entry) => !entry.weak);
    const hasListener = listeners.length > 0 || typeof state.onabort === "function";
    state.dependants.prune();
    const retainTimeout = state.timeoutTimer != null && (hasListener || state.dependants.size > 0);
    const retainComposite = state.composite && state.sourceSignals?.size > 0 && hasListener;
    if (retainTimeout || retainComposite) {
      activeAbortSignals.add(target);
    } else {
      activeAbortSignals.delete(target);
    }
  }
  
  class CottontailAbortSignal extends CottontailEventTarget {
    constructor(token) {
      if (token !== abortSignalConstructToken) {
        throw nodeTypeError("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
      }
      super();
      const dependants = new WeakDependantSignalSet();
      abortSignalState.set(this, {
        aborted: false,
        reason: undefined,
        onabort: null,
        timeoutTimer: null,
        timeoutDeadline: null,
        dependants,
        composite: false,
        sourceSignals: null,
      });
      Object.defineProperty(this, abortDependantSignals, {
        value: dependants,
        enumerable: false,
        configurable: true,
      });
    }
  
    get aborted() {
      return abortSignalStateFor(this).aborted;
    }
  
    get reason() {
      return abortSignalStateFor(this).reason;
    }
  
    get onabort() {
      return abortSignalStateFor(this).onabort;
    }
  
    set onabort(handler) {
      const state = abortSignalStateFor(this);
      state.onabort = typeof handler === "function" ? handler : null;
      refreshAbortSignalRetention(this);
    }
  
    addEventListener(type, listener, options = undefined) {
      super.addEventListener(type, listener, options);
      refreshAbortSignalRetention(this);
    }
  
    throwIfAborted() {
      const state = abortSignalStateFor(this);
      if (state.aborted) throw state.reason;
    }
  
    static abort(reason = makeAbortError()) {
      const signal = new CottontailAbortSignal(abortSignalConstructToken);
      abortSignal(signal, reason);
      return signal;
    }
  
    static timeout(delay) {
      let normalizedDelay;
      try {
        normalizedDelay = Math.trunc(+delay);
      } catch (error) {
        throw new TypeError(error?.message ?? "AbortSignal.timeout delay must be a number");
      }
      if (!Number.isFinite(normalizedDelay) || normalizedDelay < 0 || normalizedDelay > Number.MAX_SAFE_INTEGER) {
        throw new TypeError(`AbortSignal.timeout delay must be between 0 and ${Number.MAX_SAFE_INTEGER}`);
      }
      const controller = new CottontailAbortController();
      const signal = controller.signal;
      const signalRef = internalWeakRef(signal);
      const timer = setTimeout(() => {
        abortTimeoutFinalizer?.unregister(timer);
        const liveSignal = signalRef.deref();
        if (liveSignal) abortSignal(liveSignal, makeTimeoutError());
      }, normalizedDelay);
      timer?.unref?.();
      const state = abortSignalStateFor(signal);
      state.timeoutTimer = timer;
      state.timeoutDeadline = Date.now() + normalizedDelay;
      abortTimeoutFinalizer?.register(signal, timer, timer);
      return signal;
    }
  
    static any(signals) {
      if (signals == null || typeof signals[Symbol.iterator] !== "function") {
        throw nodeTypeError("ERR_INVALID_ARG_TYPE", "The \"signals\" argument must be an iterable of AbortSignal instances");
      }
      const list = Array.from(signals);
      for (let index = 0; index < list.length; index += 1) {
        if (!isAbortSignal(list[index])) throw invalidAbortSignalArgument(`signals[${index}]`, list[index]);
      }
      const controller = new CottontailAbortController();
      const result = controller.signal;
      const resultState = abortSignalStateFor(result);
      resultState.composite = true;
      resultState.sourceSignals = new Set();
      for (const signal of list) {
        if (signal.aborted) {
          controller.abort(signal.reason);
          return result;
        }
      }
      const resultRef = internalWeakRef(result);
      for (const signal of list) {
        const sourceState = abortSignalStateFor(signal);
        if (sourceState.composite) {
          for (const sourceRef of sourceState.sourceSignals ?? []) {
            const source = sourceRef.deref();
            if (!source || resultState.sourceSignals.has(sourceRef)) continue;
            resultState.sourceSignals.add(sourceRef);
            addDependantSignal(source, result, resultRef, sourceRef);
            sourceFinalizer?.register(signal, { sourceRef, dependant: resultRef });
          }
          continue;
        }
        const sourceRef = internalWeakRef(signal);
        resultState.sourceSignals.add(sourceRef);
        addDependantSignal(signal, result, resultRef, sourceRef);
        sourceFinalizer?.register(signal, { sourceRef, dependant: resultRef });
      }
      return result;
    }
  
    [inspectCustomSymbol]() {
      return `AbortSignal { aborted: ${this.aborted ? "true" : "false"} }`;
    }
  
    get [Symbol.toStringTag]() {
      return "AbortSignal";
    }
  }
  
  class CottontailAbortController {
    constructor() {
      abortControllerState.set(this, {
        signal: new CottontailAbortSignal(abortSignalConstructToken),
      });
    }
  
    get signal() {
      return abortControllerStateFor(this).signal;
    }
  
    abort(reason = makeAbortError()) {
      abortSignal(abortControllerStateFor(this).signal, reason);
    }
  
    [inspectCustomSymbol](_depth, options) {
      return options?.depth === null
        ? `AbortController { signal: ${this.signal[inspectCustomSymbol]()} }`
        : "AbortController { signal: [AbortSignal] }";
    }
  
    get [Symbol.toStringTag]() {
      return "AbortController";
    }
  }
  
    return {
    BunFile,
    CottontailAbortController,
    CottontailAbortSignal,
    CottontailCloseEvent,
    CottontailCustomEvent,
    CottontailDOMException,
    CottontailErrorEvent,
    CottontailEvent,
    CottontailEventTarget,
    abortSignalState,
    eventState,
    eventStateFor,
    inspectCustomSymbol,
    isAbortSignal,
    markEventTrusted,
    nodeTypeError,
    setEventHandlerAttributeOrder,
  };
}

