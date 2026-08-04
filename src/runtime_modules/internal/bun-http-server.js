const incomingRequestTargetDecoder = new TextDecoder();
const serveReadableStreamRefs = new Set();
const serveReadableStreamValues = new WeakSet();
const serveReadableStreamFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry((reference) => serveReadableStreamRefs.delete(reference))
  : null;

function liveServeReadableStreamCount() {
  let count = 0;
  for (const reference of serveReadableStreamRefs) {
    if (reference.deref() === undefined) serveReadableStreamRefs.delete(reference);
    else count += 1;
  }
  return count;
}

const heapObjectCountProviders = globalThis.__cottontailHeapObjectCountProviders ??= new Map();
if (!heapObjectCountProviders.has("ReadableStream")) {
  // COTTONTAIL-COMPAT: stock JSC reports JavaScript stream instances as
  // Objects. Keep an HTTP-owned weak count without retaining the streams.
  heapObjectCountProviders.set("ReadableStream", liveServeReadableStreamCount);
}

export function trackServeReadableStream(stream) {
  if (stream == null || typeof stream !== "object" ||
      typeof WeakRef !== "function" || serveReadableStreamValues.has(stream)) return stream;
  serveReadableStreamValues.add(stream);
  const reference = new WeakRef(stream);
  serveReadableStreamRefs.add(reference);
  serveReadableStreamFinalizer?.register(stream, reference);
  return stream;
}

function incomingRequestTargetText(target) {
  if (target instanceof ArrayBuffer) return incomingRequestTargetDecoder.decode(target);
  if (ArrayBuffer.isView(target)) {
    return incomingRequestTargetDecoder.decode(
      new Uint8Array(target.buffer, target.byteOffset, target.byteLength),
    );
  }
  return String(target ?? "/");
}

