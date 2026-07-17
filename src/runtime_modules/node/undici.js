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

// COTTONTAIL-COMPAT: Undici's mock interception and EventSource still need
// dedicated protocol implementations.
function unsupported(name) {
  throw new NotSupportedError(`${name} is not implemented by Cottontail's Undici compatibility layer`);
}

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
      response = await fetch(url, fetchOptions);
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
      trailers: response.trailers ?? kEmptyObject,
      opaque: options.opaque ?? kEmptyObject,
      context: options.context ?? kEmptyObject,
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
      const resume = () => {
        if (release) {
          const resolve = release;
          release = null;
          resolve();
        } else {
          resumeRequested = true;
        }
      };
      const waitIfPaused = async value => {
        if (value !== false) return;
        if (resumeRequested) {
          resumeRequested = false;
          return;
        }
        await new Promise(resolve => { release = resolve; });
      };
      try {
        handler.onConnect?.(reason => controller.abort(reason));
      } catch (error) {
        queueMicrotask(() => handler.onError?.(error));
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
          await waitIfPaused(handler.onHeaders?.(
            result.statusCode,
            rawHeaderPairs(new Headers(result.headers)),
            resume,
            "",
          ));
          if (result.body) {
            for await (const chunk of result.body) {
              await waitIfPaused(handler.onData?.(chunk));
            }
          }
          handler.onComplete?.(rawHeaderPairs(new Headers(result.trailers)));
        } catch (error) {
          result?.body?.destroy?.(error);
          handler.onError?.(error);
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

  class MockClient extends Client { constructor() { super("http://localhost"); unsupported("MockClient"); } }
  class MockPool extends Pool { constructor() { super("http://localhost"); unsupported("MockPool"); } }
  class MockAgent extends Agent { constructor() { super(); unsupported("MockAgent"); } }
  const mockErrors = Object.freeze({ MockNotMatchedError: namedError("MockNotMatchedError", "UND_MOCK_ERR_MOCK_NOT_MATCHED", UndiciError) });

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

  class EventSource extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor() {
      super();
      unsupported("EventSource");
    }
  }

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

  function undiciFetch(input, init = {}) {
    const dispatcher = init?.dispatcher ?? globalDispatcher;
    if (!dispatcher?._fetchOptions || Object.keys(dispatcher._fetchOptions).length === 0) return fetch(input, init);
    const options = { ...dispatcher._fetchOptions, ...init };
    delete options.dispatcher;
    return fetch(input, options);
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
