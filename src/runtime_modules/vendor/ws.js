import EventEmitter from "../node/events.js";
import { Buffer } from "../node/buffer.js";
import { Duplex } from "../node/stream.js";
import {
  STATUS_CODES,
  WebSocket as RuntimeWebSocket,
  createServer as createHttpServer,
  parseWebSocketFrames,
  websocketAcceptKey,
  websocketFrame,
} from "../node/http.js";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const RUNNING = 0;
const SERVER_CLOSING = 1;
const SERVER_CLOSED = 2;
const websocketKeyPattern = /^[+/0-9A-Za-z]{22}==$/;
const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function bytesFromData(data) {
  if (data == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return Buffer.from(String(data));
}

function normalizeData(data, options) {
  if (typeof data === "number") data = String(data);
  if (options?.binary === true && typeof data === "string") return Buffer.from(data);
  if (options?.binary === false && (ArrayBuffer.isView(data) || data instanceof ArrayBuffer)) {
    return bytesFromData(data).toString("utf8");
  }
  return data;
}

function extractAgentOptions(agent) {
  const connectOptions = agent?.connectOpts || agent?.options;
  let tls = null;
  if (connectOptions && typeof connectOptions === "object") {
    const next = {};
    for (const name of ["rejectUnauthorized", "ca", "cert", "key", "passphrase"]) {
      if (connectOptions[name] !== undefined) next[name] = connectOptions[name];
    }
    if (Object.keys(next).length > 0) tls = next;
  }

  let proxy = null;
  const agentProxy = connectOptions?.proxy || agent?.proxy;
  if (agentProxy) {
    const url = agentProxy?.href || agentProxy;
    if (agent?.proxyHeaders) {
      const headers = typeof agent.proxyHeaders === "function" ? agent.proxyHeaders() : agent.proxyHeaders;
      proxy = { url, headers };
    } else {
      proxy = url;
    }
  }
  return { proxy, tls };
}

function replacePropertyListener(target, name, listener, wrap) {
  const key = `_property_${name}`;
  if (target[key]) target.off(name, target[key]);
  target[key] = null;
  if (typeof listener !== "function") return;
  const wrapped = wrap ? wrap(listener) : listener;
  target[key] = wrapped;
  target.on(name, wrapped);
}

class WebSocket extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(url, protocols = undefined, options = undefined) {
    super();
    this._ws = null;
    this._url = String(url);
    this._binaryType = "nodebuffer";
    this._fragments = false;
    this._eventListeners = new Map();

    if (protocols === undefined) {
      protocols = [];
    } else if (!Array.isArray(protocols)) {
      if (protocols !== null && typeof protocols === "object") {
        options = protocols;
        protocols = options.protocols ?? options.protocol ?? [];
      } else {
        protocols = [protocols];
      }
    }
    if (!Array.isArray(protocols)) protocols = [protocols];
    options = options && typeof options === "object" ? options : {};

    let proxy = options.proxy;
    let tls = options.tls;
    if (options.agent && typeof options.agent === "object") {
      const extracted = extractAgentOptions(options.agent);
      if (!proxy) proxy = extracted.proxy;
      if (!tls) tls = extracted.tls;
    }

    let headers = options.headers;
    const connect = () => {
      if (this._ws) return;
      const runtimeOptions = { protocols };
      if (headers) runtimeOptions.headers = headers;
      if (proxy) runtimeOptions.proxy = proxy;
      if (tls) runtimeOptions.tls = tls;
      if ("perMessageDeflate" in options && !options.perMessageDeflate) runtimeOptions.perMessageDeflate = false;
      this._attach(new RuntimeWebSocket(url, runtimeOptions));
    };

    if (typeof options.finishRequest === "function") {
      const request = this._createFinishRequest(headers, connect, (next) => { headers = next; });
      options.finishRequest(request);
      connect();
    } else {
      connect();
    }
  }

  _createFinishRequest(initialHeaders, connect, updateHeaders) {
    const headers = Object.create(null);
    if (initialHeaders != null) {
      const entries = typeof initialHeaders.entries === "function" ? initialHeaders.entries() : Object.entries(initialHeaders);
      for (const [name, value] of entries) headers[String(name).toLowerCase()] = value;
    }
    updateHeaders(headers);
    let ended = false;
    return {
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      getHeader(name) { return headers[String(name).toLowerCase()]; },
      removeHeader(name) { delete headers[String(name).toLowerCase()]; },
      hasHeader(name) { return Object.prototype.hasOwnProperty.call(headers, String(name).toLowerCase()); },
      getHeaders() { return { ...headers }; },
      get rawHeaders() {
        const raw = [];
        for (const [name, value] of Object.entries(headers)) raw.push(name, value);
        return raw;
      },
      method: "GET",
      path: this._url,
      headersSent: false,
      abort() {},
      write() { return true; },
      end() {
        if (ended) return;
        ended = true;
        connect();
      },
      [Symbol.toStringTag]: "ClientRequest",
    };
  }

  _attach(ws) {
    this._ws = ws;
    ws.binaryType = this._binaryType === "arraybuffer" ? "arraybuffer" : "nodebuffer";
    ws.addEventListener("open", () => this.emit("open"));
    ws.addEventListener("close", (event) => this.emit("close", event.code, event.reason, event.wasClean));
    ws.addEventListener("error", (event) => this.emit("error", event?.error ?? event));
    ws.addEventListener("message", (event) => {
      const isBinary = typeof event.data !== "string";
      let data = event.data;
      if (!isBinary) {
        const bytes = Buffer.from(data);
        data = this._binaryType === "arraybuffer"
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : bytes;
      }
      if (this._fragments) data = [data];
      this.emit("message", data, isBinary);
    });
    ws.addEventListener("ping", (event) => this.emit("ping", event.data));
    ws.addEventListener("pong", (event) => this.emit("pong", event.data));
  }

  send(data, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    try {
      this._ws.send(normalizeData(data, options));
      if (typeof callback === "function") process.nextTick(callback, null);
    } catch (error) {
      if (typeof callback === "function") process.nextTick(callback, error);
      else throw error;
    }
  }

  ping(data, mask, callback) {
    if (typeof data === "function") {
      callback = data;
      data = undefined;
    } else if (typeof mask === "function") {
      callback = mask;
    }
    try {
      this._ws.ping(data);
      if (typeof callback === "function") callback();
    } catch (error) {
      if (typeof callback === "function") callback(error);
      else throw error;
    }
  }

  pong(data, mask, callback) {
    if (typeof data === "function") {
      callback = data;
      data = undefined;
    } else if (typeof mask === "function") {
      callback = mask;
    }
    try {
      this._ws.pong(data);
      if (typeof callback === "function") callback();
    } catch (error) {
      if (typeof callback === "function") callback(error);
      else throw error;
    }
  }

  close(code, reason) { this._ws?.close(code, reason); }
  terminate() { this._ws?.terminate(); }

  pause() { this._paused = true; }
  resume() { this._paused = false; }
  get isPaused() { return this._paused === true; }
  get url() { return this._ws?.url ?? this._url; }
  get readyState() { return this._ws?.readyState ?? CONNECTING; }
  get protocol() { return this._ws?.protocol ?? ""; }
  get extensions() { return this._ws?.extensions ?? ""; }
  get bufferedAmount() { return this._ws?.bufferedAmount ?? 0; }

  get binaryType() { return this._binaryType; }
  set binaryType(value) {
    if (value !== "nodebuffer" && value !== "arraybuffer" && value !== "fragments") {
      throw new TypeError(`Invalid binaryType: ${value}`);
    }
    this._binaryType = value;
    this._fragments = value === "fragments";
    if (this._ws) this._ws.binaryType = value === "arraybuffer" ? "arraybuffer" : "nodebuffer";
  }

  addEventListener(type, listener, options = undefined) {
    if (typeof listener !== "function") return;
    let listeners = this._eventListeners.get(type);
    if (!listeners) this._eventListeners.set(type, listeners = new Map());
    if (listeners.has(listener)) return;
    let wrapped;
    if (type === "message") wrapped = (data) => listener({ type, target: this, data });
    else if (type === "close") wrapped = (code, reason, wasClean) => listener({ type, target: this, code, reason, wasClean });
    else if (type === "ping" || type === "pong") wrapped = (data) => listener({ type, target: this, data });
    else wrapped = (event) => listener(event?.type ? event : { type, target: this });
    listeners.set(listener, wrapped);
    if (options === true || options?.once) this.once(type, wrapped);
    else this.on(type, wrapped);
  }

  removeEventListener(type, listener) {
    const listeners = this._eventListeners.get(type);
    const wrapped = listeners?.get(listener);
    if (!wrapped) return;
    this.off(type, wrapped);
    listeners.delete(listener);
  }

  get onopen() { return this._onopen ?? null; }
  set onopen(value) {
    this._onopen = typeof value === "function" ? value : null;
    replacePropertyListener(this, "open", this._onopen, (listener) => () => listener({ type: "open", target: this }));
  }
  get onerror() { return this._onerror ?? null; }
  set onerror(value) {
    this._onerror = typeof value === "function" ? value : null;
    replacePropertyListener(this, "error", this._onerror, (listener) => (error) => listener({ type: "error", target: this, error }));
  }
  get onclose() { return this._onclose ?? null; }
  set onclose(value) {
    this._onclose = typeof value === "function" ? value : null;
    replacePropertyListener(this, "close", this._onclose, (listener) => (code, reason, wasClean) => {
      listener({ type: "close", target: this, code, reason, wasClean });
    });
  }
  get onmessage() { return this._onmessage ?? null; }
  set onmessage(value) {
    this._onmessage = typeof value === "function" ? value : null;
    replacePropertyListener(this, "message", this._onmessage, (listener) => (data) => listener({ data, target: this, type: "message" }));
  }
}