export function incomingRequestURLFactory(
  protocol,
  host,
  target,
  fallbackOrigin,
  normalizeURL,
  targetCache,
  cacheVersion,
  cacheHit,
) {
  const version = Number(cacheVersion) >>> 0;
  let requestTarget = target;
  let cachedURL = null;
  if (cacheHit === true) {
    if (version === 0 || targetCache?.version !== version || targetCache.target == null) {
      throw new Error("Incoming HTTP request target cache is inconsistent");
    }
    requestTarget = targetCache.target;
    cachedURL = targetCache.url ?? null;
  } else if (version !== 0 && target != null && targetCache != null) {
    targetCache.version = version;
    targetCache.target = target;
    targetCache.url = null;
  }
  const requestBase = host ? `${protocol}//${host}` : String(fallbackOrigin);
  return () => {
    if (cachedURL != null) return cachedURL;
    const rawTarget = incomingRequestTargetText(requestTarget);
    cachedURL = normalizeURL(/^https?:\/\//i.test(rawTarget) ? rawTarget : `${requestBase}${rawTarget}`);
    if (version !== 0 && targetCache?.version === version && targetCache.target === requestTarget) {
      targetCache.url = cachedURL;
    }
    return cachedURL;
  };
}

export function createServeLifecycle(getPendingWebSockets) {
  const requests = new Set();
  let pendingRequests = 0;
  let stopRequested = false;
  let forceRequested = false;
  let transportDrained = false;
  let stopPromise = null;
  let resolveStop = null;
  let stopTransport = null;
  let forceTransport = null;

  const maybeResolveStop = () => {
    if (!stopRequested || !transportDrained || pendingRequests !== 0 || getPendingWebSockets() !== 0) return;
    resolveStop?.();
    resolveStop = null;
  };

  const finishRequest = (request) => {
    if (request == null || request.finished) return;
    request.finished = true;
    requests.delete(request);
    if (pendingRequests > 0) pendingRequests -= 1;
    maybeResolveStop();
  };

  const finishForcedRequests = () => {
    for (const request of Array.from(requests)) {
      try { request.onForce?.(); } catch {}
      finishRequest(request);
    }
  };

  return {
    get pendingRequests() {
      return pendingRequests;
    },
    get stopRequested() {
      return stopRequested;
    },
    get forceRequested() {
      return forceRequested;
    },
    configure(stop, force) {
      stopTransport = stop;
      forceTransport = force;
    },
    beginRequest(onForce = undefined) {
      const request = { finished: false, onForce };
      requests.add(request);
      pendingRequests += 1;
      return request;
    },
    finishRequest,
    stop(force = false) {
      const abrupt = force === true;
      if (stopPromise == null) {
        stopPromise = new Promise((resolve) => {
          resolveStop = resolve;
        });
      }
      if (!stopRequested) {
        stopRequested = true;
        forceRequested = abrupt;
        stopTransport?.(abrupt);
        if (abrupt) finishForcedRequests();
      } else if (abrupt && !forceRequested) {
        forceRequested = true;
        forceTransport?.();
        finishForcedRequests();
      }
      maybeResolveStop();
      return stopPromise;
    },
    markTransportDrained() {
      transportDrained = true;
      maybeResolveStop();
    },
    notifyWebSocketsChanged() {
      maybeResolveStop();
    },
  };
}

export function createNativeServeRequestOperation(item, state) {
  const id = item.id;
  let activeItem = item;
  let activeRequest = null;
  let activeState = state;

  return {
    id,
    get item() {
      return activeItem;
    },
    get request() {
      return activeRequest;
    },
    get state() {
      return activeState;
    },
    attachRequest(request) {
      if (activeState == null) return false;
      activeRequest = request;
      return true;
    },
    poll() {
      activeState?.poll();
    },
    forceAbort() {
      activeState?.forceAbort();
    },
    dispose() {
      if (activeState == null) return null;
      const stateToDispose = activeState;
      activeItem = null;
      activeRequest = null;
      activeState = null;
      stateToDispose.dispose();
      return stateToDispose;
    },
  };
}

class NativeServeEmptyRequestState {
  constructor(item, options) {
    this.requestId = item.id;
    this.abortController = options.createAbortController();
    this.lifecycleRequest = null;
    this.body = null;
    this.byteSize = 0;
    this.bodySettled = true;
    this.wantsData = false;
    this.polling = false;
    this._binding = options.binding;
    this._serverId = options.serverId;
    this._isServerClosed = options.isServerClosed;
    this._connectionClosedError = options.connectionClosedError;
    this._nativeFinished = false;
  }

  cancelNativeBody() {}
  abortBody() {}
  abort() {}
  finishResponse() {}
  readAllNative() { return null; }
  pendingBodyRead() { return null; }
  tryForwardResponse() { return null; }

  abortConnection() {
    const controller = this.abortController;
    if (controller && !controller.signal.aborted) controller.abort(this._connectionClosedError());
  }

  forceAbort() {
    this.abortConnection();
  }

  dispose() {
    if (this._nativeFinished) return;
    this._nativeFinished = true;
    this.polling = false;
    this.lifecycleRequest = null;
    this.abortController = null;
    this._binding = null;
    this._isServerClosed = null;
    this._connectionClosedError = null;
  }

  poll() {
    if (this._nativeFinished || this._isServerClosed() || this.polling) return;
    this.polling = true;
    try {
      const event = this._binding.httpServerRequestEventPoll(this._serverId, this.requestId, false);
      if (event?.type === "abort") this.abortConnection();
    } finally {
      this.polling = false;
    }
  }
}

export function createNativeServeRequestState(item, options) {
  const {
    binding,
    serverId,
    isServerClosed,
    bodyStateSymbol,
    unreadBodyAbortReason,
    connectionClosedError,
    createAbortController,
    onProgress,
  } = options;
  const requestId = item.id;
  const hasBody = Boolean(item.hasBody);
  if (!hasBody) return new NativeServeEmptyRequestState(item, options);
  const bodyLength = Number(item.bodyLength);
  let bodyController = null;
  let nativeFinished = false;
  let jsBodyStarted = false;
  let nativeForwarding = false;
  let forwardPromise = null;
  let resolveForward = null;
  let nativeBuffering = false;
  let bufferPromise = null;
  let resolveBuffer = null;
  let rejectBuffer = null;
  let abortController = createAbortController();

  const settleForward = () => {
    const resolve = resolveForward;
    resolveForward = null;
    forwardPromise = null;
    nativeForwarding = false;
    resolve?.();
  };

  const settleBuffer = (data, error = null) => {
    const resolve = resolveBuffer;
    const reject = rejectBuffer;
    resolveBuffer = null;
    rejectBuffer = null;
    bufferPromise = null;
    nativeBuffering = false;
    if (error != null) reject?.(error);
    else resolve?.(data);
  };

  const state = {
    requestId,
    abortController,
    lifecycleRequest: null,
    body: null,
    byteSize: Number.isFinite(bodyLength) && bodyLength >= 0 ? bodyLength : null,
    bodySettled: !hasBody,
    wantsData: false,
    polling: false,
    cancelNativeBody() {
      if (nativeFinished || nativeForwarding || nativeBuffering || isServerClosed() || !hasBody) return;
      try { binding.httpServerRequestCancel(serverId, requestId); } catch {}
    },
    abortBody(reason, cancelNative = true) {
      if (state.bodySettled) return;
      state.bodySettled = true;
      state.wantsData = false;
      try { bodyController?.error(reason); } catch {}
      bodyController = null;
      if (cancelNative) state.cancelNativeBody();
    },
    abort(reason) {
      state.abortBody(reason);
    },
    abortConnection() {
      const bodyError = new globalThis.DOMException("The operation was aborted.", "AbortError");
      state.abortBody(bodyError, false);
      if (abortController && !abortController.signal.aborted) abortController.abort(connectionClosedError());
      settleBuffer(null, bodyError);
    },
    forceAbort() {
      const bodyError = new globalThis.DOMException("The operation was aborted.", "AbortError");
      state.abortBody(bodyError);
      if (abortController && !abortController.signal.aborted) abortController.abort(connectionClosedError());
      settleForward();
      settleBuffer(null, bodyError);
    },
    finishResponse(response = null) {
      if (nativeForwarding || nativeBuffering || state.bodySettled || response?._body === state.body) return;
      state.abortBody(unreadBodyAbortReason());
    },
    readAllNative(asText = false) {
      if (nativeFinished || nativeForwarding || nativeBuffering || state.bodySettled || jsBodyStarted ||
          isServerClosed() || !hasBody) {
        return null;
      }

      const pending = new Promise((resolve, reject) => {
        resolveBuffer = resolve;
        rejectBuffer = reject;
      });
      let claimed;
      try {
        claimed = binding.httpServerRequestBufferBody(serverId, requestId, asText === true);
      } catch (error) {
        resolveBuffer = null;
        rejectBuffer = null;
        throw error;
      }
      if (claimed !== true) {
        resolveBuffer = null;
        rejectBuffer = null;
        return null;
      }

      jsBodyStarted = true;
      nativeBuffering = true;
      bufferPromise = pending;
      state.wantsData = false;
      return bufferPromise;
    },
    pendingBodyRead() {
      return nativeBuffering ? bufferPromise : null;
    },
    tryForwardResponse(responseBody, expectedRequestId, status, headers) {
      if (nativeFinished || nativeForwarding || nativeBuffering || state.bodySettled || jsBodyStarted ||
          expectedRequestId !== requestId || responseBody !== state.body || responseBody?.locked ||
          responseBody?._disturbed === true || responseBody?.readableDidRead === true ||
          responseBody?.readableAborted === true) {
        return null;
      }

      const pending = new Promise(resolve => { resolveForward = resolve; });
      const claimed = binding.httpServerResponseForwardBody(
        serverId,
        requestId,
        status,
        headers,
      );
      if (claimed !== true) {
        resolveForward = null;
        return null;
      }

      nativeForwarding = true;
      forwardPromise = pending;
      state.bodySettled = true;
      state.wantsData = false;
      try { bodyController?.close(); } catch {}
      bodyController = null;
      try { responseBody._disturbed = true; } catch {}
      return forwardPromise;
    },
    dispose() {
      if (nativeFinished) return;
      state.finishResponse();
      nativeFinished = true;
      state.wantsData = false;
      state.polling = false;
      state.lifecycleRequest = null;
      state.body = null;
      bodyController = null;
      abortController = null;
      state.abortController = null;
      settleForward();
      settleBuffer(null, new globalThis.DOMException("The operation was aborted.", "AbortError"));
    },
    poll() {
      if (nativeFinished || isServerClosed() || state.polling) return;
      state.polling = true;
      try {
        const event = binding.httpServerRequestEventPoll(serverId, requestId, state.wantsData);
        if (!event) return;
        if (event.type === "abort") {
          state.abortConnection();
          settleForward();
          return;
        }
        if (event.type === "responseEnd") {
          settleForward();
          return;
        }
        if (event.type === "bufferedBody" || event.type === "bufferedText") {
          state.bodySettled = true;
          state.wantsData = false;
          try { bodyController?.close(); } finally { bodyController = null; }
          settleBuffer(event.data);
          onProgress?.();
          return;
        }
        if (state.bodySettled) return;
        if (event.type === "data") {
          state.wantsData = false;
          const bytes = new Uint8Array(event.data);
          if (bytes.byteLength > 0) bodyController?.enqueue(bytes);
          onProgress?.();
        } else if (event.type === "end") {
          state.wantsData = false;
          state.bodySettled = true;
          try { bodyController?.close(); } finally { bodyController = null; }
          onProgress?.();
        }
      } finally {
        state.polling = false;
      }
    },
  };

  if (hasBody) {
    state.body = trackServeReadableStream(new globalThis.ReadableStream({
      start(controller) {
        bodyController = controller;
      },
      pull() {
        if (state.bodySettled) return undefined;
        jsBodyStarted = true;
        state.wantsData = true;
        state.poll();
        return undefined;
      },
      cancel() {
        if (state.bodySettled) return undefined;
        jsBodyStarted = true;
        state.bodySettled = true;
        state.wantsData = false;
        bodyController = null;
        state.cancelNativeBody();
        return undefined;
      },
    }, new globalThis.ByteLengthQueuingStrategy({ highWaterMark: 0 })));
    Object.defineProperty(state.body, bodyStateSymbol, { value: state });
  }

  return state;
}
