import { EventEmitter } from "./events.js";
import {
  Agent as HttpAgent,
  IncomingMessage,
  OutgoingMessage,
  ServerResponse,
  STATUS_CODES,
  _writeServerResponse,
} from "./http.js";
import { Server as TlsServer, connect as tlsConnect } from "./tls.js";

function normalizeRequestOptions(input, options = undefined) {
  let url;
  let merged = {};
  if (input instanceof URL || typeof input === "string") {
    url = new URL(String(input));
    merged = { ...(options ?? {}) };
  } else {
    merged = { ...(input ?? {}) };
    if (options && typeof options === "object") merged = { ...merged, ...options };
    const hostname = merged.hostname ?? merged.host ?? "localhost";
    const port = merged.port != null ? `:${merged.port}` : "";
    const path = merged.path ?? `${merged.pathname ?? "/"}${merged.search ?? ""}`;
    url = new URL(`https://${hostname}${port}${path}`);
  }
  if (merged.hostname) url.hostname = merged.hostname;
  if (merged.host && !merged.hostname && merged.port == null) url.host = merged.host;
  if (merged.port != null) url.port = String(merged.port);
  if (merged.path) {
    const pathUrl = new URL(url);
    const [pathname, search = ""] = String(merged.path).split("?", 2);
    pathUrl.pathname = pathname || "/";
    pathUrl.search = search ? `?${search}` : "";
    url = pathUrl;
  }
  merged._port = merged.port ?? String(url.href).match(/^https:\/\/[^/:]+:(\d+)/)?.[1] ?? 443;
  return { url, options: merged };
}

function requestPath(url, options = undefined) {
  if (String(options?.method ?? "").toUpperCase() === "CONNECT" && options?.path != null) return String(options.path);
  return `${url.pathname || "/"}${url.search || ""}`;
}

function parseHeaderLines(text) {
  const lines = String(text).split("\r\n");
  const headers = {};
  const rawHeaders = [];
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon);
    const value = line.slice(colon + 1).trimStart();
    rawHeaders.push(name, value);
    const key = name.toLowerCase();
    headers[key] = headers[key] == null ? value : `${headers[key]}, ${value}`;
  }
  return { headers, rawHeaders };
}

function decodeChunkedBody(buffer) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const text = buffer.subarray(offset).toString("latin1");
    const lineEnd = text.indexOf("\r\n");
    if (lineEnd < 0) return null;
    const sizeText = text.slice(0, lineEnd).split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error("Invalid HTTP chunk size");
    const chunkStart = offset + lineEnd + 2;
    const chunkEnd = chunkStart + size;
    if (buffer.byteLength < chunkEnd + 2) return null;
    if (size === 0) {
      const trailerBytes = buffer.subarray(chunkStart);
      if (trailerBytes.byteLength < 2) return null;
      if (trailerBytes[0] === 13 && trailerBytes[1] === 10) {
        return { body: Buffer.concat(chunks), consumed: chunkStart + 2, trailers: {}, rawTrailers: [] };
      }
      const trailerText = trailerBytes.toString("latin1");
      const trailerEnd = trailerText.indexOf("\r\n\r\n");
      if (trailerEnd < 0) return null;
      const parsedTrailers = parseHeaderLines(trailerText.slice(0, trailerEnd));
      return {
        body: Buffer.concat(chunks),
        consumed: chunkStart + trailerEnd + 4,
        trailers: parsedTrailers.headers,
        rawTrailers: parsedTrailers.rawHeaders,
      };
    }
    chunks.push(buffer.subarray(chunkStart, chunkEnd));
    offset = chunkEnd + 2;
  }
}

function tryParseHttpRequest(buffer) {
  const text = buffer.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerText = text.slice(0, headerEnd);
  const [requestLine, ...headerLines] = headerText.split("\r\n");
  const [method = "GET", url = "/", version = "HTTP/1.1"] = requestLine.split(" ");
  const parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
  const contentLength = Number(parsedHeaders.headers["content-length"] ?? 0) || 0;
  const bodyStart = headerEnd + 4;
  if (buffer.byteLength - bodyStart < contentLength) return null;
  return {
    consumed: bodyStart + contentLength,
    head: buffer.subarray(bodyStart + contentLength),
    message: new IncomingMessage({
      method,
      url,
      headers: parsedHeaders.headers,
      rawHeaders: parsedHeaders.rawHeaders,
      body: buffer.subarray(bodyStart, bodyStart + contentLength),
    }),
    version,
  };
}