function convertBinary(type, payload) {
  if (type === "arraybuffer") return payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  if (type === "blob" && typeof Blob === "function") return new Blob([payload]);
  return Buffer.from(payload);
}

class ServerWebSocketConnection extends EventEmitter {
  constructor(socket, request, head, options) {
    super();
    this._socket = socket;
    this._request = request;
    this._options = options;
    this._buffer = Buffer.alloc(0);
    this._fragments = [];
    this._fragmentOpcode = 0;
    this._closed = false;
    this._eventListeners = new Map();
    this.readyState = OPEN;
    this.binaryType = "nodebuffer";
    this.url = request.url;
    this.protocol = options.protocol ?? "";
    this.extensions = options.extensions ?? "";
    socket.on("data", (chunk) => this._handleData(chunk));
    socket.on("error", (error) => {
      if (this.listenerCount("error") > 0) this.emit("error", error);
    });
    socket.on("close", () => this._finishClose(1006, "", false));
    if (head?.byteLength) queueMicrotask(() => this._handleData(head));
  }

  _protocolError(reason) {
    if (this.readyState === OPEN) {
      const reasonBytes = Buffer.from(reason);
      const payload = Buffer.alloc(2 + reasonBytes.byteLength);
      payload.writeUInt16BE(1002, 0);
      payload.set(reasonBytes, 2);
      try { this._socket.write(websocketFrame(0x8, payload, false)); } catch {}
    }
    this.readyState = CLOSING;
    try { this._socket.end(); } catch {}
    this._finishClose(1002, reason, false);
  }

