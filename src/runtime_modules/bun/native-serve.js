export function startNativeServe(options, runtime) {
  const {
    CottontailAbortController,
    Response,
    abortActiveServeRequests,
    activeServeDispatches,
    activeServeLifecycles,
    activeServeOrigins,
    activeServeRequestBodyStateSymbol,
    activeServeUnreadBodyAbortError,
    arrayBufferFromBytes,
    binding: cottontail,
    bytesFromBody,
    bytesFromData,
    configuredMaxRequestBodySize,
    consumeStreamingBody,
    createNativeServeRequestOperation,
    createNativeServeRequestState,
    createServeLifecycle,
    defaultServePort,
    dispatchServeFetch,
    finalizeServeInspector,
    finishActiveServeRequestBody,
    headersToText,
    hostname,
    incomingRequestURLFactory,
    inspectorReload,
    isPromiseLike,
    isStreamingBody,
    normalizeRequestUrl,
    normalizeResponseResult,
    normalizeServeDateHeader,
    normalizeServeListenErrorCode,
    parseHeadersText,
    registerServeHtmlOptions,
    requestIdleTimeout,
    requestWithLazyURL,
    runServeHandler,
    serveHtmlStateSymbol,
    serveRequestPeers,
    serveResponseWithIdleTimeout,
    serveUnixUrlText,
    setServeRequestIdleTimeout,
    unixPath,
  } = runtime;

  let native;
  try {
      const preboundKey = Symbol.for("cottontail.preboundHttpServer");
      const prebound = globalThis[preboundKey];
      const requestedPort = defaultServePort(options);
      if (
        prebound?.native != null &&
        !unixPath &&
        hostname === "localhost" &&
        Number(prebound.requestedPort) === requestedPort
      ) {
        native = prebound.native;
        delete globalThis[preboundKey];
      } else {
        const preboundFd = Number(prebound?.fd);
        if (Number.isInteger(preboundFd) && preboundFd >= 0) {
          try { cottontail.closeFd(preboundFd); } catch {}
        }
        if (prebound?.native != null) {
          try { cottontail.httpServerStop(prebound.native.id, true); } catch {}
        }
        if (prebound != null) delete globalThis[preboundKey];
        native = cottontail.httpServerStart(
          hostname,
          requestedPort,
          unixPath || undefined,
          configuredMaxRequestBodySize,
        );
      }
    } catch (rawError) {
      const reason = rawError instanceof Error ? rawError.message : String(rawError);
      const error = rawError instanceof Error
        ? rawError
        : new Error(
            unixPath
              ? `Failed to listen on unix socket ${unixPath}: ${reason}`
              : `Failed to start server. ${reason}`,
          );
      throw normalizeServeListenErrorCode(error, reason);
    }
  const isUnix = unixPath.length > 0;
  const nativeDisplayHostname = String(native.hostname ?? hostname).includes(":") && !String(native.hostname ?? hostname).startsWith("[")
      ? `[${native.hostname}]`
      : native.hostname;
  const requestOrigin = isUnix ? "http://localhost" : `http://${nativeDisplayHostname}:${native.port}`;
  let activeOptions = options;
  let nativeClosed = false;
  let pumping = false;
  let interval = null;
  let publicUrl = null;
  const requestTargetCache = { version: 0, target: null, url: null };
  const maxConcurrentNativeRequests = 256;
  const originKeys = isUnix ? [] : [
      requestOrigin,
      ...(native.hostname === "0.0.0.0" ? [`http://127.0.0.1:${native.port}`, `http://localhost:${native.port}`] : []),
  ];
  const nativeRequests = new Map();
  let server;
  const lifecycle = createServeLifecycle(() => 0);
  server = {
      id: options.id ?? native.id,
      hostname: isUnix ? undefined : native.hostname,
      port: isUnix ? undefined : native.port,
      address: isUnix ? native.address : {
        address: native.hostname,
        family: "IPv4",
        port: native.port,
      },
      development: activeOptions.development ?? false,
      get pendingRequests() {
        return lifecycle.pendingRequests;
      },
      pendingWebSockets: 0,
      protocol: "http",
      get url() {
        publicUrl ??= new globalThis.URL(isUnix ? serveUnixUrlText(unixPath) : `${requestOrigin}/`);
        return publicUrl;
      },
      stop(force = false) {
        return lifecycle.stop(force);
      },
      [Symbol.dispose]() {
        server.stop(true);
      },
      [Symbol.asyncDispose]() {
        return server.stop(true);
      },
      reload(nextOptions = {}) {
        registerServeHtmlOptions(activeOptions[serveHtmlStateSymbol], nextOptions);
        activeOptions = { ...activeOptions, ...nextOptions };
        server.development = activeOptions.development ?? false;
        return server;
      },
      async fetch(input, init = {}) {
        if (typeof activeOptions.fetch !== "function") {
          throw new Error("fetch() requires the server to have a fetch handler");
        }
        return dispatchServeFetch(activeOptions, server, input, init);
      },
      ref() {
        interval?.ref?.();
        return server;
      },
      unref() {
        interval?.unref?.();
        return server;
      },
      requestIP(request) {
        const peer = serveRequestPeers.get(request);
        return peer ? { ...peer } : null;
      },
      closeIdleConnections() {
        if (!nativeClosed) cottontail.httpServerCloseIdle(native.id);
      },
      timeout(request, seconds) {
        return setServeRequestIdleTimeout(request, seconds, isUnix, arguments.length);
      },
      upgrade() {
        return false;
      },
      publish() {
        return 0;
      },
      subscriberCount() {
        return 0;
      },
    };
  activeServeDispatches.set(server, (input, init) => dispatchServeFetch(activeOptions, server, input, init));
  activeServeLifecycles.set(server, lifecycle);
  for (const origin of originKeys) activeServeOrigins.set(origin, server);
  const respond = (item, status, headersText, body) => {
      if (nativeClosed) return;
      try {
        cottontail.httpServerRespond(native.id, item.id, status, headersText, body);
      } catch (error) {
        if (nativeClosed && String(error).includes("HTTP server not found")) return;
        throw error;
      }
    };
  const nativeConnectionClosedError = () => {
      const error = new Error("The socket connection was closed unexpectedly.");
      error.code = "ECONNRESET";
      return error;
    };
  let bodyPumpQueued = false;
  const scheduleNativeBodyPump = () => {
      if (nativeClosed || bodyPumpQueued) return;
      bodyPumpQueued = true;
      queueMicrotask(() => {
        bodyPumpQueued = false;
        pump();
      });
    };
  const createNativeRequestState = (item) => createNativeServeRequestState(item, {
      binding: cottontail,
      serverId: native.id,
      isServerClosed: () => nativeClosed,
      bodyStateSymbol: activeServeRequestBodyStateSymbol,
      unreadBodyAbortReason: () => activeServeUnreadBodyAbortError,
      connectionClosedError: nativeConnectionClosedError,
      createAbortController: () => new CottontailAbortController(),
      onProgress: scheduleNativeBodyPump,
    });
  const responseBody = (response) => {
      if (response instanceof Response) {
        const body = response._takeBody();
        if (body == null || typeof body === "string" || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
          return arrayBufferFromBytes(bytesFromData(body));
        }
        return bytesFromBody(body).then(arrayBufferFromBytes);
      }
      return response.arrayBuffer();
  };
  const sendStreamingResponse = async (item, response, status, headers) => {
      if (nativeClosed) return;
      const nativeBodyState = response._body?.[activeServeRequestBodyStateSymbol];
      const forwarded = nativeBodyState?.tryForwardResponse?.(
        response._body,
        item.id,
        status,
        headers,
      );
      if (forwarded != null) {
        response._bodyUsed = true;
        await forwarded;
        return;
      }
      const body = response._takeBody();
      let responseStarted = false;
      const startResponse = () => {
        if (responseStarted) return;
        cottontail.httpServerResponseStart(native.id, item.id, status, headers);
        responseStarted = true;
      };
      const writeChunk = (chunk) => {
        const bytes = bytesFromData(chunk);
        if (bytes.byteLength > 0) cottontail.httpServerResponseWrite(native.id, item.id, bytes);
      };
      try {
        if (body && typeof body.getReader === "function") {
          const reader = body.getReader();
          const read = () => reader.read().then(
            (readResult) => ({ readResult, error: null }),
            (error) => ({ readResult: null, error }),
          );
          const pendingRead = read();
          const checkpoint = {};
          let checkpointTimer;
          let settled = await Promise.race([
            pendingRead,
            new Promise((resolve) => {
              checkpointTimer = setTimeout(() => resolve(checkpoint), 0);
            }),
          ]);
          if (settled === checkpoint) {
            startResponse();
            settled = await pendingRead;
          } else {
            clearTimeout(checkpointTimer);
          }
  
          for (;;) {
            if (settled.error != null) throw settled.error;
            if (settled.readResult.done) break;
            startResponse();
            writeChunk(settled.readResult.value);
            settled = await read();
          }
          startResponse();
        } else {
          startResponse();
          await consumeStreamingBody(body, writeChunk);
        }
        cottontail.httpServerResponseEnd(native.id, item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!nativeClosed) console.error(`error: ${message}`);
        try {
          startResponse();
          cottontail.httpServerResponseEnd(native.id, item.id);
        } catch {
          try {
            cottontail.httpServerResponseAbort(native.id, item.id);
          } catch {}
        }
      }
    };
  const sendResponse = (item, response, statusOverride = undefined) => {
      normalizeServeDateHeader(response.headers);
      const status = statusOverride ?? response.status;
      const headers = headersToText(response.headers, String(item.method).toUpperCase() === "HEAD");
      if (isStreamingBody(response._body)) {
        return sendStreamingResponse(item, response, status, headers);
      }
      const body = responseBody(response);
      if (isPromiseLike(body)) {
        return body.then(
          (resolvedBody) => respond(item, status, headers, resolvedBody),
          (error) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`error: ${message}`);
            respond(item, status, headers, arrayBufferFromBytes(new Uint8Array(0)));
          },
        );
      }
      respond(item, status, headers, body);
      return undefined;
    };
  const handleError = (item, error) => {
      const fallbackResponse = (cause) => {
        const text = cause instanceof Error ? cause.stack || cause.message : String(cause);
        const createResponse = () => {
          const remap = globalThis.__cottontailRemapStackString;
          return new Response(typeof remap === "function" ? remap(text) : text, {
            status: 500,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        };
        if (typeof globalThis.__cottontailRemapStackString === "function") return createResponse();
        return import("../internal/runtime-stack-remap.js").then(createResponse, createResponse);
      };
      let response;
      if (typeof activeOptions.error === "function") {
        try {
          response = normalizeResponseResult(activeOptions.error(error));
        } catch (nextError) {
          response = fallbackResponse(nextError);
        }
      } else {
        response = fallbackResponse(error);
      }
  
      if (isPromiseLike(response)) {
        return response.then(
          (resolvedResponse) => sendResponse(item, resolvedResponse),
          (nextError) => sendResponse(item, fallbackResponse(nextError)),
        );
      }
      return sendResponse(item, response);
    };
  const handle = (operation) => {
      const item = operation.item;
      const state = operation.state;
      const requestHeaders = parseHeadersText(item.headersText);
      const requestInit = {
        method: item.method,
        headers: requestHeaders,
        signal: state.abortController.signal,
      };
      if (String(item.method).toUpperCase() !== "GET" && String(item.method).toUpperCase() !== "HEAD") {
        requestInit.body = state.body;
      }
      const request = requestWithLazyURL(
        incomingRequestURLFactory(
          "http:",
          requestHeaders.get("host"),
          item.url,
          requestOrigin,
          normalizeRequestUrl,
          requestTargetCache,
          item.urlCacheVersion,
          item.urlCacheHit,
        ),
        requestInit,
      );
      operation.attachRequest(request);
      if (item.remote) serveRequestPeers.set(request, item.remote);
      const sendHandledResponse = (response) => {
        const item = operation.item;
        const request = operation.request;
        if (item == null || request == null || nativeClosed) return undefined;
        finishActiveServeRequestBody(request, response);
        const sent = sendResponse(item, serveResponseWithIdleTimeout(
          response,
          requestIdleTimeout(request, activeOptions.idleTimeout),
        ));
        const bodyRead = state.pendingBodyRead?.();
        if (bodyRead == null) return sent;
        return isPromiseLike(sent) ? Promise.resolve(sent).then(() => bodyRead) : bodyRead;
      };
      const sendHandledError = (error) => {
        const item = operation.item;
        const request = operation.request;
        if (item == null || request == null || nativeClosed) return undefined;
        finishActiveServeRequestBody(request, null);
        return handleError(item, error);
      };
      try {
        const response = runServeHandler(activeOptions, request, server);
        if (isPromiseLike(response)) {
          return response
            .then(sendHandledResponse)
            .catch(sendHandledError);
        }
        return sendHandledResponse(response);
      } catch (error) {
        return sendHandledError(error);
      }
    };
  const finishNativeRequest = (operation) => {
      const state = operation.state;
      if (state == null) return;
      state.finishResponse();
      nativeRequests.delete(operation.id);
      lifecycle.finishRequest(state.lifecycleRequest);
      operation.dispose();
    };
  const maybeFinishNativeStop = () => {
      if (!lifecycle.stopRequested || lifecycle.forceRequested || nativeClosed || nativeRequests.size !== 0) return;
      const status = cottontail.httpServerStatus(native.id);
      if (status == null || Number(status.activeClients) !== 0) return;
      nativeClosed = true;
      if (interval != null) {
        clearInterval(interval);
        interval = null;
      }
      cottontail.httpServerStop(native.id, false);
      lifecycle.markTransportDrained();
    };
  const stopNativeTransport = (force) => {
      for (const origin of originKeys) activeServeOrigins.delete(origin);
      if (force) {
        abortActiveServeRequests(server);
        for (const operation of nativeRequests.values()) {
          operation.forceAbort();
          operation.dispose();
        }
        nativeClosed = true;
        if (interval != null) {
          clearInterval(interval);
          interval = null;
        }
        nativeRequests.clear();
        cottontail.httpServerStop(native.id, true);
        lifecycle.markTransportDrained();
        return;
      }
      cottontail.httpServerStopListening(native.id);
      maybeFinishNativeStop();
    };
  lifecycle.configure(stopNativeTransport, () => stopNativeTransport(true));
  const pollNativeRequestEvents = () => {
      for (const operation of nativeRequests.values()) operation.poll();
    };
  const pump = () => {
      if (nativeClosed || pumping) return;
      if (globalThis.__cottontailProcessIpcPending === true) return;
      pumping = true;
      pollNativeRequestEvents();
      if ((globalThis.__cottontailPollProcessIpc?.() ?? 0) > 0) {
        cottontail.drainJobs?.();
        pumping = false;
        maybeFinishNativeStop();
        return;
      }
      while (!nativeClosed && server.pendingRequests < maxConcurrentNativeRequests) {
        const item = cottontail.httpServerPoll(native.id);
        if (!item) break;
        const state = createNativeRequestState(item);
        const operation = createNativeServeRequestOperation(item, state);
        state.lifecycleRequest = lifecycle.beginRequest(() => operation.forceAbort());
        nativeRequests.set(operation.id, operation);
        const handled = handle(operation);
        if (isPromiseLike(handled)) {
          Promise.resolve(handled).then(
            () => {
              finishNativeRequest(operation);
              pump();
            },
            (error) => {
              console.error(error instanceof Error ? error.stack || error.message : error);
              finishNativeRequest(operation);
              pump();
            },
          );
        } else {
          finishNativeRequest(operation);
        }
      }
      pollNativeRequestEvents();
      pumping = false;
      maybeFinishNativeStop();
    };
  interval = setInterval(pump, 1);
  pump();
  return finalizeServeInspector(server, activeOptions, inspectorReload);
}