function tryParseHttpRequestHead(buffer) {
  const text = buffer.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerText = text.slice(0, headerEnd);
  const [requestLine, ...headerLines] = headerText.split("\r\n");
  const [method = "GET", url = "/", version = "HTTP/1.1"] = requestLine.split(" ");
  const parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
  return { headerText, headerEnd, method, url, version, headers: parsedHeaders.headers, rawHeaders: parsedHeaders.rawHeaders };
}

function tryParseHttpResponse(buffer, { final = false, method = "GET" } = {}) {
  const text = buffer.toString("latin1");
  const headerEnd = text.indexOf("\r\n\r\n");
  if (headerEnd < 0) return null;
  const headerText = text.slice(0, headerEnd);
  const [statusLine, ...headerLines] = headerText.split("\r\n");
  const match = /^HTTP\/(\d+)\.(\d+)\s+(\d+)\s*(.*)$/.exec(statusLine);
  if (!match) throw new Error("Invalid HTTPS response");
  const parsedHeaders = parseHeaderLines(headerLines.join("\r\n"));
  const bodyStart = headerEnd + 4;
  const bodyBuffer = buffer.subarray(bodyStart);
  const statusCode = Number(match[3]);
  const noBody = method === "HEAD" || method === "CONNECT" || (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
  let body = Buffer.alloc(0);
  let consumed = bodyStart;
  if (!noBody) {
    const transferEncoding = String(parsedHeaders.headers["transfer-encoding"] ?? "").toLowerCase();
    if (transferEncoding.split(",").map((item) => item.trim()).includes("chunked")) {
      const decoded = decodeChunkedBody(bodyBuffer);
      if (decoded == null) return null;
      body = decoded.body;
      consumed = bodyStart + decoded.consumed;
      parsedHeaders.trailers = decoded.trailers;
      parsedHeaders.rawTrailers = decoded.rawTrailers;
    } else if (parsedHeaders.headers["content-length"] != null) {
      const contentLength = Number(parsedHeaders.headers["content-length"]) || 0;
      if (bodyBuffer.byteLength < contentLength) return null;
      body = bodyBuffer.subarray(0, contentLength);
      consumed = bodyStart + contentLength;
    } else {
      if (!final) return null;
      body = bodyBuffer;
      consumed = buffer.byteLength;
    }
  }
  return {
    consumed,
    head: buffer.subarray(consumed),
    message: new IncomingMessage({
      statusCode,
      statusMessage: match[4] || STATUS_CODES[statusCode] || "",
      headers: parsedHeaders.headers,
      rawHeaders: parsedHeaders.rawHeaders,
      trailers: parsedHeaders.trailers,
      rawTrailers: parsedHeaders.rawTrailers,
      body,
    }),
  };
}

export class Agent extends HttpAgent {
  createConnection(options = {}, callback = undefined) {
    const merged = { ...this.options, ...options };
    delete merged.path;
    return tlsConnect({
      ...merged,
      host: merged.host ?? merged.hostname ?? "localhost",
      servername: merged.servername ?? merged.host ?? merged.hostname ?? "localhost",
      port: Number(merged.port ?? 443),
    }, callback);
  }
}

export class Server extends TlsServer {
  constructor(options = {}, requestListener = undefined) {
    super(options);
    this.timeout = Number(options?.timeout ?? 0);
    this.requestTimeout = Number(options?.requestTimeout ?? 300000);
    this.headersTimeout = Number(options?.headersTimeout ?? 60000);
    this.keepAliveTimeout = Number(options?.keepAliveTimeout ?? 5000);
    if (typeof requestListener === "function") this.on("request", requestListener);
    this.on("secureConnection", (socket) => this._handleSecureConnection(socket));
  }

  _handleSecureConnection(socket) {
    let buffer = Buffer.alloc(0);
    let headersTimer = null;
    let requestTimer = null;
    let keepAliveTimer = null;
    const clearKeepAliveTimer = () => {
      if (keepAliveTimer != null) clearTimeout(keepAliveTimer);
      keepAliveTimer = null;
    };
    const clearParserTimers = () => {
      if (headersTimer != null) clearTimeout(headersTimer);
      if (requestTimer != null) clearTimeout(requestTimer);
      headersTimer = null;
      requestTimer = null;
    };
    const failParserTimeout = (message) => {
      const error = new Error(message);
      error.code = "ERR_HTTP_REQUEST_TIMEOUT";
      clearParserTimers();
      if (this.listenerCount("clientError") > 0) this.emit("clientError", error, socket);
      else {
        try { socket.end("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); } catch {}
        socket.destroy?.();
      }
    };
    const refreshHeadersTimer = () => {
      if (!(this.headersTimeout > 0) || headersTimer != null) return;
      headersTimer = setTimeout(() => failParserTimeout("Request header timeout"), this.headersTimeout);
    };
    const refreshRequestTimer = () => {
      if (!(this.requestTimeout > 0) || requestTimer != null) return;
      requestTimer = setTimeout(() => failParserTimeout("Request timeout"), this.requestTimeout);
    };
    refreshHeadersTimer();
    if (this.timeout > 0) {
      socket.setTimeout?.(this.timeout, () => {
        this.emit("timeout", socket);
        if (this.listenerCount("timeout") === 0) socket.destroy?.();
      });
    }
    socket.on("data", (chunk) => {
      clearKeepAliveTimer();
      buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
      const headOnly = tryParseHttpRequestHead(buffer);
      if (headOnly != null) {
        if (headersTimer != null) {
          clearTimeout(headersTimer);
          headersTimer = null;
        }
        const contentLength = Number(headOnly.headers["content-length"] ?? 0) || 0;
        if (contentLength > 0 && buffer.byteLength < headOnly.headerEnd + 4 + contentLength) refreshRequestTimer();
      }
      for (;;) {
        const parsed = tryParseHttpRequest(buffer);
        if (parsed == null) return;
        if (requestTimer != null) {
          clearTimeout(requestTimer);
          requestTimer = null;
        }
        buffer = buffer.subarray(parsed.consumed);
        parsed.message.socket = socket;
        parsed.message.connection = socket;
        const lowerConnection = String(parsed.message.headers.connection ?? "").toLowerCase();
        const upgrade = parsed.message.headers.upgrade;
        const head = parsed.head ?? Buffer.alloc(0);
        if (String(parsed.message.method).toUpperCase() === "CONNECT") {
          if (this.listenerCount("connect") > 0) this.emit("connect", parsed.message, socket, head);
          else socket.destroy();
          return;
        }
        if (upgrade != null || lowerConnection.split(",").map((item) => item.trim()).includes("upgrade")) {
          if (this.listenerCount("upgrade") > 0) this.emit("upgrade", parsed.message, socket, head);
          else socket.destroy();
          return;
        }
        const response = new ServerResponse((webResponse) => {
          try {
            _writeServerResponse(socket, webResponse, { keepAlive: lowerConnection !== "close" });
            if (lowerConnection !== "close" && this.keepAliveTimeout > 0) {
              clearKeepAliveTimer();
              keepAliveTimer = setTimeout(() => socket.destroy?.(), this.keepAliveTimeout);
            }
          } catch (error) {
            socket.destroy(error);
          }
        });
        this.emit("request", parsed.message, response);
      }
    });
    socket.on("close", () => {
      clearParserTimers();
      clearKeepAliveTimer();
    });
  }

  setTimeout(timeout = 0, callback = undefined) {
    this.timeout = Number(timeout) || 0;
    if (typeof callback === "function") this.on("timeout", callback);
    return this;
  }
}

export const globalAgent = new Agent({ protocol: "https:" });

export class ClientRequest extends OutgoingMessage {
  constructor(input, options = undefined, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    super();
    const normalized = normalizeRequestOptions(input, options);
    this.url = normalized.url;
    this.method = String(normalized.options.method ?? "GET").toUpperCase();
    this.path = requestPath(this.url, normalized.options);
    this.host = this.url.host;
    this.protocol = "https:";
    this.aborted = false;
    this.destroyed = false;
    this._responseEmitted = false;
    this._closeEmitted = false;
    this.agent = normalized.options.agent === false ? null : (normalized.options.agent ?? globalAgent);
    this.reusedSocket = false;
    this._socket = null;
    this._agentOptions = null;
    this._options = normalized.options;
    this._timeout = 0;
    this._timeoutTimer = null;
    if (normalized.options.headers) {
      for (const [name, value] of Object.entries(normalized.options.headers)) this.setHeader(name, value);
    }
    if (typeof callback === "function") this.once("response", callback);
  }

  end(chunk = undefined, encoding = undefined, callback = undefined) {
    super.end(chunk, encoding, callback);
    this._dispatch();
    return this;
  }

  abort() {
    this.aborted = true;
    this.destroy();
  }

  destroy(error = undefined) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this._clearTimeoutTimer();
    if (this._socket) this._socket.destroy();
    if (error) this.emit("error", error);
    this._emitClose();
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  setNoDelay() { return this; }
  setSocketKeepAlive() { return this; }
  setTimeout(timeout, callback = undefined) {
    this._timeout = Number(timeout) || 0;
    if (typeof callback === "function") this.once("timeout", callback);
    if (this._socket) this._installTimeout();
    return this;
  }

  _clearTimeoutTimer() {
    if (this._timeoutTimer != null) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = null;
    }
  }

  _installTimeout() {
    this._clearTimeoutTimer();
    if (!(this._timeout > 0) || this.destroyed) return;
    this._timeoutTimer = setTimeout(() => {
      this._timeoutTimer = null;
      if (!this.destroyed) {
        this.emit("timeout");
        this._socket?.emit?.("timeout");
      }
    }, this._timeout);
  }

  _emitClose() {
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit("close");
  }

  _emitParsedResponse(parsed) {
    if (this._responseEmitted || parsed == null) return;
    this._responseEmitted = true;
    if (this.method === "CONNECT" && parsed.message.statusCode >= 200 && parsed.message.statusCode < 300) {
      this.emit("connect", parsed.message, this._socket, Buffer.from(parsed.head ?? []));
      return;
    }
    if (parsed.message.statusCode === 101) {
      this.emit("upgrade", parsed.message, this._socket, Buffer.from(parsed.head ?? []));
      return;
    }
    this.emit("response", parsed.message);
  }

  _dispatch() {
    if (this.aborted) return;
    const requestOptions = {
      host: this.url.hostname,
      port: Number(this._options._port || 443),
      servername: this._options.servername ?? this.url.hostname,
      _agentName: this.agent?.getName?.({
        ...this._options,
        host: this.url.hostname,
        hostname: this.url.hostname,
        port: Number(this._options._port || 443),
      }),
    };
    if (this._options.rejectUnauthorized !== undefined) requestOptions.rejectUnauthorized = this._options.rejectUnauthorized;
    if (this._options.ca !== undefined) requestOptions.ca = this._options.ca;
    this._agentOptions = requestOptions;
    if (this.agent && typeof this.agent.addRequest === "function") {
      this.agent.addRequest(this, requestOptions);
      return;
    }
    const socket = tlsConnect(requestOptions);
    this.onSocket(socket, false);
  }

  onSocket(socket, reused = false) {
    if (this.aborted || this.destroyed) {
      socket.destroy?.();
      return;
    }
    this._socket = socket;
    this.reusedSocket = Boolean(reused);
    let responseBuffer = Buffer.alloc(0);
    let completed = false;
    let continueBody = null;
    let continueTimer = null;
    const sendContinueBody = () => {
      if (continueBody == null) return;
      const body = continueBody;
      continueBody = null;
      if (continueTimer != null) {
        clearTimeout(continueTimer);
        continueTimer = null;
      }
      if (body.byteLength > 0) socket.write(body);
    };
    const cleanup = () => {
      this._clearTimeoutTimer();
      if (continueTimer != null) {
        clearTimeout(continueTimer);
        continueTimer = null;
      }
      socket.off?.("secureConnect", onConnect);
      socket.off?.("data", onData);
      socket.off?.("end", onEnd);
      socket.off?.("error", onError);
    };
    const releaseOrClose = (parsed) => {
      if (completed) return;
      completed = true;
      cleanup();
      const lowerConnection = String(parsed?.message?.headers?.connection ?? "").toLowerCase();
      const isTunnel = (this.method === "CONNECT" && parsed?.message?.statusCode >= 200 && parsed?.message?.statusCode < 300) || parsed?.message?.statusCode === 101;
      const canKeepAlive = this.agent?.keepAlive && lowerConnection !== "close" && this.method !== "CONNECT" && parsed?.message?.statusCode !== 101;
      if (!isTunnel) {
        if (canKeepAlive) this.agent._releaseSocket?.(socket, this._agentOptions ?? this._options);
        else socket.end?.();
      }
      this._emitClose();
    };
    const onConnect = () => {
      if (this.aborted || this.destroyed) return;
      this._installTimeout();
      const body = this.method === "HEAD" ? Buffer.alloc(0) : this._bodyBuffer();
      if (!this.hasHeader("host")) this.setHeader("Host", this.url.host);
      if (body.byteLength > 0 && !this.hasHeader("content-length")) this.setHeader("Content-Length", body.byteLength);
      if (!this.hasHeader("connection")) this.setHeader("Connection", this.agent?.keepAlive ? "keep-alive" : "close");
      const headers = this.getHeaders();
      const lines = [`${this.method} ${this.path} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const item of value) lines.push(`${name}: ${item}`);
        } else {
          lines.push(`${name}: ${value}`);
        }
      }
      lines.push("", "");
      const expectsContinue = String(this.getHeader("expect") ?? "").toLowerCase() === "100-continue";
      if (expectsContinue && body.byteLength > 0) {
        continueBody = body;
        socket.write(Buffer.from(lines.join("\r\n")));
        continueTimer = setTimeout(sendContinueBody, 1000);
      } else {
        socket.write(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
      }
    };
    const onData = (chunk) => {
      if (this._responseEmitted) return;
      this._installTimeout();
      responseBuffer = Buffer.concat([responseBuffer, Buffer.from(chunk)]);
      for (;;) {
        const parsed = tryParseHttpResponse(responseBuffer, { method: this.method });
        if (parsed == null) return;
        responseBuffer = responseBuffer.subarray(parsed.consumed);
        if (parsed.message.statusCode >= 100 && parsed.message.statusCode < 200 && parsed.message.statusCode !== 101) {
          if (parsed.message.statusCode === 100) {
            this.emit("continue");
            sendContinueBody();
          } else {
            this.emit("information", {
              statusCode: parsed.message.statusCode,
              statusMessage: parsed.message.statusMessage,
              headers: parsed.message.headers,
              rawHeaders: parsed.message.rawHeaders,
            });
          }
          continue;
        }
        this._emitParsedResponse(parsed);
        releaseOrClose(parsed);
        return;
      }
    };
    const onEnd = () => {
      if (!this._responseEmitted) {
        const parsed = tryParseHttpResponse(responseBuffer, { final: true, method: this.method });
        this._emitParsedResponse(parsed);
      }
      cleanup();
      this._emitClose();
    };
    const onError = (error) => {
      cleanup();
      this.emit("error", error);
      this._emitClose();
    };
    socket.once("secureConnect", onConnect);
    socket.on("data", onData);
    socket.on("end", onEnd);
    socket.on("error", onError);
    if (reused || socket.readyState === "open") queueMicrotask(onConnect);
  }
}

export function request(input, options = undefined, callback = undefined) {
  return new ClientRequest(input, options, callback);
}

export function get(input, options = undefined, callback = undefined) {
  const req = request(input, options, callback);
  req.end();
  return req;
}

export function createServer(options = {}, requestListener = undefined) {
  return new Server(options, requestListener);
}

export default {
  Agent,
  ClientRequest,
  Server,
  createServer,
  get,
  globalAgent,
  request,
};