  _handleData(chunk) {
    if (this._closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._buffer = this._buffer.byteLength === 0 ? bytes : Buffer.concat([this._buffer, bytes]);
    let parsed;
    try {
      parsed = parseWebSocketFrames(this._buffer);
    } catch (error) {
      this._protocolError(error?.message ?? "Invalid WebSocket frame");
      return;
    }
    this._buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (this._closed) return;
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    if (!frame.masked) {
      this._protocolError("Client frames must be masked");
      return;
    }
    if (frame.rsv1 || frame.rsv2 || frame.rsv3) {
      this._protocolError("Invalid RSV bits");
      return;
    }
    if (frame.opcode >= 0x8 && (!frame.fin || frame.payload.byteLength > 125)) {
      this._protocolError("Invalid control frame");
      return;
    }
    if (frame.opcode === 0x8) {
      const code = frame.payload.byteLength >= 2 ? frame.payload.readUInt16BE(0) : 1000;
      const reason = frame.payload.byteLength > 2 ? frame.payload.subarray(2).toString("utf8") : "";
      if (this.readyState === OPEN) {
        this.readyState = CLOSING;
        try { this._socket.write(websocketFrame(0x8, frame.payload, false)); } catch {}
      }
      try { this._socket.end(); } catch {}
      this._finishClose(code, reason, true);
      return;
    }
    if (frame.opcode === 0x9) {
      if (this.readyState === OPEN) {
        try { this._socket.write(websocketFrame(0xA, frame.payload, false)); } catch {}
      }
      this.emit("ping", convertBinary(this.binaryType, frame.payload));
      return;
    }
    if (frame.opcode === 0xA) {
      this.emit("pong", convertBinary(this.binaryType, frame.payload));
      return;
    }
    if (frame.opcode === 0x1 || frame.opcode === 0x2) {
      if (this._fragmentOpcode !== 0) {
        this._protocolError("Unexpected data frame");
        return;
      }
      this._fragmentOpcode = frame.opcode;
      this._fragments = [frame.payload];
    } else if (frame.opcode === 0x0 && this._fragmentOpcode !== 0) {
      this._fragments.push(frame.payload);
    } else {
      this._protocolError("Invalid opcode");
      return;
    }
    const length = this._fragments.reduce((total, part) => total + part.byteLength, 0);
    if (length > this._options.maxPayload) {
      this.close(1009, "Message too big");
      return;
    }
    if (!frame.fin) return;
    const opcode = this._fragmentOpcode;
    const payload = this._fragments.length === 1 ? this._fragments[0] : Buffer.concat(this._fragments, length);
    this._fragmentOpcode = 0;
    this._fragments = [];
    const isBinary = opcode === 0x2;
    const data = isBinary ? convertBinary(this.binaryType, payload) : convertBinary(this.binaryType, payload);
    this.emit("message", data, isBinary);
  }

  _finishClose(code, reason, wasClean) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = CLOSED;
    if (this._closeTimer) clearTimeout(this._closeTimer);
    this.emit("close", code, reason, wasClean);
  }

