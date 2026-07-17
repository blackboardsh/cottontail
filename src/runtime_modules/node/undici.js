import EventEmitter from "./events.js";
import { Readable, Duplex, PassThrough } from "./stream.js";
import * as http from "./http.js";
import * as https from "./https.js";
import * as net from "./net.js";
import * as tls from "./tls.js";
import { Buffer } from "./buffer.js";

const kEmptyObject = Object.freeze(Object.create(null));

function namedError(name, code, Base = Error) {
  return class extends Base {
    constructor(message = name, options = undefined) {
      super(message, options);
      this.name = name;
      this.code = code;
    }
  };
}

const UndiciError = namedError("UndiciError", "UND_ERR");
const AbortError = namedError("AbortError", "UND_ERR_ABORTED", UndiciError);
const HTTPParserError = namedError("HTTPParserError", "HPE_INVALID_CONSTANT");
const HeadersTimeoutError = namedError("HeadersTimeoutError", "UND_ERR_HEADERS_TIMEOUT", UndiciError);
const HeadersOverflowError = namedError("HeadersOverflowError", "UND_ERR_HEADERS_OVERFLOW", UndiciError);
const BodyTimeoutError = namedError("BodyTimeoutError", "UND_ERR_BODY_TIMEOUT", UndiciError);
const RequestContentLengthMismatchError = namedError("RequestContentLengthMismatchError", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH", UndiciError);
const ConnectTimeoutError = namedError("ConnectTimeoutError", "UND_ERR_CONNECT_TIMEOUT", UndiciError);
const ResponseStatusCodeError = namedError("ResponseStatusCodeError", "UND_ERR_RESPONSE_STATUS_CODE", UndiciError);
const InvalidArgumentError = namedError("InvalidArgumentError", "UND_ERR_INVALID_ARG", UndiciError);
const InvalidReturnValueError = namedError("InvalidReturnValueError", "UND_ERR_INVALID_RETURN_VALUE", UndiciError);
const RequestAbortedError = namedError("RequestAbortedError", "UND_ERR_ABORTED", AbortError);
const ClientDestroyedError = namedError("ClientDestroyedError", "UND_ERR_DESTROYED", UndiciError);
const ClientClosedError = namedError("ClientClosedError", "UND_ERR_CLOSED", UndiciError);
const InformationalError = namedError("InformationalError", "UND_ERR_INFO", UndiciError);
const SocketError = namedError("SocketError", "UND_ERR_SOCKET", UndiciError);
const NotSupportedError = namedError("NotSupportedError", "UND_ERR_NOT_SUPPORTED", UndiciError);
const ResponseContentLengthMismatchError = namedError("ResponseContentLengthMismatchError", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH", UndiciError);
const BalancedPoolMissingUpstreamError = namedError("BalancedPoolMissingUpstreamError", "UND_ERR_BPL_MISSING_UPSTREAM", UndiciError);
const ResponseExceededMaxSizeError = namedError("ResponseExceededMaxSizeError", "UND_ERR_RES_EXCEEDED_MAX_SIZE", UndiciError);
const RequestRetryError = namedError("RequestRetryError", "UND_ERR_REQ_RETRY", UndiciError);
const SecureProxyConnectionError = namedError("SecureProxyConnectionError", "UND_ERR_PRX_TLS", UndiciError);
const MockNotMatchedError = namedError("MockNotMatchedError", "UND_MOCK_ERR_MOCK_NOT_MATCHED", UndiciError);

const errors = {
  AbortError,
  HTTPParserError,
  UndiciError,
  HeadersTimeoutError,
  HeadersOverflowError,
  BodyTimeoutError,
  RequestContentLengthMismatchError,
  ConnectTimeoutError,
  ResponseStatusCodeError,
  InvalidArgumentError,
  InvalidReturnValueError,
  RequestAbortedError,
  ClientDestroyedError,
  ClientClosedError,
  InformationalError,
  SocketError,
  NotSupportedError,
  ResponseContentLengthMismatchError,
  BalancedPoolMissingUpstreamError,
  ResponseExceededMaxSizeError,
  RequestRetryError,
  SecureProxyConnectionError,
};

function callbackifyPromise(promise, callback) {
  if (typeof callback !== "function") return promise;
  promise.then(value => callback(null, value), error => callback(error));
  return undefined;
}

function waitForWritableDrain(writable) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off?.("drain", onDrain);
      writable.off?.("error", onError);
      writable.off?.("close", onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new SocketError("Writable stream closed before draining")); };
    writable.once("drain", onDrain);
    writable.once("error", onError);
    writable.once("close", onClose);
  });
}

function waitForWritableFinish(writable) {
  if (writable.writableFinished || writable.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      writable.off?.("finish", onFinish);
      writable.off?.("error", onError);
      writable.off?.("close", onClose);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(error); };
    const onClose = () => {
      cleanup();
      if (writable.writableFinished) resolve();
      else reject(new SocketError("Writable stream closed before finishing"));
    };
    writable.once("finish", onFinish);
    writable.once("error", onError);
    writable.once("close", onClose);
  });
}

function rawHeaderPairs(headers) {
  const result = [];
  for (const [name, value] of headers) {
    result.push(Buffer.from(name), Buffer.from(String(value)));
  }
  return result;
}

function headersObject(headers) {
  if (typeof headers?.toJSON === "function") return headers.toJSON();
  const object = Object.create(null);
  for (const [name, value] of headers ?? []) object[name] = value;
  return object;
}

function normalizeAbortError(error) {
  if (error?.name !== "AbortError") return error;
  const normalized = new RequestAbortedError("The operation was aborted.", { cause: error });
  normalized.name = "AbortError";
  return normalized;
}

function appendQuery(URLSearchParams, url, query) {
  if (query == null) return url;
  const parsed = new URL(url);
  const values = query instanceof URLSearchParams ? query : new URLSearchParams(query);
  for (const [name, value] of values) parsed.searchParams.append(name, value);
  return parsed;
}

function urlFromOrigin(URL, origin, path = "/") {
  if (path instanceof URL) return path;
  const text = String(path ?? "/");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return new URL(text);
  if (origin == null) throw new InvalidArgumentError("A dispatcher origin is required for a relative request path");
  return new URL(text, origin);
}

