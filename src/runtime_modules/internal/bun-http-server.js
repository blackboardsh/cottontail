export function incomingRequestURLFactory(protocol, host, target, fallbackOrigin, normalizeURL) {
  const rawTarget = String(target ?? "/");
  const requestBase = host ? `${protocol}//${host}` : String(fallbackOrigin);
  const isAbsolute = /^https?:\/\//i.test(rawTarget);
  return () => normalizeURL(isAbsolute ? rawTarget : `${requestBase}${rawTarget}`);
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