  send(data, options, callback) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    if (this.readyState !== OPEN) {
      const error = new Error(`WebSocket is not open: readyState ${this.readyState}`);
      if (typeof callback === "function") process.nextTick(callback, error);
      else throw error;
      return;
    }
    const normalized = normalizeData(data, options);
    const opcode = options?.binary === false || (typeof normalized === "string" && options?.binary !== true) ? 0x1 : 0x2;
    try {
      this._socket.write(websocketFrame(opcode, normalized, false), () => {
        if (typeof callback === "function") callback(null);
      });
    } catch (error) {
      if (typeof callback === "function") process.nextTick(callback, error);
      else throw error;
    }
  }

  _sendControl(opcode, data, callback) {
    if (this.readyState !== OPEN) throw new Error(`WebSocket is not open: readyState ${this.readyState}`);
    let payload = bytesFromData(data);
    if (payload.byteLength > 125) payload = payload.subarray(0, 125);
    this._socket.write(websocketFrame(opcode, payload, false), () => {
      if (typeof callback === "function") callback();
    });
  }

  ping(data, mask, callback) {
    if (typeof data === "function") {
      callback = data;
      data = undefined;
    } else if (typeof mask === "function") {
      callback = mask;
    }
    this._sendControl(0x9, data, callback);
  }

  pong(data, mask, callback) {
    if (typeof data === "function") {
      callback = data;
      data = undefined;
    } else if (typeof mask === "function") {
      callback = mask;
    }
    this._sendControl(0xA, data, callback);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSING;
    const reasonBytes = Buffer.from(String(reason ?? ""));
    const payload = Buffer.alloc(2 + reasonBytes.byteLength);
    payload.writeUInt16BE(Number(code) || 1000, 0);
    payload.set(reasonBytes, 2);
    try { this._socket.write(websocketFrame(0x8, payload, false)); } catch {}
    this._closeTimer = setTimeout(() => this.terminate(), 30_000);
    this._closeTimer?.unref?.();
  }

  terminate() {
    if (this.readyState === CLOSED) return;
    try { this._socket.destroy(); } catch {}
    this._finishClose(1006, "", false);
  }

  get bufferedAmount() { return this._socket?.writableLength ?? 0; }
  get onopen() { return this._onopen ?? null; }
  set onopen(value) {
    this._onopen = typeof value === "function" ? value : null;
    if (this._onopen) queueMicrotask(() => this._onopen?.({ type: "open", target: this }));
  }
  get onerror() { return this._onerror ?? null; }
  set onerror(value) {
    this._onerror = typeof value === "function" ? value : null;
    replacePropertyListener(this, "error", this._onerror);
  }
  get onclose() { return this._onclose ?? null; }
  set onclose(value) {
    this._onclose = typeof value === "function" ? value : null;
    replacePropertyListener(this, "close", this._onclose, (listener) => (code, reason, wasClean) => listener({ type: "close", target: this, code, reason, wasClean }));
  }
  get onmessage() { return this._onmessage ?? null; }
  set onmessage(value) {
    this._onmessage = typeof value === "function" ? value : null;
    replacePropertyListener(this, "message", this._onmessage, (listener) => (data) => listener({ type: "message", target: this, data }));
  }
  addEventListener(type, listener, options) {
    if (typeof listener !== "function") return;
    let listeners = this._eventListeners.get(type);
    if (!listeners) this._eventListeners.set(type, listeners = new Map());
    if (listeners.has(listener)) return;
    const wrapped = type === "message"
      ? (data) => listener({ type, target: this, data })
      : type === "close"
        ? (code, reason, wasClean) => listener({ type, target: this, code, reason, wasClean })
        : (...args) => listener({ type, target: this, data: args[0] });
    listeners.set(listener, wrapped);
    if (options === true || options?.once) this.once(type, wrapped);
    else this.on(type, wrapped);
  }
  removeEventListener(type, listener) {
    const listeners = this._eventListeners.get(type);
    const wrapped = listeners?.get(listener);
    if (!wrapped) return;
    this.off(type, wrapped);
    listeners.delete(listener);
  }
}

