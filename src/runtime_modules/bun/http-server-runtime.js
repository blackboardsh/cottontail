import "./core-bootstrap.js";
import "./encoding.js";
import * as streams from "../node/stream/whatwg.js";
import { URL, URLSearchParams } from "../vendor/whatwg-url.js";
import {
  bodyStreamFor as lifecycleBodyStreamFor,
  bodyStreamIsDisturbed,
  bodyValueForConsumption as lifecycleBodyValueForConsumption,
  bodyWasUsed,
  takeBody as lifecycleTakeBody,
} from "./web-body-lifecycle.js";
import { createRequestResponseRuntime } from "./web-request-response.js";
import { createWebPrimitives } from "./web-primitives.js";
import { createLazyFunction } from "./lazy-runtime.js";
import { asBuffer, concatManyBuffers } from "./web-buffer-utils.js";
import { startNativeServe } from "./native-serve.js";
import {
  createNativeServeRequestOperation,
  createNativeServeRequestState,
  createServeLifecycle,
  incomingRequestURLFactory,
} from "../internal/bun-http-server.js";
import { installInheritedBunIpcCodec, installInheritedNodeIpc } from "../internal/bun-spawn-ipc.js";
import { captureV8HeapSnapshot } from "../node/internal/heap_snapshot.js";
import { isBunFileLike } from "./file-like.js";

const binding = globalThis.cottontail;

for (const [name, value] of Object.entries(streams)) {
  if (typeof value === "function") globalThis[name] ??= value;
}

