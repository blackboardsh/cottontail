import EventEmitter from "./events.js";

const nativeInspector = globalThis.cottontail;
const sessions = new Set();
const networkResources = new Map();
let nextResourceId = 1;

function inspectorError(message, code = "ERR_INSPECTOR_COMMAND") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function protocolError(payload) {
  const numericCode = Number(payload?.code ?? -32000);
  const error = inspectorError(
    `Inspector error ${numericCode}: ${payload?.message ?? "Unknown inspector error"}`,
  );
  error.errno = numericCode;
  if (payload?.data !== undefined) error.data = payload.data;
  return error;
}

function notification(method, params = {}) {
  const message = { method, params };
  for (const session of sessions) {
    session.emit(method, message);
    session.emit("inspectorNotification", message);
  }
}

function randomInspectorPath() {
  return `/${Math.random().toString(36).slice(2) || "cottontail"}`;
}

export class Session extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this._nativeId = 0;
    this._nextRequestId = 1;
    this._callbacks = new Map();
    this._pollTimer = undefined;
    this._polling = false;
  }

  connect() {
    if (this.connected) {
      throw inspectorError("The inspector session is already connected", "ERR_INSPECTOR_ALREADY_CONNECTED");
    }
    try {
      this._nativeId = nativeInspector.inspectorSessionConnect();
    } catch (cause) {
      const error = inspectorError(cause?.message ?? String(cause), "ERR_INSPECTOR_NOT_AVAILABLE");
      error.cause = cause;
      throw error;
    }
    this.connected = true;
    sessions.add(this);
    this._pollTimer = setInterval(() => this._poll(), 1);
    this._pollTimer?.unref?.();
  }

  connectToMainThread() {
    this.connect();
  }

  _poll() {
    if (!this.connected || this._polling) return;
    this._polling = true;
    try {
      const messages = nativeInspector.inspectorSessionTake(this._nativeId);
      for (const encoded of messages) {
        let message;
        try {
          message = JSON.parse(encoded);
        } catch {
          continue;
        }
        if (message && Object.hasOwn(message, "id")) {
          const callback = this._callbacks.get(message.id);
          this._callbacks.delete(message.id);
          if (typeof callback === "function") {
            if (message.error) callback(protocolError(message.error));
            else callback(null, message.result ?? {});
          }
          continue;
        }
        if (typeof message?.method === "string") {
          this.emit(message.method, message);
          this.emit("inspectorNotification", message);
        }
      }
      if (this._callbacks.size === 0) this._pollTimer?.unref?.();
    } finally {
      this._polling = false;
    }
  }

  post(method, params = undefined, callback = undefined) {
    if (typeof params === "function") {
      callback = params;
      params = undefined;
    }
    if (!this.connected) throw inspectorError("Session is not connected", "ERR_INSPECTOR_NOT_CONNECTED");
    if (typeof method !== "string") {
      throw new TypeError('The "method" argument must be of type string');
    }
    if (callback !== undefined && typeof callback !== "function") {
      throw new TypeError('The "callback" argument must be of type function');
    }

    if (method === "Network.getResponseBody") {
      const requestId = String(params?.requestId ?? "");
      queueMicrotask(() => {
        if (!networkResources.has(requestId)) {
          callback?.(inspectorError(`No resource with given identifier found: ${requestId}`));
        } else {
          callback?.(null, { body: networkResources.get(requestId), base64Encoded: false });
        }
      });
      return undefined;
    }

    const id = this._nextRequestId++;
    const message = { id, method };
    if (params !== undefined) message.params = params;
    this._callbacks.set(id, callback ?? null);
    this._pollTimer?.ref?.();
    try {
      nativeInspector.inspectorSessionSend(this._nativeId, JSON.stringify(message));
    } catch (cause) {
      this._callbacks.delete(id);
      if (this._callbacks.size === 0) this._pollTimer?.unref?.();
      const error = inspectorError(cause?.message ?? String(cause), "ERR_INSPECTOR_NOT_CONNECTED");
      error.cause = cause;
      throw error;
    }
    return undefined;
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    sessions.delete(this);
    clearInterval(this._pollTimer);
    this._pollTimer = undefined;
    nativeInspector.inspectorSessionDisconnect(this._nativeId);
    this._nativeId = 0;
    const error = inspectorError("Session was closed", "ERR_INSPECTOR_CLOSED");
    for (const callback of this._callbacks.values()) {
      if (typeof callback === "function") queueMicrotask(() => callback(error));
    }
    this._callbacks.clear();
  }
}

export function close() {
  nativeInspector.inspectorClose();
}

export function open(port = 9229, host = "127.0.0.1", wait = false) {
  if (url() !== undefined) {
    throw inspectorError("Inspector is already activated", "ERR_INSPECTOR_ALREADY_ACTIVATED");
  }
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort < 0 || numericPort > 65535) {
    throw new RangeError('The value of "port" is out of range. It must be >= 0 and <= 65535.');
  }
  if (host === undefined) host = "127.0.0.1";
  if (typeof host !== "string") throw new TypeError('The "host" argument must be of type string');
  try {
    nativeInspector.inspectorOpen(host, numericPort, randomInspectorPath(), false);
    if (wait) nativeInspector.inspectorWait();
  } catch (cause) {
    const error = inspectorError(cause?.message ?? "Inspector is not available", "ERR_INSPECTOR_NOT_AVAILABLE");
    error.cause = cause;
    throw error;
  }
}

export function url() {
  return nativeInspector.inspectorUrl();
}

export function waitForDebugger() {
  if (url() === undefined) {
    throw inspectorError("Inspector is not active", "ERR_INSPECTOR_NOT_ACTIVE");
  }
  nativeInspector.inspectorWait();
}

export const console = globalThis.console;

export const Network = {
  requestWillBeSent: (params = {}) => notification("Network.requestWillBeSent", params),
  responseReceived: (params = {}) => notification("Network.responseReceived", params),
  loadingFinished: (params = {}) => notification("Network.loadingFinished", params),
  loadingFailed: (params = {}) => notification("Network.loadingFailed", params),
  dataSent: (params = {}) => notification("Network.dataSent", params),
  dataReceived: (params = {}) => notification("Network.dataReceived", params),
  webSocketCreated: (params = {}) => notification("Network.webSocketCreated", params),
  webSocketClosed: (params = {}) => notification("Network.webSocketClosed", params),
  webSocketHandshakeResponseReceived: (params = {}) => notification("Network.webSocketHandshakeResponseReceived", params),
};

export const NetworkResources = {
  put(resource) {
    const id = String(resource?.requestId ?? resource?.id ?? nextResourceId++);
    networkResources.set(id, String(resource?.body ?? resource?.content ?? ""));
    return id;
  },
};

export default {
  Network,
  NetworkResources,
  Session,
  close,
  console,
  open,
  url,
  waitForDebugger,
};