for (const [name, value] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
  Object.defineProperty(WebSocket.prototype, name, { value, enumerable: true });
  Object.defineProperty(ServerWebSocketConnection.prototype, name, { value, enumerable: true });
}

function parseProtocols(header) {
  const result = new Set();
  for (const raw of String(header ?? "").split(",")) {
    const protocol = raw.trim();
    if (!protocol || !tokenPattern.test(protocol) || result.has(protocol)) throw new SyntaxError("Invalid Sec-WebSocket-Protocol header");
    result.add(protocol);
  }
  return result;
}

function abortHandshake(server, request, socket, code, message = STATUS_CODES[code] ?? "Error", headers = {}) {
  if (server.listenerCount("wsClientError") > 0) {
    const error = new Error(message);
    server.emit("wsClientError", error, socket, request);
    return;
  }
  const body = Buffer.from(String(message));
  const lines = [
    `HTTP/1.1 ${code} ${STATUS_CODES[code] ?? "Error"}`,
    "Connection: close",
    "Content-Type: text/html",
    `Content-Length: ${body.byteLength}`,
  ];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  lines.push("", "");
  try {
    socket.write(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
    socket.end();
  } catch {}
}

class WebSocketServer extends EventEmitter {
  constructor(options, callback) {
    super();
    options = {
      maxPayload: 100 * 1024 * 1024,
      skipUTF8Validation: false,
      perMessageDeflate: false,
      handleProtocols: null,
      clientTracking: true,
      verifyClient: null,
      noServer: false,
      backlog: null,
      server: null,
      host: null,
      path: null,
      port: null,
      ...options,
    };
    if ((options.port == null && !options.server && !options.noServer) ||
        (options.port != null && (options.server || options.noServer)) ||
        (options.server && options.noServer)) {
      throw new TypeError('One and only one of the "port", "server", or "noServer" options must be specified');
    }
    this.options = options;
    this.clients = options.clientTracking ? new Set() : undefined;
    this._state = RUNNING;
    this._shouldEmitClose = false;
    this._upgradedSockets = new WeakSet();
    this._ownedServer = options.port != null;

    if (this._ownedServer) {
      this._server = createHttpServer((_request, response) => {
        const body = STATUS_CODES[426];
        response.writeHead(426, { "Content-Length": Buffer.byteLength(body), "Content-Type": "text/plain" });
        response.end(body);
      });
      this._attachServer(this._server);
      this._server.listen(options.port, options.host, options.backlog, callback);
    } else if (options.server) {
      this._server = options.server;
      this._attachServer(this._server);
      if (typeof callback === "function") this.once("listening", callback);
    } else {
      this._server = null;
      if (typeof callback === "function") this.once("listening", callback);
    }
  }

  _attachServer(server) {
    this._onListening = () => this.emit("listening");
    this._onError = (error) => this.emit("error", error);
    this._onUpgrade = (request, socket, head) => {
      this.handleUpgrade(request, socket, head, (ws) => this.emit("connection", ws, request));
    };
    server.on("listening", this._onListening);
    server.on("error", this._onError);
    server.on("upgrade", this._onUpgrade);
  }

  _detachServer() {
    if (!this._server) return;
    this._server.off("listening", this._onListening);
    this._server.off("error", this._onError);
    this._server.off("upgrade", this._onUpgrade);
  }

  address() {
    if (this.options.noServer) throw new Error('The server is operating in "noServer" mode');
    return this._server?.address() ?? null;
  }

  shouldHandle(request) {
    if (!this.options.path) return true;
    const index = request.url.indexOf("?");
    return (index < 0 ? request.url : request.url.slice(0, index)) === this.options.path;
  }

  handleUpgrade(request, socket, head, callback) {
    if (this._state !== RUNNING) return abortHandshake(this, request, socket, 503);
    if (this._upgradedSockets.has(socket)) throw new Error("server.handleUpgrade() was called more than once with the same socket");
    const key = request.headers["sec-websocket-key"];
    const version = Number(request.headers["sec-websocket-version"]);
    if (request.method !== "GET") return abortHandshake(this, request, socket, 405, "Invalid HTTP method");
    if (String(request.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      return abortHandshake(this, request, socket, 400, "Invalid Upgrade header");
    }
    if (!key || !websocketKeyPattern.test(String(key))) {
      return abortHandshake(this, request, socket, 400, "Missing or invalid Sec-WebSocket-Key header");
    }
    if (version !== 8 && version !== 13) {
      return abortHandshake(this, request, socket, 400, "Missing or invalid Sec-WebSocket-Version header", {
        "Sec-WebSocket-Version": "13",
      });
    }
    if (!this.shouldHandle(request)) return abortHandshake(this, request, socket, 400);

    let protocols = new Set();
    if (request.headers["sec-websocket-protocol"] !== undefined) {
      try { protocols = parseProtocols(request.headers["sec-websocket-protocol"]); }
      catch { return abortHandshake(this, request, socket, 400, "Invalid Sec-WebSocket-Protocol header"); }
    }

    const finish = () => this._completeUpgrade(key, protocols, request, socket, head, callback);
    const verify = this.options.verifyClient;
    if (typeof verify === "function") {
      const info = {
        origin: request.headers[version === 8 ? "sec-websocket-origin" : "origin"],
        secure: Boolean(request.socket?.authorized || request.socket?.encrypted),
        req: request,
      };
      if (verify.length === 2) {
        verify(info, (accepted, code, message, headers) => {
          if (!accepted) abortHandshake(this, request, socket, code || 401, message, headers);
          else finish();
        });
        return;
      }
      if (!verify(info)) return abortHandshake(this, request, socket, 401);
    }
    finish();
  }

  _completeUpgrade(key, protocols, request, socket, head, callback) {
    this._upgradedSockets.add(socket);
    let protocol = "";
    if (protocols.size > 0) {
      protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, request) : protocols.values().next().value;
      if (protocol === false) protocol = "";
    }
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAcceptKey(String(key))}`,
    ];
    if (protocol) headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
    this.emit("headers", headers, request);
    headers.push("", "");
    try { socket.write(headers.join("\r\n")); }
    catch {
      socket.destroy?.();
      return;
    }

    const ws = new ServerWebSocketConnection(socket, request, head, {
      maxPayload: Number(this.options.maxPayload) || 0,
      protocol,
      extensions: "",
    });
    if (this.clients) {
      this.clients.add(ws);
      ws.once("close", () => {
        this.clients.delete(ws);
        if (this._shouldEmitClose && this.clients.size === 0) this._emitClose();
      });
    }
    callback(ws, request);
  }

  _emitClose() {
    if (this._state === SERVER_CLOSED) return;
    this._state = SERVER_CLOSED;
    this.emit("close");
  }

  close(callback) {
    if (typeof callback === "function") this.once("close", callback);
    if (this._state === SERVER_CLOSED) {
      process.nextTick(() => this.emit("close"));
      return;
    }
    if (this._state === SERVER_CLOSING) return;
    this._state = SERVER_CLOSING;
    this._detachServer();
    if (this._ownedServer && this._server) {
      const server = this._server;
      this._server = null;
      server.close(() => this._emitClose());
      return;
    }
    this._server = null;
    if (this.clients?.size) this._shouldEmitClose = true;
    else process.nextTick(() => this._emitClose());
  }
}

const Server = WebSocketServer;

class Sender {
  constructor(socket) { this._socket = socket; }
  send(data, options = {}, callback) {
    const opcode = options.binary === false ? 0x1 : 0x2;
    this._socket.write(websocketFrame(opcode, data, Boolean(options.mask)), callback);
  }
  ping(data, mask, callback) { this._socket.write(websocketFrame(0x9, data, Boolean(mask)), callback); }
  pong(data, mask, callback) { this._socket.write(websocketFrame(0xA, data, Boolean(mask)), callback); }
  close(code = 1000, data = "", mask = false, callback) {
    const reason = bytesFromData(data);
    const payload = Buffer.alloc(2 + reason.byteLength);
    payload.writeUInt16BE(code, 0);
    payload.set(reason, 2);
    this._socket.write(websocketFrame(0x8, payload, Boolean(mask)), callback);
  }
}

class Receiver extends EventEmitter {
  constructor(options = {}) {
    super();
    this._buffer = Buffer.alloc(0);
    this._options = options;
  }
  write(chunk, callback) {
    this._buffer = Buffer.concat([this._buffer, bytesFromData(chunk)]);
    const parsed = parseWebSocketFrames(this._buffer);
    this._buffer = parsed.remaining;
    for (const frame of parsed.frames) {
      if (frame.opcode === 0x1 || frame.opcode === 0x2) this.emit("message", frame.payload, frame.opcode === 0x2);
      else if (frame.opcode === 0x9) this.emit("ping", frame.payload);
      else if (frame.opcode === 0xA) this.emit("pong", frame.payload);
      else if (frame.opcode === 0x8) this.emit("conclude", frame.payload.byteLength >= 2 ? frame.payload.readUInt16BE(0) : 1000, frame.payload.subarray(2));
    }
    if (typeof callback === "function") callback();
    return true;
  }
}

function createWebSocketStream(ws, options = {}) {
  const stream = new Duplex({
    ...options,
    read() { ws.resume?.(); },
    write(chunk, encoding, callback) { ws.send(chunk, callback); },
    final(callback) { ws.close(); callback(); },
    destroy(error, callback) { ws.terminate(); callback(error); },
  });
  ws.on("message", (data) => {
    if (!stream.push(data)) ws.pause?.();
  });
  ws.once("close", () => stream.push(null));
  ws.once("error", (error) => stream.destroy(error));
  return stream;
}

Object.assign(WebSocket, {
  CONNECTING,
  OPEN,
  CLOSING,
  CLOSED,
  WebSocket,
  WebSocketServer,
  Server,
  Sender,
  Receiver,
  createWebSocketStream,
});

export { Receiver, Sender, Server, WebSocket, WebSocketServer, createWebSocketStream };
export default WebSocket;