function nodeInspect(value) {
  const custom = value?.[Symbol.for("nodejs.util.inspect.custom")];
  if (typeof custom === "function") {
    try { return String(custom.call(value, 2, {})); } catch {}
  }
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function bunInspectPropertyDescriptor(value, key) {
  for (let current = value; current != null; current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

function handledRejectedPromise(reason) {
  const promise = Promise.reject(reason);
  promise.catch(() => {});
  return promise;
}

function isPromiseLike(value) {
  return value != null && typeof value.then === "function";
}

function wrapAsyncCallback(callback) {
  const wrap = globalThis.__cottontailWrapAsyncCallback;
  return typeof wrap === "function" ? wrap(callback) : callback;
}

function isStreamingBody(body) {
  if (typeof body === "function") return true;
  return body != null && (
    typeof body.getReader === "function" ||
    typeof body[Symbol.asyncIterator] === "function"
  );
}

function randomBytes(size) {
  const bytes = binding.randomBytes(Number(size));
  return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : new Uint8Array(bytes);
}

const estimatedMemoryCostSymbol = Symbol.for("cottontail.estimatedMemoryCost");
const ctInspectSymbol = Symbol.for("nodejs.util.inspect.custom");
const activeServeOrigins = globalThis.__cottontailActiveServeOrigins ??= new Map();
const activeServeDispatches = globalThis.__cottontailActiveServeDispatches ??= new WeakMap();
const activeServeAbortControllers = globalThis.__cottontailActiveServeAbortControllers ??= new WeakMap();
const activeServeLifecycles = globalThis.__cottontailActiveServeLifecycles ??= new WeakMap();
const activeServeRequestBodyStateSymbol = Symbol("cottontail.activeServeRequestBodyState");
const serveUpgradeContexts = new WeakMap();
const serveRequestPeers = new WeakMap();
const serveHtmlStateSymbol = Symbol("cottontail.serveHtmlState");

const {
  BunFile,
  CottontailAbortController,
  CottontailAbortSignal,
  CottontailCloseEvent,
  CottontailCustomEvent,
  CottontailDOMException,
  CottontailErrorEvent,
  CottontailEvent,
  CottontailEventTarget,
  isAbortSignal,
} = createWebPrimitives(nodeInspect);

globalThis.DOMException ??= CottontailDOMException;
globalThis.Event ??= CottontailEvent;
globalThis.EventTarget ??= CottontailEventTarget;
globalThis.CustomEvent ??= CottontailCustomEvent;
globalThis.ErrorEvent ??= CottontailErrorEvent;
globalThis.CloseEvent ??= CottontailCloseEvent;
globalThis.File ??= BunFile;
globalThis.AbortSignal ??= CottontailAbortSignal;
globalThis.AbortController ??= CottontailAbortController;

const activeServeUnreadBodyAbortError = new globalThis.DOMException(
  "The operation was aborted.",
  "AbortError",
);
let cookieRuntime;
const loadCookieRuntime = () => cookieRuntime ??=
  globalThis.Cottontail.cookies.createCookieRuntime(nodeInspect);
const Cookie = createLazyFunction(loadCookieRuntime, "Cookie");
const CookieMap = createLazyFunction(loadCookieRuntime, "CookieMap");

const {
  arrayBufferFromBytes,
  bytesFromBody,
  bytesFromData,
  consumeStreamingBody,
  FormData,
  Headers,
  normalizeRequestUrl,
  Request,
  requestState,
  requestWithLazyURL,
  Response,
  responseWithMetadata,
} = createRequestResponseRuntime({
  activeServeRequestBodyStateSymbol,
  asBuffer,
  bodyStreamIsDisturbed,
  bodyWasUsed,
  bunInspectPropertyDescriptor,
  concatManyBuffers,
  CookieMap,
  ctInspectSymbol,
  estimatedMemoryCostSymbol,
  handledRejectedPromise,
  isAbortSignal,
  isBunFileLike,
  isStreamingBody,
  lifecycleBodyStreamFor,
  lifecycleBodyValueForConsumption,
  lifecycleTakeBody,
  nodeInspect,
  randomBytes,
  serveUpgradeContexts,
  URL,
  URLSearchParams,
});

globalThis.Headers = Headers;
globalThis.FormData = FormData;
globalThis.Request = Request;
globalThis.Response = Response;
globalThis.URL = URL;
globalThis.URLSearchParams = URLSearchParams;

function setServeRequestIdleTimeout(request, seconds, isUnix, argumentCount) {
  if (argumentCount < 2 || request == null) {
    throw new TypeError(`timeout() requires 2 arguments, got ${argumentCount}`);
  }
  if (isUnix) return null;
  if (typeof seconds !== "number") throw new TypeError("timeout() requires a number");
  const integer = Number.isFinite(seconds) ? Math.trunc(seconds) : 0;
  const value = Math.min(255, integer >>> 0);
  if (!(request instanceof Request)) throw new TypeError("timeout() requires a Request object");
  const state = requestState.get(request);
  if (state == null) throw new TypeError("timeout() requires a Request object");
  state.serveIdleTimeout = value;
  return undefined;
}

function requestIdleTimeout(request, fallback) {
  return requestState.get(request)?.serveIdleTimeout ?? fallback;
}

function abortActiveServeRequests(server) {
  const controllers = activeServeAbortControllers.get(server);
  if (controllers == null) return;
  const error = new Error("The socket connection was closed unexpectedly.");
  error.code = "ECONNRESET";
  for (const controller of controllers) controller.abort(error);
  controllers.clear();
}

function finishActiveServeRequestBody(request, response) {
  const body = request?._body;
  const state = body?.[activeServeRequestBodyStateSymbol];
  if (!state || state.bodySettled || response?._body === body) return;
  // The handler may have attached a reader (or otherwise started consuming
  // the body) intending to read it while the response streams back. Only
  // abort a body that was never exposed for reading; anything left unread is
  // still force-aborted when the request is disposed after the response ends.
  if (body != null && (body.locked === true || bodyStreamIsDisturbed(body))) return;
  state.abort(activeServeUnreadBodyAbortError);
}

function parseHeadersText(text) {
  const headers = new Headers();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return headers;
}

function headersToText(headers, preserveFraming = false) {
  let out = "";
  const normalized = new Headers(headers);
  if (!preserveFraming) {
    normalized.delete("content-length");
    normalized.delete("transfer-encoding");
  }
  normalized.delete("connection");
  for (const key of [...normalized._values.keys()].sort()) {
    const entry = normalized._values.get(key);
    const values = key === "set-cookie" ? normalized._allValues.get(key) ?? [] : [entry.value];
    for (const value of values) {
      out += `${entry.key}: ${String(value).replace(/[\r\n]+/g, " ")}\r\n`;
    }
  }
  return out;
}

let cachedServeDateSecond = -1;
let cachedServeDateValue = "";

function cachedServeDateHeader() {
  const second = Math.floor(Date.now() / 1000);
  if (second !== cachedServeDateSecond) {
    cachedServeDateSecond = second;
    cachedServeDateValue = new Date(second * 1000).toUTCString();
  }
  return cachedServeDateValue;
}

function normalizeServeDateHeader(headers) {
  headers.set("Date", headers.get("date") ?? cachedServeDateHeader());
}

function appendRequestCookieHeaders(response, request) {
  const cookies = request?._cookies;
  if (!cookies || response.__cottontailCookieChangesApplied) return;
  for (const header of cookies.toSetCookieHeaders()) response.headers.append("Set-Cookie", header);
  Object.defineProperty(response, "__cottontailCookieChangesApplied", {
    value: true,
    configurable: true,
  });
}

function normalizeResponse(value, request = undefined) {
  const response = value instanceof Response ? value : new Response(value);
  normalizeServeDateHeader(response.headers);
  appendRequestCookieHeaders(response, request);
  return response;
}

function normalizeResponseResult(value) {
  return isPromiseLike(value) ? value.then(normalizeResponse) : normalizeResponse(value);
}

function defaultServePort(options) {
  if (options.port != null) return Number(options.port);
  for (const name of ["BUN_PORT", "PORT", "NODE_PORT"]) {
    const value = globalThis.process?.env?.[name] ?? binding.env(name);
    if (value != null && value !== "") return Number(value);
  }
  return 3000;
}

function requestBodyByteSize(body) {
  if (body == null) return 0;
  const activeState = body?.[activeServeRequestBodyStateSymbol];
  if (activeState?.byteSize != null) return activeState.byteSize;
  if (typeof body === "string") return new TextEncoder().encode(body).byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return null;
}

function prepareHandlerResponse(value, request) {
  const response = value instanceof Response
    ? value
    : new Response("Welcome to Cottontail! To get started, return a Response object.", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  return normalizeResponse(response, request);
}

function runServeHandler(options, request, server) {
  const maxRequestBodySize = Number(options.maxRequestBodySize ?? 128 * 1024 * 1024);
  if (Number.isFinite(maxRequestBodySize) && maxRequestBodySize > 0) {
    const bodySize = requestBodyByteSize(request._body);
    if (bodySize != null && bodySize > maxRequestBodySize) {
      return new Response(null, { status: 413, statusText: "Payload Too Large" });
    }
  }
  const value = options.fetch.call(server, request, server);
  return isPromiseLike(value)
    ? value.then((resolved) => prepareHandlerResponse(resolved, request))
    : prepareHandlerResponse(value, request);
}

function normalizedServeDispatchRequest(request) {
  const url = normalizeRequestUrl(request.url);
  if (url === request.url) return request;
  const normalized = new Request(url, {
    method: request.method,
    headers: new Headers(request.headers),
    signal: request.signal,
    redirect: request.redirect,
  });
  normalized._body = request._body;
  return normalized;
}

function serveResponseWithIdleTimeout(response, idleTimeoutSeconds) {
  const timeoutMs = Number(idleTimeoutSeconds) * 1000;
  const body = response?._body;
  if (!(timeoutMs > 0) || !isStreamingBody(body) || typeof body?.getReader !== "function") return response;

  const reader = body.getReader();
  let controller;
  let timer = null;
  let settled = false;
  let pendingRead = null;
  const clearTimer = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const fail = () => {
    if (settled) return;
    settled = true;
    timer = null;
    const error = new Error("The socket connection was closed unexpectedly.");
    error.code = "ECONNRESET";
    try { controller.error(error); } catch {}
    try { Promise.resolve(reader.cancel(error)).catch(() => {}); } catch {}
  };
  const armTimer = () => {
    clearTimer();
    timer = setTimeout(fail, timeoutMs);
  };
  const stream = new globalThis.ReadableStream({
    start(value) {
      controller = value;
      armTimer();
    },
    pull() {
      if (settled) return undefined;
      if (pendingRead != null) return pendingRead;
      pendingRead = Promise.resolve(reader.read()).then(
        (result) => {
          if (settled) return;
          if (result.done) {
            settled = true;
            clearTimer();
            controller.close();
            return;
          }
          controller.enqueue(result.value);
          armTimer();
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimer();
          controller.error(error);
        },
      ).finally(() => {
        pendingRead = null;
      });
      return pendingRead;
    },
    cancel(reason) {
      if (settled) return undefined;
      settled = true;
      clearTimer();
      return reader.cancel(reason);
    },
  });
  return responseWithMetadata(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  }, {
    url: response.url,
    redirected: response.redirected,
    type: response.type,
  });
}

function serveErrorResponse(options, error) {
  const fallback = (cause) => new Response(
    cause instanceof Error ? cause.stack || cause.message : String(cause),
    { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
  if (typeof options.error !== "function") return normalizeResponse(fallback(error));
  try {
    return normalizeResponseResult(options.error(error));
  } catch (nextError) {
    return normalizeResponse(fallback(nextError));
  }
}

const serveDispatchFinishedSymbol = Symbol.for("cottontail.serveDispatchFinished");

function markServeDispatchFinished(request, response) {
  if (request == null) return;
  const responseBody = response?._body;
  if (responseBody != null && (responseBody === request._body || responseBody === request._bodyStream)) return;
  request[serveDispatchFinishedSymbol] = true;
}

// In-process dispatch has no post-response disposal step like the native
// transport; force-abort a request body left unread once the response is
// complete so pending reads reject with AbortError as over a real socket.
function disposeServeDispatchRequestBody(request, response) {
  const body = request?._body;
  const state = body?.[activeServeRequestBodyStateSymbol];
  if (!state || state.settled || response?._body === body) return;
  if (isStreamingBody(response?._body)) return;
  state.abort(new globalThis.DOMException("The connection was closed.", "AbortError"));
}

async function dispatchServeFetch(options, server, input, init = {}) {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const dispatchRequest = normalizedServeDispatchRequest(request);
  let response;
  try {
    const pending = runServeHandler(options, dispatchRequest, server);
    // A synchronously returned response means the handler can never consume
    // the request body afterwards; pending reads must reject with AbortError
    // like they do over a real socket.
    if (!isPromiseLike(pending)) markServeDispatchFinished(dispatchRequest, pending);
    response = await pending;
  } catch (error) {
    response = await serveErrorResponse(options, error);
  }
  markServeDispatchFinished(dispatchRequest, response);
  finishActiveServeRequestBody(dispatchRequest, response);
  disposeServeDispatchRequestBody(dispatchRequest, response);
  response = serveResponseWithIdleTimeout(response, requestIdleTimeout(dispatchRequest, options.idleTimeout));
  response.url = request.url;
  return response;
}

function normalizeServeListenErrorCode(error, reason = error?.message) {
  if (error?.code != null) return error;
  const text = String(reason ?? "");
  if (/(?:EADDRNOTAVAIL|cannot assign requested address|requested address is not valid)/i.test(text)) {
    error.code = "EADDRNOTAVAIL";
  } else if (/(?:EADDRINUSE|address (?:already )?in use|only one usage of each socket address)/i.test(text)) {
    error.code = "EADDRINUSE";
  }
  return error;
}

function validateLeanServeOptions(options, requireFetch = false) {
  if (options == null || typeof options !== "object") throw new TypeError("Bun.serve expects an object");
  const unsupported = ["routes", "static", "websocket", "tls", "cert", "key", "unix", "hostname"];
  for (const name of unsupported) {
    if (options[name] != null) {
      throw new TypeError(`Bun.serve ${name} requires the full runtime bootstrap`);
    }
  }
  if (requireFetch && typeof options.fetch !== "function") {
    throw new TypeError("Bun.serve requires a fetch handler");
  }
}

function serve(options) {
  validateLeanServeOptions(options, true);
  const normalized = {
    ...options,
    fetch: wrapAsyncCallback(options.fetch),
    ...(typeof options.error === "function" ? { error: wrapAsyncCallback(options.error) } : {}),
  };
  const configuredMaxRequestBodySize = Number(normalized.maxRequestBodySize ?? 128 * 1024 * 1024);
  const server = startNativeServe(normalized, {
    CottontailAbortController,
    Response,
    abortActiveServeRequests,
    activeServeDispatches,
    activeServeLifecycles,
    activeServeOrigins,
    activeServeRequestBodyStateSymbol,
    activeServeUnreadBodyAbortError,
    arrayBufferFromBytes,
    binding,
    bytesFromBody,
    bytesFromData,
    configuredMaxRequestBodySize,
    consumeStreamingBody,
    createNativeServeRequestOperation,
    createNativeServeRequestState,
    createServeLifecycle,
    defaultServePort,
    dispatchServeFetch,
    finalizeServeInspector: (server) => server,
    finishActiveServeRequestBody,
    headersToText,
    hostname: "localhost",
    incomingRequestURLFactory,
    inspectorReload: null,
    isPromiseLike,
    isStreamingBody,
    normalizeRequestUrl,
    normalizeResponseResult,
    normalizeServeDateHeader,
    normalizeServeListenErrorCode,
    parseHeadersText,
    registerServeHtmlOptions(_state, nextOptions) {
      validateLeanServeOptions(nextOptions);
    },
    requestIdleTimeout,
    requestWithLazyURL,
    runServeHandler,
    serveHtmlStateSymbol,
    serveRequestPeers,
    serveResponseWithIdleTimeout,
    serveUnixUrlText: () => "http://localhost/",
    setServeRequestIdleTimeout,
    unixPath: "",
  });
  return server;
}

installInheritedBunIpcCodec(binding);
installInheritedNodeIpc(binding);

const Bun = globalThis.Bun ??= {};
Bun.Cookie = Cookie;
Bun.CookieMap = CookieMap;
Bun.serve = serve;
globalThis.__cottontailHttpServerRuntime = true;

const previousRequire = globalThis.require;
globalThis.require = function require(specifier) {
  if (specifier === "v8" || specifier === "node:v8") {
    return {
      writeHeapSnapshot(filename = undefined) {
        const path = filename == null
          ? `Heap.${Date.now()}.${globalThis.process?.pid ?? 0}.heapsnapshot`
          : String(filename);
        binding.writeFile(path, captureV8HeapSnapshot());
        return path;
      },
    };
  }
  if (typeof previousRequire === "function") return previousRequire(specifier);
  throw new TypeError(`Cannot require ${String(specifier)} from the HTTP runtime bootstrap`);
};

export { Cookie, CookieMap, FormData, Headers, Request, Response, URL, URLSearchParams, serve };
