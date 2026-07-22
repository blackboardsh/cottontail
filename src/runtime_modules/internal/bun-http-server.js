export function incomingRequestURLFactory(protocol, host, target, fallbackOrigin, normalizeURL) {
  const rawTarget = String(target ?? "/");
  const requestBase = host ? `${protocol}//${host}` : String(fallbackOrigin);
  const isAbsolute = /^https?:\/\//i.test(rawTarget);
  return () => normalizeURL(isAbsolute ? rawTarget : `${requestBase}${rawTarget}`);
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

export function createNativeServeRequestState(item, options) {
  const {
    binding,
    serverId,
    isServerClosed,
    bodyStateSymbol,
    unreadBodyAbortReason,
    connectionClosedError,
  } = options;
  const requestId = item.id;
  const hasBody = Boolean(item.hasBody);
  let bodyController = null;
  let nativeFinished = false;
  let abortController = new globalThis.AbortController();

  const state = {
    abortController,
    lifecycleRequest: null,
    body: null,
    bodySettled: !hasBody,
    wantsData: false,
    polling: false,
    cancelNativeBody() {
      if (nativeFinished || isServerClosed() || !hasBody) return;
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
      state.abortBody(new globalThis.DOMException("The operation was aborted.", "AbortError"), false);
      if (abortController && !abortController.signal.aborted) abortController.abort(connectionClosedError());
    },
    forceAbort() {
      state.abortBody(new globalThis.DOMException("The operation was aborted.", "AbortError"));
      if (abortController && !abortController.signal.aborted) abortController.abort(connectionClosedError());
    },
    finishResponse(response = null) {
      if (state.bodySettled || response?._body === state.body) return;
      state.abortBody(unreadBodyAbortReason());
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
    },
    poll() {
      if (nativeFinished || isServerClosed() || state.polling) return;
      state.polling = true;
      try {
        const event = binding.httpServerRequestEventPoll(serverId, requestId, state.wantsData);
        if (!event) return;
        if (event.type === "abort") {
          state.abortConnection();
          return;
        }
        if (state.bodySettled) return;
        if (event.type === "data") {
          state.wantsData = false;
          const bytes = new Uint8Array(event.data);
          if (bytes.byteLength > 0) bodyController?.enqueue(bytes);
        } else if (event.type === "end") {
          state.wantsData = false;
          state.bodySettled = true;
          try { bodyController?.close(); } finally { bodyController = null; }
        }
      } finally {
        state.polling = false;
      }
    },
  };

  if (hasBody) {
    state.body = new globalThis.ReadableStream({
      start(controller) {
        bodyController = controller;
      },
      pull() {
        if (state.bodySettled) return undefined;
        state.wantsData = true;
        state.poll();
        return undefined;
      },
      cancel() {
        if (state.bodySettled) return undefined;
        state.bodySettled = true;
        state.wantsData = false;
        bodyController = null;
        state.cancelNativeBody();
        return undefined;
      },
    }, new globalThis.ByteLengthQueuingStrategy({ highWaterMark: 0 }));
    Object.defineProperty(state.body, bodyStateSymbol, { value: state });
  }

  return state;
}