export function createUndiciModule(primitives) {
  const {
    fetch,
    Response,
    Request,
    Headers,
    FormData,
    File,
    URL,
    URLSearchParams,
    AbortSignal,
    WebSocket,
    CloseEvent,
    ErrorEvent,
    MessageEvent,
    EventTarget,
  } = primitives;

  const kMockNetworkFallback = Symbol("undici.mock.networkFallback");

  function matchMockValue(matcher, value) {
    if (typeof matcher === "string") return matcher === value;
    if (matcher instanceof RegExp) {
      matcher.lastIndex = 0;
      return matcher.test(value);
    }
    if (typeof matcher === "function") return matcher(value) === true;
    if (Buffer.isBuffer(matcher) || matcher instanceof Uint8Array) {
      const actual = Buffer.isBuffer(value) || value instanceof Uint8Array
        ? Buffer.from(value)
        : Buffer.from(String(value ?? ""));
      return Buffer.from(matcher).equals(actual);
    }
    return Object.is(matcher, value);
  }

  function normalizeMockOrigin(origin) {
    if (typeof origin !== "string" && !(origin instanceof URL)) return origin;
    try {
      return new URL(String(origin)).origin.toLowerCase();
    } catch {
      return String(origin).toLowerCase();
    }
  }

  function normalizeMockPath(path, ignoreTrailingSlash = false) {
    if (typeof path !== "string") return path;
    const hash = path.indexOf("#");
    if (hash >= 0) path = path.slice(0, hash);
    const queryIndex = path.indexOf("?");
    if (queryIndex >= 0) {
      const search = new URLSearchParams(path.slice(queryIndex + 1));
      search.sort();
      path = `${path.slice(0, queryIndex)}?${search}`;
    }
    if (ignoreTrailingSlash) {
      const split = path.indexOf("?");
      const pathname = split < 0 ? path : path.slice(0, split);
      const query = split < 0 ? "" : path.slice(split);
      path = `${pathname.replace(/\/+$/, "") || "/"}${query}`;
    }
    return path;
  }

  function appendMockQuery(path, query) {
    if (query == null) return path;
    const parsed = new URL(String(path), "http://mock.invalid");
    const entries = query instanceof URLSearchParams ? query : Object.entries(query);
    for (const [name, rawValue] of entries) {
      if (Array.isArray(rawValue)) {
        for (const value of rawValue) parsed.searchParams.append(name, String(value));
      } else {
        parsed.searchParams.append(name, String(rawValue));
      }
    }
    return `${parsed.pathname}${parsed.search}`;
  }

  function mockHeadersObject(input) {
    const result = {};
    if (input == null) return result;
    if (Array.isArray(input) && (input.length === 0 || !Array.isArray(input[0]))) {
      for (let index = 0; index + 1 < input.length; index += 2) {
        result[String(input[index]).toLowerCase()] = String(input[index + 1]);
      }
      return result;
    }
    const headers = input instanceof Headers ? input : new Headers(input);
    for (const [name, value] of headers) result[name.toLowerCase()] = value;
    return result;
  }

  function matchMockHeaders(matcher, headers) {
    if (matcher === undefined) return true;
    if (typeof matcher === "function") return matcher(headers) === true;
    if (!matcher || typeof matcher !== "object") return false;
    for (const [name, valueMatcher] of Object.entries(matcher)) {
      if (!matchMockValue(valueMatcher, headers[String(name).toLowerCase()])) return false;
    }
    return true;
  }

  async function materializeMockRequestBody(body) {
    if (body == null || typeof body === "string") return { value: body, networkBody: body };
    if (body instanceof URLSearchParams) {
      const value = body.toString();
      return { value, networkBody: value };
    }
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      const networkBody = Buffer.from(body);
      return { value: networkBody.toString("utf8"), networkBody };
    }
    if (body instanceof ArrayBuffer) {
      const networkBody = Buffer.from(body);
      return { value: networkBody.toString("utf8"), networkBody };
    }
    const chunks = [];
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        chunks.push(Buffer.from(item.value));
      }
    } else if (typeof body[Symbol.asyncIterator] === "function" || typeof body[Symbol.iterator] === "function") {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
    } else {
      return { value: body, networkBody: body };
    }
    const networkBody = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
    return { value: networkBody.toString("utf8"), networkBody };
  }

  function mockResponseData(data) {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (typeof data === "object" && data !== null) return JSON.stringify(data);
    return data == null ? "" : String(data);
  }

  function waitForMockDelay(delay, signal) {
    if (!(delay > 0)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener?.("abort", onAbort);
        signal?.off?.("abort", onAbort);
      };
      const finish = (error = undefined) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        if (error) reject(normalizeAbortError(error));
        else resolve();
      };
      const onAbort = () => finish(signal.reason ?? new RequestAbortedError("The operation was aborted."));
      const timer = setTimeout(finish, delay);
      timer.unref?.();
      if (signal?.aborted) onAbort();
      else if (typeof signal?.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
      else signal?.once?.("abort", onAbort);
    });
  }

  function responseFromMockReply(reply, method = "GET") {
    const status = Number(reply.statusCode);
    const bodyForbidden = method === "HEAD" || status === 101 || status === 204 || status === 205 || status === 304;
    return new Response(bodyForbidden ? null : mockResponseData(reply.data), {
      status,
      statusText: reply.statusText,
      headers: reply.headers,
    });
  }

  class BodyReadable extends Readable {
    constructor(response, bodyTimeout = 0, maxSize = -1, onComplete = undefined) {
      super();
      this._response = response;
      this._reader = null;
      this._reading = false;
      this._bodyUsed = false;
      this._consumeActive = false;
      this._bodyTimeout = Number(bodyTimeout) > 0 ? Number(bodyTimeout) : 0;
      this._maxSize = Number(maxSize) >= 0 ? Number(maxSize) : -1;
      this._receivedSize = 0;
      this._bodyTimer = null;
      this._onComplete = typeof onComplete === "function" ? onComplete : null;
      this._armBodyTimeout();
    }

    get bodyUsed() {
      return this._bodyUsed;
    }

    _ensureReader() {
      if (!this._reader && this._response.body) this._reader = this._response.body.getReader();
      return this._reader;
    }

    _armBodyTimeout() {
      if (!(this._bodyTimeout > 0) || this.destroyed) return;
      if (this._bodyTimer != null) clearTimeout(this._bodyTimer);
      this._bodyTimer = setTimeout(() => {
        this._bodyTimer = null;
        const error = new BodyTimeoutError("Body Timeout Error");
        Promise.resolve(this._reader?.cancel?.(error)).catch(() => {});
        this.destroy(error);
      }, this._bodyTimeout);
      this._bodyTimer.unref?.();
    }

    _clearBodyTimeout() {
      if (this._bodyTimer != null) clearTimeout(this._bodyTimer);
      this._bodyTimer = null;
    }

    _finishOperation() {
      const callback = this._onComplete;
      this._onComplete = null;
      callback?.();
    }

    _read() {
      if (this._reading) return;
      const reader = this._ensureReader();
      if (!reader) {
        this.push(null);
        this._finishOperation();
        return;
      }
      this._bodyUsed = true;
      this._reading = true;
      this._armBodyTimeout();
      reader.read().then(({ done, value }) => {
        this._reading = false;
        this._clearBodyTimeout();
        if (done) {
          this.push(null);
          this._finishOperation();
        }
        else {
          const chunk = Buffer.from(value);
          this._receivedSize += chunk.byteLength;
          if (this._maxSize >= 0 && this._receivedSize > this._maxSize) {
            const error = new ResponseExceededMaxSizeError(`Response body exceeded ${this._maxSize} bytes`);
            this.destroy(error);
            return;
          }
          this.push(chunk);
          this._armBodyTimeout();
        }
      }, error => {
        this._reading = false;
        this._clearBodyTimeout();
        this.destroy(normalizeAbortError(error));
      });
    }

    _destroy(error, callback) {
      this._clearBodyTimeout();
      const reader = this._reader;
      this._reader = null;
      if (reader) Promise.resolve(reader.cancel(error)).catch(() => {});
      this._finishOperation();
      callback(error);
    }

    async _consume(kind) {
      if (this._bodyUsed && !this._consumeActive) throw new TypeError("unusable");
      this._bodyUsed = true;
      this._consumeActive = true;
      try {
        const chunks = [];
        for await (const chunk of this) chunks.push(Buffer.from(chunk));
        const bytes = chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
        if (kind === "arrayBuffer") return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        if (kind === "blob") return new primitives.Blob([bytes], { type: this._response.headers.get("content-type") ?? "" });
        if (kind === "text") return bytes.toString("utf8").replace(/^\uFEFF/, "");
        if (kind === "json") return JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
        if (kind === "formData") {
          return new Response(bytes, { headers: this._response.headers }).formData();
        }
        return bytes;
      } finally {
        this._consumeActive = false;
      }
    }

    arrayBuffer() { return this._consume("arrayBuffer"); }
    blob() { return this._consume("blob"); }
    bytes() { return this._consume("bytes"); }
    formData() { return this._consume("formData"); }
    json() { return this._consume("json"); }
    text() { return this._consume("text"); }

    async dump(options = {}) {
      const limit = options?.limit == null ? 128 * 1024 : Number(options.limit);
      let received = 0;
      for await (const chunk of this) {
        received += chunk.byteLength;
        if (Number.isFinite(limit) && limit >= 0 && received > limit) {
          const error = new ResponseExceededMaxSizeError(`Response body exceeded ${limit} bytes`);
          this.destroy(error);
          throw error;
        }
      }
    }
  }

  async function request(url, options = {}) {
    if (url == null || (typeof url !== "string" && !(url instanceof URL) && typeof url !== "object")) {
      throw new TypeError("url must be a string, URL, or UrlObject");
    }
    if (!(url instanceof URL) && typeof url === "object") {
      const protocol = url.protocol ?? "http:";
      const hostname = url.hostname ?? url.host;
      if (!hostname) throw new InvalidArgumentError("Invalid URL object");
      const port = url.port == null ? "" : `:${url.port}`;
      url = new URL(`${protocol}//${hostname}${port}${url.path ?? url.pathname ?? "/"}`);
    } else {
      url = new URL(String(url));
    }
    url = appendQuery(URLSearchParams, url, options.query);

    const method = String(options.method ?? "GET").toUpperCase();
    if (options.body != null && (method === "GET" || method === "HEAD")) {
      throw new Error("Body not allowed for GET or HEAD requests");
    }
    if (options.maxRedirections !== undefined && !Number.isFinite(Number(options.maxRedirections))) {
      throw new Error("maxRedirections must be a number if defined");
    }

    const dispatcher = options.dispatcher ?? getGlobalDispatcher();
    const dispatcherFetch = dispatcher?._fetchOptions ?? kEmptyObject;
    const headersTimeout = Number(options.headersTimeout ?? dispatcher?.options?.headersTimeout ?? 0);
    const bodyTimeout = Number(options.bodyTimeout ?? dispatcher?.options?.bodyTimeout ?? 0);
    const maxResponseSize = Number(options.maxResponseSize ?? dispatcher?.options?.maxResponseSize ?? -1);
    const operation = dispatcher?._beginOperation?.(options.signal) ?? null;
    const timeoutController = operation == null && headersTimeout > 0 ? new primitives.AbortController() : null;
    const signal = operation?.signal ?? (timeoutController
      ? options.signal && typeof AbortSignal?.any === "function"
        ? AbortSignal.any([options.signal, timeoutController.signal])
        : timeoutController.signal
        : options.signal);
    const headersTimer = headersTimeout > 0 ? setTimeout(() => {
      const error = new HeadersTimeoutError("Headers Timeout Error");
      if (operation) operation.abort(error);
      else timeoutController?.abort(error);
    }, headersTimeout) : null;
    headersTimer?.unref?.();
    let response;
    let responseTrailers = kEmptyObject;
    let responseUrl = url.href;
    try {
      const fetchOptions = {
        ...dispatcherFetch,
        signal,
        method,
        headers: options.headers ?? kEmptyObject,
        body: options.body,
        redirect: options.maxRedirections === 0 ? "manual" : "follow",
      };
      if (options.reset === true) fetchOptions.keepalive = false;
      const mockReply = typeof dispatcher?._resolveMock === "function"
        ? await dispatcher._resolveMock(url, { ...options, ...fetchOptions, signal })
        : null;
      if (mockReply && mockReply.fallback === kMockNetworkFallback) {
        if (mockReply.body !== undefined) fetchOptions.body = mockReply.body;
        response = await fetch(url, fetchOptions);
        responseUrl = response.url || url.href;
      } else if (mockReply) {
        response = responseFromMockReply(mockReply, method);
        responseTrailers = mockReply.trailers ?? kEmptyObject;
      } else {
        response = await fetch(url, fetchOptions);
        responseUrl = response.url || url.href;
      }
    } catch (error) {
      operation?.finish();
      throw normalizeAbortError(error);
    } finally {
      if (headersTimer != null) clearTimeout(headersTimer);
    }

    if (options.throwOnError && response.status >= 400 && response.status < 600) {
      const error = new ResponseStatusCodeError(`Request failed with status code ${response.status}`);
      error.status = response.status;
      error.statusCode = response.status;
      error.headers = headersObject(response.headers);
      try { await response.body?.cancel?.(error); } catch {}
      operation?.finish();
      throw error;
    }

    const body = response.body
      ? new BodyReadable(response, bodyTimeout, maxResponseSize, () => operation?.finish())
      : null;
    if (body) operation?.attachBody(body);
    else operation?.finish();
    return {
      statusCode: response.status,
      headers: headersObject(response.headers),
      body,
      trailers: responseTrailers === kEmptyObject ? response.trailers ?? kEmptyObject : responseTrailers,
      opaque: options.opaque ?? kEmptyObject,
      context: options.context ?? kEmptyObject,
      url: responseUrl,
    };
  }

  class Dispatcher extends EventEmitter {
    constructor() {
      super();
      this.destroyed = false;
      this.closed = false;
      this._pending = new Set();
      this._idleWaiters = new Set();
    }

    _beginOperation(externalSignal = undefined) {
      if (this.destroyed) throw new ClientDestroyedError();
      if (this.closed) throw new ClientClosedError();
      const controller = new primitives.AbortController();
      let body = null;
      let finished = false;
      let removeExternalAbort = null;
      const token = {
        signal: controller.signal,
        attachBody(value) {
          body = value;
          if (controller.signal.aborted && !body.destroyed) body.destroy(normalizeAbortError(controller.signal.reason));
        },
        abort(reason = new RequestAbortedError("The operation was aborted.")) {
          if (!controller.signal.aborted) controller.abort(reason);
          if (body && !body.destroyed) body.destroy(normalizeAbortError(reason));
        },
        finish: () => {
          if (finished) return;
          finished = true;
          removeExternalAbort?.();
          this._pending.delete(token);
          if (this._pending.size === 0) {
            for (const resolve of this._idleWaiters) resolve();
            this._idleWaiters.clear();
          }
        },
      };
      this._pending.add(token);

      if (externalSignal) {
        const onAbort = () => token.abort(
          externalSignal.reason ?? new RequestAbortedError("The operation was aborted."),
        );
        if (typeof externalSignal.addEventListener === "function") {
          externalSignal.addEventListener("abort", onAbort, { once: true });
          removeExternalAbort = () => externalSignal.removeEventListener?.("abort", onAbort);
        } else if (typeof externalSignal.once === "function") {
          externalSignal.once("abort", onAbort);
          removeExternalAbort = () => externalSignal.off?.("abort", onAbort);
        }
        if (externalSignal.aborted) onAbort();
      }
      return token;
    }

    _whenIdle() {
      if (this._pending.size === 0) return Promise.resolve();
      return new Promise(resolve => this._idleWaiters.add(resolve));
    }

    dispatch(options, handler) {
      if (this.destroyed) throw new ClientDestroyedError();
      if (this.closed) throw new ClientClosedError();
      if (!handler || typeof handler !== "object") throw new InvalidArgumentError("handler must be an object");
      const controller = new primitives.AbortController();
      let release = null;
      let resumeRequested = false;
      let protocolPaused = false;
      const resume = () => {
        protocolPaused = false;
        if (release) {
          const resolve = release;
          release = null;
          resolve();
        } else {
          resumeRequested = true;
        }
      };
      const waitIfPaused = async value => {
        if (value !== false && !protocolPaused) return;
        if (resumeRequested) {
          resumeRequested = false;
          return;
        }
        await new Promise(resolve => { release = resolve; });
      };
      const protocolController = {
        rawHeaders: null,
        rawTrailers: null,
        pause() { protocolPaused = true; },
        resume,
        abort(reason = new RequestAbortedError("The operation was aborted.")) {
          controller.abort(reason);
        },
      };
      const reportError = error => {
        handler.onError?.(error);
        handler.onResponseError?.(protocolController, error);
      };
      try {
        handler.onConnect?.(reason => controller.abort(reason));
        handler.onRequestStart?.(protocolController, null);
      } catch (error) {
        queueMicrotask(() => reportError(error));
        return true;
      }
      const origin = options.origin ?? this.origin;
      const target = urlFromOrigin(URL, origin, options.path ?? options.pathname ?? "/");
      let removeSourceAbort = null;
      if (options.signal && typeof AbortSignal?.any !== "function") {
        const onAbort = () => controller.abort(
          options.signal.reason ?? new RequestAbortedError("The operation was aborted."),
        );
        if (options.signal.aborted) onAbort();
        else if (typeof options.signal.addEventListener === "function") {
          options.signal.addEventListener("abort", onAbort, { once: true });
          removeSourceAbort = () => options.signal.removeEventListener?.("abort", onAbort);
        } else if (typeof options.signal.once === "function") {
          options.signal.once("abort", onAbort);
          removeSourceAbort = () => options.signal.off?.("abort", onAbort);
        }
      }
      const signal = options.signal && typeof AbortSignal?.any === "function"
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      void (async () => {
        let result;
        try {
          result = await request(target, { ...options, dispatcher: this, signal });
          const rawHeaders = rawHeaderPairs(new Headers(result.headers));
          protocolController.rawHeaders = rawHeaders;
          const oldHeadersResult = handler.onHeaders?.(
            result.statusCode,
            rawHeaders,
            resume,
            "",
          );
          handler.onResponseStart?.(protocolController, result.statusCode, result.headers, "");
          await waitIfPaused(oldHeadersResult);
          if (result.body) {
            for await (const chunk of result.body) {
              const oldDataResult = handler.onData?.(chunk);
              handler.onResponseData?.(protocolController, chunk);
              await waitIfPaused(oldDataResult);
            }
          }
          const rawTrailers = rawHeaderPairs(new Headers(result.trailers));
          protocolController.rawTrailers = rawTrailers;
          handler.onComplete?.(rawTrailers);
          handler.onResponseEnd?.(protocolController, result.trailers);
        } catch (error) {
          result?.body?.destroy?.(error);
          reportError(error);
        } finally {
          removeSourceAbort?.();
        }
      })();
      return true;
    }

    request(options, callback = undefined) {
      const target = urlFromOrigin(URL, options?.origin ?? this.origin, options?.path ?? options?.pathname ?? "/");
      const promise = request(target, { ...options, dispatcher: this });
      return callbackifyPromise(promise, callback);
    }

    stream(options, factory, callback = undefined) {
      const target = urlFromOrigin(URL, options?.origin ?? this.origin, options?.path ?? options?.pathname ?? "/");
      return stream(target, { ...options, dispatcher: this }, factory, callback);
    }

    pipeline(options, handler) {
      const target = urlFromOrigin(URL, options?.origin ?? this.origin, options?.path ?? options?.pathname ?? "/");
      return pipeline(target, { ...options, dispatcher: this }, handler);
    }

    connect(options, callback = undefined) {
      const target = urlFromOrigin(URL, options?.origin ?? this.origin, options?.path ?? options?.pathname ?? "/");
      return connect(target, { ...options, dispatcher: this }, callback);
    }

    upgrade(options, callback = undefined) {
      const target = urlFromOrigin(URL, options?.origin ?? this.origin, options?.path ?? options?.pathname ?? "/");
      return upgrade(target, { ...options, dispatcher: this }, callback);
    }

    close(callback = undefined) {
      this.closed = true;
      return callbackifyPromise(this._whenIdle(), callback);
    }

    destroy(error = undefined, callback = undefined) {
      if (typeof error === "function") {
        callback = error;
        error = undefined;
      }
      this.destroyed = true;
      this.closed = true;
      const reason = error ?? new ClientDestroyedError();
      for (const operation of [...this._pending]) operation.abort(reason);
      return callbackifyPromise(this._whenIdle(), callback);
    }

    compose(...interceptors) {
      return interceptors.reduce((dispatch, interceptor) => interceptor(dispatch), this.dispatch.bind(this));
    }

    [Symbol.asyncDispose]() {
      return this.close();
    }
  }

  function dispatcherFetchOptions(options = {}) {
    const result = {};
    if (options.connect && typeof options.connect === "object") result.tls = { ...options.connect };
    if (options.proxy != null) result.proxy = options.proxy;
    if (options.decompression === false || options.decompress === false) result.decompression = false;
    return result;
  }

  class Agent extends Dispatcher {
    constructor(options = {}) {
      super();
      this.options = options;
      this._fetchOptions = dispatcherFetchOptions(options);
    }
  }

  class Client extends Dispatcher {
    constructor(origin, options = {}) {
      super();
      this.origin = new URL(String(origin)).origin;
      this.options = options;
      this._fetchOptions = dispatcherFetchOptions(options);
    }
  }

  class Pool extends Client {}

  class BalancedPool extends Dispatcher {
    constructor(upstreams = [], options = {}) {
      super();
      this.upstreams = Array.from(Array.isArray(upstreams) ? upstreams : [upstreams], value => new URL(String(value)).origin);
      this.options = options;
      this._next = 0;
    }
    addUpstream(upstream) {
      this.upstreams.push(new URL(String(upstream)).origin);
      return this;
    }
    removeUpstream(upstream) {
      const origin = new URL(String(upstream)).origin;
      this.upstreams = this.upstreams.filter(value => value !== origin);
      return this;
    }
    get origin() {
      if (this.upstreams.length === 0) throw new BalancedPoolMissingUpstreamError();
      const origin = this.upstreams[this._next++ % this.upstreams.length];
      return origin;
    }
  }

  class ProxyAgent extends Dispatcher {
    constructor(options) {
      super();
      const value = typeof options === "string" || options instanceof URL ? { uri: options } : { ...(options ?? {}) };
      const proxy = value.uri ?? value.proxy;
      if (proxy == null) throw new InvalidArgumentError("ProxyAgent requires a proxy URI");
      this._fetchOptions = {
        proxy: { url: String(proxy), headers: value.proxyHeaders ?? value.headers },
        tls: value.requestTls,
      };
    }
  }

  class EnvHttpProxyAgent extends Dispatcher {
    constructor(options = {}) {
      super();
      this.options = options;
      this._fetchOptions = dispatcherFetchOptions(options);
    }
  }

  class RetryAgent extends Dispatcher {
    constructor(dispatcher = undefined, options = {}) {
      super();
      this.dispatcher = dispatcher ?? getGlobalDispatcher();
      this.options = options;
      this._fetchOptions = this.dispatcher._fetchOptions ?? kEmptyObject;
    }
  }

  class RetryHandler {
    constructor(options, handlers) {
      this.options = options;
      this.handlers = handlers;
    }
  }
  class DecoratorHandler {
    constructor(handler) { this.handler = handler; }
  }
  class RedirectHandler extends DecoratorHandler {}
  const createRedirectInterceptor = options => dispatch => (opts, handler) =>
    dispatch({ ...opts, maxRedirections: opts.maxRedirections ?? options?.maxRedirections }, handler);

  function validateMockCount(value, name) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new InvalidArgumentError(`${name} must be a valid integer > 0`);
    }
  }

  function mergeMockHeaders(...sources) {
    const result = {};
    for (const source of sources) {
      if (source == null) continue;
      const values = mockHeadersObject(source);
      for (const [name, value] of Object.entries(values)) result[name] = value;
    }
    return result;
  }

  class MockScope {
    constructor(dispatch) {
      this._dispatch = dispatch;
    }

    delay(waitInMs) {
      validateMockCount(waitInMs, "waitInMs");
      this._dispatch.delay = waitInMs;
      return this;
    }

    persist() {
      this._dispatch.persist = true;
      return this;
    }

    times(repeatTimes) {
      validateMockCount(repeatTimes, "repeatTimes");
      this._dispatch.times = repeatTimes;
      this._dispatch.pending = this._dispatch.timesInvoked < repeatTimes;
      return this;
    }
  }

  class MockInterceptor {
    constructor(options, dispatches, defaults = {}) {
      if (!options || typeof options !== "object") throw new InvalidArgumentError("opts must be an object");
      if (options.path === undefined) throw new InvalidArgumentError("opts.path must be defined");
      let path = options.path;
      if (typeof path === "string") {
        path = appendMockQuery(path, options.query);
        if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) {
          const parsed = new URL(path);
          path = `${parsed.pathname}${parsed.search}`;
        }
        path = normalizeMockPath(path, options.ignoreTrailingSlash ?? defaults.ignoreTrailingSlash);
      }
      this._key = {
        path,
        method: typeof options.method === "string" ? options.method.toUpperCase() : options.method ?? "GET",
        body: options.body,
        headers: options.headers,
      };
      this._dispatches = dispatches;
      this._ignoreTrailingSlash = options.ignoreTrailingSlash ?? defaults.ignoreTrailingSlash ?? false;
      this._defaultHeaders = Object.create(null);
      this._defaultTrailers = Object.create(null);
      this._contentLength = false;
    }

    _add(data) {
      const dispatch = {
        ...this._key,
        ...data,
        ignoreTrailingSlash: this._ignoreTrailingSlash,
        defaultHeaders: this._defaultHeaders,
        defaultTrailers: this._defaultTrailers,
        contentLength: this._contentLength,
        timesInvoked: 0,
        times: 1,
        persist: false,
        consumed: false,
        pending: true,
        delay: 0,
      };
      this._dispatches.push(dispatch);
      return new MockScope(dispatch);
    }

    reply(statusCodeOrCallback, data = "", responseOptions = {}) {
      if (typeof statusCodeOrCallback === "function") {
        return this._add({ replyCallback: statusCodeOrCallback });
      }
      if (statusCodeOrCallback === undefined) throw new InvalidArgumentError("statusCode must be defined");
      if (!responseOptions || typeof responseOptions !== "object") {
        throw new InvalidArgumentError("responseOptions must be an object");
      }
      return this._add({ statusCode: statusCodeOrCallback, data, responseOptions });
    }

    replyWithError(error) {
      if (error === undefined) throw new InvalidArgumentError("error must be defined");
      return this._add({ error });
    }

    defaultReplyHeaders(headers) {
      if (headers === undefined) throw new InvalidArgumentError("headers must be defined");
      this._defaultHeaders = headers;
      return this;
    }

    defaultReplyTrailers(trailers) {
      if (trailers === undefined) throw new InvalidArgumentError("trailers must be defined");
      this._defaultTrailers = trailers;
      return this;
    }

    replyContentLength() {
      this._contentLength = true;
      return this;
    }
  }

  function initializeMockDispatcher(dispatcher, origin, options) {
    if (!options?.agent || typeof options.agent.dispatch !== "function") {
      throw new InvalidArgumentError("Argument opts.agent must implement Agent");
    }
    dispatcher._mockAgent = options.agent;
    dispatcher._mockOriginKey = options.originKey ?? normalizeMockOrigin(origin);
    dispatcher._mockDispatches = options.dispatches ?? [];
    dispatcher._ignoreTrailingSlash = options.ignoreTrailingSlash ?? false;
    dispatcher.connected = true;
  }

  function closeMockDispatcher(dispatcher, callback) {
    const promise = Dispatcher.prototype.close.call(dispatcher).then(() => {
      dispatcher.connected = false;
      dispatcher._mockAgent?._deleteClient(dispatcher._mockOriginKey, dispatcher);
    });
    return callbackifyPromise(promise, callback);
  }

  class MockClient extends Client {
    constructor(origin, options = {}) {
      const actualOrigin = typeof origin === "string" || origin instanceof URL ? origin : "http://localhost:9999";
      super(actualOrigin, options);
      initializeMockDispatcher(this, origin, options);
    }

    intercept(options) {
      return new MockInterceptor(options, this._mockDispatches, { ignoreTrailingSlash: this._ignoreTrailingSlash });
    }

    cleanMocks() {
      this._mockDispatches.length = 0;
    }

    _resolveMock(target, options) {
      return this._mockAgent._resolveMock(target, options, this);
    }

    close(callback = undefined) {
      return closeMockDispatcher(this, callback);
    }
  }

  class MockPool extends Pool {
    constructor(origin, options = {}) {
      const actualOrigin = typeof origin === "string" || origin instanceof URL ? origin : "http://localhost:9999";
      super(actualOrigin, options);
      initializeMockDispatcher(this, origin, options);
    }

    intercept(options) {
      return new MockInterceptor(options, this._mockDispatches, { ignoreTrailingSlash: this._ignoreTrailingSlash });
    }

    cleanMocks() {
      this._mockDispatches.length = 0;
    }

    _resolveMock(target, options) {
      return this._mockAgent._resolveMock(target, options, this);
    }

    close(callback = undefined) {
      return closeMockDispatcher(this, callback);
    }
  }

  class MockAgent extends Dispatcher {
    constructor(options = {}) {
      super();
      if (!options || typeof options !== "object") throw new InvalidArgumentError("options must be an object");
      if (options.agent != null && typeof options.agent.dispatch !== "function") {
        throw new InvalidArgumentError("Argument opts.agent must implement Agent");
      }
      for (const name of ["acceptNonStandardSearchParameters", "ignoreTrailingSlash"]) {
        if (options[name] !== undefined && typeof options[name] !== "boolean") {
          throw new InvalidArgumentError(`options.${name} must to be a boolean`);
        }
      }
      this.options = options;
      this._clients = new Map();
      this._netConnect = true;
      this._mockActive = true;
      this._fetchOptions = options.agent?._fetchOptions ?? dispatcherFetchOptions(options);
      this._ignoreTrailingSlash = options.ignoreTrailingSlash ?? false;
      this._acceptNonStandardSearchParameters = options.acceptNonStandardSearchParameters ?? false;
    }

    get isMockActive() {
      return this._mockActive;
    }

    get(origin) {
      const key = normalizeMockOrigin(origin);
      const existing = this._clients.get(key);
      if (existing) return existing;

      if (typeof key === "string") {
        for (const [matcher, dispatcher] of this._clients) {
          if (typeof matcher === "string" || !matchMockValue(matcher, key)) continue;
          const concrete = this._createClient(key, dispatcher._mockDispatches);
          this._clients.set(key, concrete);
          return concrete;
        }
      }

      const dispatcher = this._createClient(key);
      this._clients.set(key, dispatcher);
      return dispatcher;
    }

    _createClient(originKey, dispatches = undefined) {
      const options = {
        ...this.options,
        agent: this,
        originKey,
        dispatches,
        ignoreTrailingSlash: this._ignoreTrailingSlash,
      };
      return this.options.connections === 1
        ? new MockClient(originKey, options)
        : new MockPool(originKey, options);
    }

    _deleteClient(key, dispatcher) {
      if (this._clients.get(key) === dispatcher) this._clients.delete(key);
    }

    _networkAllowed(origin) {
      if (this._netConnect === true) return true;
      if (!Array.isArray(this._netConnect)) return false;
      const host = new URL(origin).host;
      return this._netConnect.some(matcher => matchMockValue(matcher, host));
    }

    _notMatched(message, origin, networkBody = undefined) {
      if (!this._mockActive || this._networkAllowed(origin)) {
        return { fallback: kMockNetworkFallback, body: networkBody };
      }
      const clients = new Set(this._clients.values());
      let total = 0;
      let remaining = 0;
      for (const client of clients) {
        total += client._mockDispatches.length;
        remaining += client._mockDispatches.filter(dispatch => !dispatch.consumed).length;
      }
      throw new MockNotMatchedError(
        `${message}: subsequent request to origin ${origin} was not allowed ` +
        `(net.connect ${this._netConnect === false ? "disabled" : "is not enabled for this origin"}), ` +
        `${remaining} interceptor(s) remaining out of ${total} defined`,
      );
    }

    async _resolveMock(target, options, explicitDispatcher = undefined) {
      const origin = normalizeMockOrigin(target.origin);
      if (!this._mockActive) return { fallback: kMockNetworkFallback };
      const dispatcher = explicitDispatcher ?? this.get(origin);
      const headers = mockHeadersObject(options.headers);
      let path = `${target.pathname || "/"}${target.search || ""}`;
      if (this._acceptNonStandardSearchParameters && target.search) {
        const normalized = new URLSearchParams(target.search);
        for (const [name, value] of [...normalized]) {
          if (!name.endsWith("[]") && !value.includes(",")) continue;
          normalized.delete(name);
          const cleanName = name.replace(/\[\]$/, "");
          for (const part of value.split(",")) normalized.append(cleanName, part);
        }
        path = `${target.pathname || "/"}?${normalized}`;
      }
      const normalizedPath = normalizeMockPath(path, dispatcher._ignoreTrailingSlash);
      const method = String(options.method ?? "GET").toUpperCase();
      const available = dispatcher._mockDispatches.filter(dispatch => !dispatch.consumed);
      let matches = available.filter(dispatch => {
        const expected = typeof dispatch.path === "string"
          ? normalizeMockPath(dispatch.path, dispatch.ignoreTrailingSlash)
          : dispatch.path;
        return matchMockValue(expected, normalizeMockPath(path, dispatch.ignoreTrailingSlash));
      });
      if (matches.length === 0) {
        return this._notMatched(`Mock dispatch not matched for path '${normalizedPath}'`, origin);
      }
      matches = matches.filter(dispatch => matchMockValue(dispatch.method, method));
      if (matches.length === 0) {
        return this._notMatched(`Mock dispatch not matched for method '${method}' on path '${normalizedPath}'`, origin);
      }
      matches = matches.filter(dispatch => matchMockHeaders(dispatch.headers, headers));
      if (matches.length === 0) {
        return this._notMatched(`Mock dispatch not matched for headers '${JSON.stringify(headers)}' on path '${normalizedPath}'`, origin);
      }

      let body = options.body;
      let networkBody;
      if (body != null && matches.some(dispatch => dispatch.body !== undefined || dispatch.replyCallback || typeof dispatch.data === "function")) {
        const materialized = await materializeMockRequestBody(body);
        body = materialized.value;
        networkBody = materialized.networkBody;
      }
      matches = matches.filter(dispatch => dispatch.body === undefined || matchMockValue(dispatch.body, body));
      if (matches.length === 0) {
        return this._notMatched(`Mock dispatch not matched for body '${body}' on path '${normalizedPath}'`, origin, networkBody);
      }

      const dispatch = matches[0];
      dispatch.timesInvoked++;
      dispatch.consumed = !dispatch.persist && dispatch.timesInvoked >= dispatch.times;
      dispatch.pending = dispatch.timesInvoked < dispatch.times;
      const requestOptions = { path, method, headers, ...(body === undefined ? {} : { body }) };

      if (dispatch.error !== undefined) throw dispatch.error;
      let reply = dispatch;
      if (dispatch.replyCallback) {
        reply = await dispatch.replyCallback(requestOptions);
        if (!reply || typeof reply !== "object") {
          throw new InvalidArgumentError("reply options callback must return an object");
        }
        reply = { data: "", responseOptions: {}, ...reply };
      }
      if (reply.statusCode === undefined) throw new InvalidArgumentError("statusCode must be defined");
      const responseOptions = reply.responseOptions ?? {};
      if (!responseOptions || typeof responseOptions !== "object") {
        throw new InvalidArgumentError("responseOptions must be an object");
      }
      let data = reply.data ?? "";
      if (typeof data === "function") data = await data(requestOptions);
      await waitForMockDelay(dispatch.delay, options.signal);
      const encoded = mockResponseData(data);
      const contentLength = dispatch.contentLength
        ? { "content-length": Buffer.byteLength(encoded) }
        : null;
      return {
        statusCode: reply.statusCode,
        statusText: responseOptions.statusText,
        data: encoded,
        headers: mergeMockHeaders(dispatch.defaultHeaders, contentLength, responseOptions.headers),
        trailers: mergeMockHeaders(dispatch.defaultTrailers, responseOptions.trailers),
      };
    }

    activate() {
      this._mockActive = true;
    }

    deactivate() {
      this._mockActive = false;
    }

    enableNetConnect(matcher = undefined) {
      if (matcher === undefined) {
        this._netConnect = true;
        return;
      }
      if (typeof matcher !== "string" && typeof matcher !== "function" && !(matcher instanceof RegExp)) {
        throw new InvalidArgumentError("Unsupported matcher. Must be one of String|Function|RegExp.");
      }
      if (!Array.isArray(this._netConnect)) this._netConnect = [];
      this._netConnect.push(matcher);
    }

    disableNetConnect() {
      this._netConnect = false;
    }

    pendingInterceptors() {
      const seen = new Set();
      const pending = [];
      for (const [origin, dispatcher] of this._clients) {
        for (const dispatch of dispatcher._mockDispatches) {
          if (!dispatch.pending || seen.has(dispatch)) continue;
          seen.add(dispatch);
          pending.push({ ...dispatch, origin });
        }
      }
      return pending;
    }

    assertNoPendingInterceptors() {
      const pending = this.pendingInterceptors();
      if (pending.length === 0) return;
      const lines = pending.map(item => `${String(item.method)} ${String(item.origin)}${String(item.path)}`);
      throw new UndiciError(
        `${pending.length} interceptor${pending.length === 1 ? " is" : "s are"} pending:\n\n${lines.join("\n")}`,
      );
    }

    close(callback = undefined) {
      const promise = (async () => {
        const clients = [...new Set(this._clients.values())];
        await Promise.all(clients.map(client => Dispatcher.prototype.close.call(client)));
        for (const client of clients) client.connected = false;
        this._clients.clear();
        await Dispatcher.prototype.close.call(this);
      })();
      return callbackifyPromise(promise, callback);
    }

    destroy(error = undefined, callback = undefined) {
      if (typeof error === "function") {
        callback = error;
        error = undefined;
      }
      const promise = (async () => {
        const clients = [...new Set(this._clients.values())];
        await Promise.all(clients.map(client => Dispatcher.prototype.destroy.call(client, error)));
        this._clients.clear();
        await Dispatcher.prototype.destroy.call(this, error);
      })();
      return callbackifyPromise(promise, callback);
    }
  }
  const mockErrors = Object.freeze({ MockNotMatchedError });

  class FileReader extends EventTarget {
    static EMPTY = 0;
    static LOADING = 1;
    static DONE = 2;
    constructor() {
      super();
      this.readyState = FileReader.EMPTY;
      this.result = null;
      this.error = null;
    }
  }

  class EventSourceParser {
    constructor(state, emit) {
      this._state = state;
      this._emit = emit;
      this._decoder = new TextDecoder("utf-8");
      this._buffer = "";
      this._started = false;
      this._data = [];
      this._eventType = "";
      this._pendingId = undefined;
      this._pendingRetry = undefined;
    }

    push(chunk) {
      let text = this._decoder.decode(chunk, { stream: true });
      if (!this._started) {
        this._started = true;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      this._buffer += text;
      this._process(false);
    }

    finish() {
      this._buffer += this._decoder.decode();
      this._process(true);
    }

    _process(final) {
      for (;;) {
        let lineEnd = -1;
        for (let index = 0; index < this._buffer.length; index++) {
          const code = this._buffer.charCodeAt(index);
          if (code === 0x0a || code === 0x0d) {
            lineEnd = index;
            break;
          }
        }
        if (lineEnd < 0) break;
        const code = this._buffer.charCodeAt(lineEnd);
        if (!final && code === 0x0d && lineEnd + 1 === this._buffer.length) break;
        const width = code === 0x0d && this._buffer.charCodeAt(lineEnd + 1) === 0x0a ? 2 : 1;
        const line = this._buffer.slice(0, lineEnd);
        this._buffer = this._buffer.slice(lineEnd + width);
        this._line(line);
      }
      if (final && this._buffer.length > 0) {
        this._line(this._buffer);
        this._buffer = "";
      }
    }

    _line(line) {
      if (line === "") {
        this._dispatch();
        return;
      }
      if (line.startsWith(":")) return;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") this._data.push(value);
      else if (field === "event") this._eventType = value;
      else if (field === "id" && !value.includes("\0")) this._pendingId = value;
      else if (field === "retry" && /^[0-9]+$/.test(value)) this._pendingRetry = Number(value);
    }

    _dispatch() {
      if (this._pendingRetry !== undefined) this._state.reconnectionTime = this._pendingRetry;
      if (this._pendingId !== undefined) this._state.lastEventId = this._pendingId;
      if (this._data.length > 0) {
        this._emit(this._eventType || "message", {
          data: this._data.join("\n"),
          lastEventId: this._state.lastEventId,
          origin: this._state.origin,
        });
      }
      this._data.length = 0;
      this._eventType = "";
      this._pendingId = undefined;
      this._pendingRetry = undefined;
    }
  }

  function createEventSourceEvent(type, options = undefined) {
    return new MessageEvent(type, options ?? {});
  }

  class EventSource extends EventTarget {
    constructor(url, init = {}) {
      super();
      if (arguments.length === 0) throw new TypeError("EventSource constructor requires at least 1 argument");
      if (init == null || typeof init !== "object") throw new TypeError("eventSourceInitDict must be an object");
      let parsed;
      try {
        parsed = new URL(String(url), getGlobalOrigin());
      } catch (error) {
        if (typeof DOMException === "function") throw new DOMException(String(error?.message ?? error), "SyntaxError");
        const syntaxError = new TypeError(String(error?.message ?? error));
        syntaxError.name = "SyntaxError";
        throw syntaxError;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        if (typeof DOMException === "function") throw new DOMException("EventSource URL must use HTTP or HTTPS", "SyntaxError");
        throw new TypeError("EventSource URL must use HTTP or HTTPS");
      }
      const nodeOptions = init.node && typeof init.node === "object" ? init.node : kEmptyObject;
      const reconnectionTime = nodeOptions.reconnectionTime === undefined ? 3000 : Number(nodeOptions.reconnectionTime) >>> 0;
      this._url = parsed.href;
      this._withCredentials = init.withCredentials === true;
      this._dispatcher = nodeOptions.dispatcher ?? init.dispatcher;
      this._readyState = EventSource.CONNECTING;
      this._handlers = { open: null, message: null, error: null };
      this._state = { lastEventId: "", origin: parsed.origin, reconnectionTime };
      this._controller = null;
      this._body = null;
      this._reconnectTimer = null;
      this._generation = 0;
      void this._connect();
    }

    get readyState() { return this._readyState; }
    get url() { return this._url; }
    get withCredentials() { return this._withCredentials; }

    get onopen() { return this._handlers.open; }
    set onopen(value) { this._setHandler("open", value); }
    get onmessage() { return this._handlers.message; }
    set onmessage(value) { this._setHandler("message", value); }
    get onerror() { return this._handlers.error; }
    set onerror(value) { this._setHandler("error", value); }

    _setHandler(type, value) {
      this._handlers[type] = typeof value === "function" ? value : null;
    }

    async _connect() {
      if (this._readyState === EventSource.CLOSED) return;
      if (this._reconnectTimer != null) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._readyState = EventSource.CONNECTING;
      const generation = ++this._generation;
      const controller = new primitives.AbortController();
      this._controller = controller;
      const headers = { Accept: "text/event-stream" };
      if (this._state.lastEventId !== "") headers["Last-Event-ID"] = this._state.lastEventId;
      let result;
      try {
        result = await request(this._url, {
          dispatcher: this._dispatcher,
          headers,
          signal: controller.signal,
          maxRedirections: 20,
        });
        if (generation !== this._generation || this._readyState === EventSource.CLOSED) {
          result.body?.destroy?.();
          return;
        }
        const contentType = String(result.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        if (result.statusCode !== 200 || contentType !== "text/event-stream") {
          result.body?.destroy?.();
          this._fail();
          return;
        }
        this._state.origin = new URL(result.url || this._url).origin;
        this._readyState = EventSource.OPEN;
        this.dispatchEvent(createEventSourceEvent("open"));
        if (this._readyState === EventSource.CLOSED) return;
        const parser = new EventSourceParser(this._state, (type, options) => {
          if (this._readyState !== EventSource.CLOSED) {
            this.dispatchEvent(createEventSourceEvent(type, options));
          }
        });
        this._body = result.body;
        if (result.body) {
          for await (const chunk of result.body) {
            if (generation !== this._generation || this._readyState === EventSource.CLOSED) break;
            parser.push(chunk);
          }
          parser.finish();
        }
        if (generation === this._generation && this._readyState !== EventSource.CLOSED) this._reconnect();
      } catch (error) {
        if (generation === this._generation && this._readyState !== EventSource.CLOSED && !controller.signal.aborted) {
          this._reconnect();
        }
      } finally {
        if (generation === this._generation) {
          this._controller = null;
          this._body = null;
        }
      }
    }

    _fail() {
      if (this._readyState === EventSource.CLOSED) return;
      this._readyState = EventSource.CLOSED;
      this._generation++;
      this._controller?.abort();
      this._controller = null;
      this.dispatchEvent(createEventSourceEvent("error"));
    }

    _reconnect() {
      if (this._readyState === EventSource.CLOSED) return;
      this._readyState = EventSource.CONNECTING;
      this.dispatchEvent(createEventSourceEvent("error"));
      if (this._readyState === EventSource.CLOSED) return;
      const generation = this._generation;
      this._reconnectTimer = setTimeout(() => {
        this._reconnectTimer = null;
        if (generation !== this._generation || this._readyState !== EventSource.CONNECTING) return;
        void this._connect();
      }, this._state.reconnectionTime);
      this._reconnectTimer.unref?.();
    }

    close() {
      if (!(this instanceof EventSource)) throw new TypeError("Illegal invocation");
      if (this._readyState === EventSource.CLOSED) return;
      this._readyState = EventSource.CLOSED;
      this._generation++;
      if (this._reconnectTimer != null) clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._controller?.abort();
      this._controller = null;
      this._body?.destroy?.(new RequestAbortedError("The operation was aborted."));
      this._body = null;
    }
  }

  const eventSourceConstants = {
    CONNECTING: { value: 0, enumerable: true },
    OPEN: { value: 1, enumerable: true },
    CLOSED: { value: 2, enumerable: true },
  };
  Object.defineProperties(EventSource, eventSourceConstants);
  Object.defineProperties(EventSource.prototype, eventSourceConstants);
  Object.defineProperty(EventSource.prototype, Symbol.toStringTag, { value: "EventSource", configurable: true });

  function parseCookieHeader(value) {
    const result = Object.create(null);
    for (const part of String(value ?? "").split(";")) {
      const equals = part.indexOf("=");
      if (equals <= 0) continue;
      const name = part.slice(0, equals).trim();
      if (name) result[name] = part.slice(equals + 1).trim();
    }
    return result;
  }

  function cookieHeaders(headers) {
    if (!(headers instanceof Headers)) throw new InvalidArgumentError("headers must be a Headers instance");
    return headers;
  }

  function getCookies(headers) {
    return parseCookieHeader(cookieHeaders(headers).get("cookie"));
  }

  function parseSetCookie(value) {
    const parts = String(value).split(";");
    const first = parts.shift() ?? "";
    const equals = first.indexOf("=");
    const cookie = { name: first.slice(0, equals).trim(), value: first.slice(equals + 1).trim() };
    for (const part of parts) {
      const separator = part.indexOf("=");
      const rawName = (separator < 0 ? part : part.slice(0, separator)).trim();
      const rawValue = separator < 0 ? true : part.slice(separator + 1).trim();
      const lowerName = rawName.toLowerCase();
      const key = lowerName === "httponly" ? "httpOnly"
        : lowerName === "samesite" ? "sameSite"
          : lowerName === "max-age" ? "maxAge"
            : lowerName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (key === "expires") cookie.expires = new Date(String(rawValue));
      else if (key === "maxAge") cookie.maxAge = Number(rawValue);
      else cookie[key] = rawValue;
    }
    return cookie;
  }

  function getSetCookies(headers) {
    const source = cookieHeaders(headers);
    const values = source.getSetCookie?.() ?? source.getAll?.("set-cookie") ?? [];
    return values.map(parseSetCookie);
  }

  function serializeCookie(cookie) {
    if (!cookie || cookie.name == null) throw new InvalidArgumentError("cookie.name is required");
    let value = `${cookie.name}=${cookie.value ?? ""}`;
    const attributes = [
      ["path", "Path"], ["domain", "Domain"], ["maxAge", "Max-Age"],
      ["httpOnly", "HttpOnly"], ["secure", "Secure"], ["sameSite", "SameSite"],
    ];
    if (cookie.expires != null) value += `; Expires=${new Date(cookie.expires).toUTCString()}`;
    for (const [key, name] of attributes) {
      if (cookie[key] == null || cookie[key] === false) continue;
      value += cookie[key] === true ? `; ${name}` : `; ${name}=${cookie[key]}`;
    }
    return value;
  }

  function setCookie(headers, cookie) {
    cookieHeaders(headers).append("set-cookie", serializeCookie(cookie));
  }

  function deleteCookie(headers, name, attributes = {}) {
    setCookie(headers, { ...attributes, name: String(name), value: "", expires: new Date(0) });
  }

  function parseMIMEType(input) {
    const parts = String(input).split(";");
    const essence = (parts.shift() ?? "").trim().toLowerCase();
    const slash = essence.indexOf("/");
    if (slash <= 0 || slash === essence.length - 1) return "failure";
    const parameters = new Map();
    for (const part of parts) {
      const equals = part.indexOf("=");
      if (equals <= 0) continue;
      const name = part.slice(0, equals).trim().toLowerCase();
      let value = part.slice(equals + 1).trim();
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\([\\"])/g, "$1");
      if (!parameters.has(name)) parameters.set(name, value);
    }
    return { type: essence.slice(0, slash), subtype: essence.slice(slash + 1), parameters, essence };
  }

  function serializeAMimeType(mime) {
    if (!mime || typeof mime !== "object") throw new InvalidArgumentError("mimeType must be an object");
    let value = `${mime.type}/${mime.subtype}`;
    for (const [name, raw] of mime.parameters ?? []) {
      const parameter = String(raw);
      value += /^[\u0021\u0023-\u0027\u002a-\u002b\u002d-\u002e\u0030-\u0039\u0041-\u005a\u005e-\u007e]*$/.test(parameter)
        ? `;${name}=${parameter}`
        : `;${name}="${parameter.replace(/[\\"]/g, "\\$&")}"`;
    }
    return value;
  }

  let globalOrigin;
  let globalDispatcher;
  function setGlobalDispatcher(dispatcher) {
    if (!dispatcher || typeof dispatcher.dispatch !== "function") throw new InvalidArgumentError("Argument dispatcher must implement Dispatcher");
    globalDispatcher = dispatcher;
  }
  function getGlobalDispatcher() { return globalDispatcher ??= new Agent(); }
  function setGlobalOrigin(origin) {
    if (origin == null) { globalOrigin = undefined; return; }
    const parsed = new URL(String(origin));
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new InvalidArgumentError("Invalid origin");
    globalOrigin = parsed.origin;
  }
  function getGlobalOrigin() { return globalOrigin; }

  async function undiciFetch(input, init = {}) {
    const dispatcher = init?.dispatcher ?? globalDispatcher;
    const options = { ...(dispatcher?._fetchOptions ?? kEmptyObject), ...init };
    delete options.dispatcher;
    if (typeof dispatcher?._resolveMock !== "function") {
      return fetch(input, options);
    }
    const target = input instanceof Request
      ? new URL(input.url)
      : new URL(String(input), globalOrigin);
    const method = String(options.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const signal = options.signal ?? (input instanceof Request ? input.signal : undefined);
    const operation = dispatcher._beginOperation?.(signal) ?? null;
    try {
      const reply = await dispatcher._resolveMock(target, {
        ...options,
        method,
        headers: options.headers ?? (input instanceof Request ? input.headers : undefined),
        body: options.body ?? (input instanceof Request ? input.body : undefined),
        signal: operation?.signal ?? signal,
      });
      if (reply?.fallback === kMockNetworkFallback) {
        if (reply.body !== undefined) options.body = reply.body;
        return await fetch(reply.body === undefined ? input : target, options);
      }
      return responseFromMockReply(reply, method);
    } finally {
      operation?.finish();
    }
  }

  function buildConnector(defaults = {}) {
    return function connector(options, callback) {
      const secure = options.protocol === "https:" || options.protocol === "wss:";
      const connectOptions = {
        ...defaults,
        ...options,
        host: options.hostname ?? options.host,
        servername: options.servername ?? options.hostname ?? options.host,
        port: Number(options.port ?? (secure ? 443 : 80)),
      };
      let timer;
      let socket;
      const done = (error, value = socket) => {
        if (timer) clearTimeout(timer);
        callback?.(error ?? null, value);
      };
      try {
        socket = secure ? tls.connect(connectOptions) : net.connect(connectOptions);
        socket.once("connect", () => done(null, socket));
        socket.once("error", error => done(error));
        if (Number(defaults.connectTimeout) > 0) {
          timer = setTimeout(() => {
            const error = new ConnectTimeoutError("Connect Timeout Error");
            socket.destroy(error);
            done(error);
          }, Number(defaults.connectTimeout));
          timer.unref?.();
        }
      } catch (error) {
        done(error);
      }
      return socket;
    };
  }

  function stream(url, options, factory, callback = undefined) {
    if (typeof options === "function") {
      callback = factory;
      factory = options;
      options = {};
    }
    if (typeof factory !== "function") throw new InvalidArgumentError("factory must be a function");
    const promise = request(url, options ?? {}).then(async result => {
      let writable;
      try {
        writable = factory({
          statusCode: result.statusCode,
          headers: result.headers,
          opaque: result.opaque,
          context: result.context,
        });
      } catch (error) {
        result.body?.destroy?.(error);
        throw error;
      }
      if (!writable || typeof writable.write !== "function" || typeof writable.end !== "function") {
        result.body?.destroy?.();
        throw new InvalidReturnValueError("factory must return a Writable stream");
      }
      try {
        if (result.body) {
          for await (const chunk of result.body) {
            if (!writable.write(chunk)) await waitForWritableDrain(writable);
          }
        }
        const finished = waitForWritableFinish(writable);
        writable.end();
        await finished;
        return { opaque: result.opaque, trailers: result.trailers };
      } catch (error) {
        result.body?.destroy?.(error);
        writable.destroy?.(error);
        throw error;
      }
    });
    return callbackifyPromise(promise, callback);
  }

  class PipelineDuplex extends Duplex {
    constructor(url, options, handler) {
      super();
      this._pipelineUrl = url;
      this._pipelineOptions = { ...(options ?? {}) };
      this._pipelineHandler = handler;
      this._requestBody = new PassThrough();
      this._responseBody = null;
      this._handlerBody = null;
      this._readRelease = null;
      this._allowsRequestBody = !["GET", "HEAD"].includes(String(this._pipelineOptions.method ?? "GET").toUpperCase());
      void this._startPipeline();
    }

    async _startPipeline() {
      try {
        const result = await request(this._pipelineUrl, {
          ...this._pipelineOptions,
          body: this._allowsRequestBody ? this._requestBody : undefined,
        });
        this._responseBody = result.body;
        const selected = this._pipelineHandler({
          statusCode: result.statusCode,
          headers: result.headers,
          opaque: result.opaque,
          context: result.context,
          body: result.body,
        });
        if (!selected || typeof selected[Symbol.asyncIterator] !== "function") {
          throw new InvalidReturnValueError("handler must return a Readable stream or async iterable");
        }
        this._handlerBody = selected;
        for await (const chunk of selected) {
          if (!this.push(Buffer.from(chunk))) {
            await new Promise(resolve => { this._readRelease = resolve; });
          }
        }
        this.push(null);
      } catch (error) {
        this.destroy(error);
      }
    }

    _read() {
      this._handlerBody?.resume?.();
      const release = this._readRelease;
      this._readRelease = null;
      release?.();
    }

    _write(chunk, encoding, callback) {
      if (!this._allowsRequestBody) {
        callback(new InvalidArgumentError("Request body is not allowed for GET or HEAD pipeline requests"));
        return;
      }
      if (this._requestBody.write(chunk, encoding)) callback();
      else this._requestBody.once("drain", callback);
    }

    _final(callback) {
      if (this._allowsRequestBody) this._requestBody.end();
      else this._requestBody.destroy();
      callback();
    }

    _destroy(error, callback) {
      const release = this._readRelease;
      this._readRelease = null;
      release?.();
      this._requestBody.destroy?.(error);
      this._responseBody?.destroy?.(error);
      if (this._handlerBody !== this._responseBody) this._handlerBody?.destroy?.(error);
      callback(error);
    }
  }

  function pipeline(url, options, handler) {
    if (typeof options === "function") {
      handler = options;
      options = {};
    }
    if (typeof handler !== "function") throw new InvalidArgumentError("handler must be a function");
    return new PipelineDuplex(url, options, handler);
  }

  function rawSocketRequest(kind, url, options = {}) {
    const target = new URL(String(url));
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return Promise.reject(new InvalidArgumentError("URL must use http: or https:"));
    }
    const client = target.protocol === "https:" ? https : http;
    const dispatcherTls = options.dispatcher?._fetchOptions?.tls ?? kEmptyObject;
    const tlsOptions = { ...dispatcherTls, ...(options.connect ?? {}) };
    const headers = new Headers(options.headers ?? kEmptyObject);
    let method;
    let path;
    let eventName;
    if (kind === "connect") {
      method = "CONNECT";
      path = String(options.path ?? target.host);
      eventName = "connect";
      if (!headers.has("host")) headers.set("Host", path);
    } else {
      method = String(options.method ?? "GET").toUpperCase();
      path = String(options.path ?? `${target.pathname || "/"}${target.search || ""}`);
      eventName = "upgrade";
      if (!headers.has("connection")) headers.set("Connection", "Upgrade");
      if (!headers.has("upgrade")) headers.set("Upgrade", String(options.upgrade ?? "WebSocket"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let requestHandle;
      const signal = options.signal;
      const cleanup = () => {
        if (timer != null) clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        signal?.off?.("abort", onAbort);
      };
      const finish = (error, value = undefined) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = reason => {
        const error = normalizeAbortError(signal?.reason ?? reason ?? new RequestAbortedError("The operation was aborted."));
        requestHandle?.destroy?.(error);
        finish(error);
      };
      try {
        requestHandle = client.request({
          protocol: target.protocol,
          hostname: String(target.hostname).replace(/^\[|\]$/g, ""),
          port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
          method,
          path,
          headers: headersObject(headers),
          ...tlsOptions,
        });
        requestHandle.once(eventName, (response, socket, head) => {
          socket.pause?.();
          finish(null, {
            statusCode: response.statusCode,
            headers: response.headers ?? kEmptyObject,
            socket,
            opaque: options.opaque ?? kEmptyObject,
          });
          queueMicrotask(() => {
            if (socket.destroyed) return;
            if (head?.byteLength) socket.unshift?.(head);
            socket.resume?.();
          });
        });
        requestHandle.once("response", response => {
          response.resume?.();
          const error = new ResponseStatusCodeError(
            `${kind === "connect" ? "CONNECT" : "Upgrade"} request failed with status code ${response.statusCode}`,
          );
          error.statusCode = response.statusCode;
          error.headers = response.headers;
          finish(error);
        });
        requestHandle.once("error", finish);
        if (signal?.aborted) {
          onAbort();
          return;
        }
        if (typeof signal?.addEventListener === "function") signal.addEventListener("abort", onAbort, { once: true });
        else signal?.once?.("abort", onAbort);
        const timeout = Number(options.headersTimeout ?? options.connectTimeout ?? 0);
        if (timeout > 0) {
          timer = setTimeout(() => {
            const error = new ConnectTimeoutError("Connect Timeout Error");
            requestHandle.destroy?.(error);
            finish(error);
          }, timeout);
          timer.unref?.();
        }
        requestHandle.end();
      } catch (error) {
        finish(error);
      }
    });
  }

  function connect(url, options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    return callbackifyPromise(rawSocketRequest("connect", url, options), callback);
  }

  function upgrade(url, options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    return callbackifyPromise(rawSocketRequest("upgrade", url, options), callback);
  }
  const caches = Object.freeze({});
  const interceptors = {
    redirect: createRedirectInterceptor,
    retry: () => dispatch => dispatch,
    dump: () => dispatch => dispatch,
  };
  const util = {
    parseHeaders(input) {
      const headers = new Headers();
      if (Array.isArray(input)) {
        for (let index = 0; index + 1 < input.length; index += 2) headers.append(String(input[index]), String(input[index + 1]));
      }
      return headersObject(headers);
    },
    headerNameToString(value) { return Buffer.isBuffer(value) ? value.toString("latin1") : String(value); },
  };

  const moduleExports = {
    Agent,
    BalancedPool,
    buildConnector,
    caches,
    Client,
    CloseEvent,
    connect,
    createRedirectInterceptor,
    DecoratorHandler,
    deleteCookie,
    Dispatcher,
    EnvHttpProxyAgent,
    ErrorEvent,
    errors,
    EventSource,
    fetch: undiciFetch,
    File,
    FileReader,
    FormData,
    getCookies,
    getGlobalDispatcher,
    getGlobalOrigin,
    getSetCookies,
    Headers,
    interceptors,
    MessageEvent,
    MockAgent,
    MockClient,
    mockErrors,
    MockPool,
    parseMIMEType,
    pipeline,
    Pool,
    ProxyAgent,
    RedirectHandler,
    Request,
    request,
    Response,
    RetryAgent,
    RetryHandler,
    serializeAMimeType,
    setCookie,
    setGlobalDispatcher,
    setGlobalOrigin,
    stream,
    upgrade,
    util,
    WebSocket,
  };
  moduleExports.default = moduleExports;
  return moduleExports;
}

export default { createUndiciModule };
