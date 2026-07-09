import EventEmitter from "./events.js";

const sessions = new Set();
const networkResources = new Map();
let nextResourceId = 1;

function inspectorCommandError(method) {
  const error = new Error(`Inspector error -32601: '${method}' wasn't found`);
  error.code = "ERR_INSPECTOR_COMMAND";
  return error;
}

function inactiveError() {
  const error = new Error("Inspector is not active");
  error.code = "ERR_INSPECTOR_NOT_ACTIVE";
  return error;
}

function inspectorServerError() {
  const error = new Error("Inspector server is not implemented in Cottontail yet");
  error.code = "ERR_INSPECTOR_NOT_AVAILABLE";
  return error;
}

function remoteObject(value) {
  if (value === null) return { type: "object", subtype: "null", value: null, description: "null" };
  const type = typeof value;
  if (type === "undefined") return { type: "undefined" };
  if (type === "number" || type === "boolean" || type === "string") return { type, value, description: String(value) };
  if (type === "bigint") return { type: "bigint", unserializableValue: `${value}n`, description: `${value}n` };
  if (type === "symbol") return { type: "symbol", description: String(value) };
  if (type === "function") return { type: "function", description: value.name ? `function ${value.name}()` : "function" };
  return {
    type: "object",
    className: value?.constructor?.name ?? "Object",
    description: value?.constructor?.name ?? "Object",
  };
}

function evaluateExpression(params = {}) {
  const expression = String(params.expression ?? "undefined");
  const evaluator = Function(`"use strict"; return (${expression});`);
  const value = evaluator.call(globalThis);
  return { result: remoteObject(value) };
}

function notification(method, params = {}) {
  for (const session of sessions) session.emit(method, { method, params });
}

function postResult(method, params = {}) {
  switch (method) {
    case "Runtime.evaluate":
      return evaluateExpression(params);
    case "Runtime.enable":
    case "Console.enable":
    case "HeapProfiler.enable":
    case "HeapProfiler.takeHeapSnapshot":
    case "Profiler.enable":
    case "Profiler.start":
    case "Profiler.stop":
      return {};
    case "Debugger.enable":
      return { debuggerId: "cottontail-jsc-debugger" };
    case "Network.enable":
      return {};
    case "Network.getResponseBody": {
      const id = params.requestId ?? params.id;
      const body = networkResources.get(id) ?? "";
      return { body, base64Encoded: false };
    }
    default:
      throw inspectorCommandError(method);
  }
}

export class Session extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
  }

  connect() {
    this.connected = true;
    sessions.add(this);
  }

  connectToMainThread() {
    this.connect();
  }

  post(method, params = undefined, callback = undefined) {
    if (typeof params === "function") {
      callback = params;
      params = undefined;
    }
    if (!this.connected) this.connect();
    queueMicrotask(() => {
      try {
        const result = postResult(String(method), params ?? {});
        if (typeof callback === "function") callback(null, result);
      } catch (error) {
        if (typeof callback === "function") callback(error);
        else this.emit("error", error);
      }
    });
  }

  disconnect() {
    this.connected = false;
    sessions.delete(this);
  }
}

export function close() {
  for (const session of [...sessions]) session.disconnect();
}

export function open() {
  throw inspectorServerError();
}

export function url() {
  return undefined;
}

export function waitForDebugger() {
  throw inactiveError();
}

export const console = {
  debug: (...args) => globalThis.console.debug(...args),
  error: (...args) => globalThis.console.error(...args),
  info: (...args) => globalThis.console.info(...args),
  log: (...args) => globalThis.console.log(...args),
  warn: (...args) => globalThis.console.warn(...args),
  dir: (...args) => globalThis.console.dir?.(...args),
  dirxml: (...args) => globalThis.console.log(...args),
  table: (...args) => globalThis.console.table?.(...args),
  trace: (...args) => globalThis.console.trace?.(...args),
  group: (...args) => globalThis.console.group?.(...args),
  groupCollapsed: (...args) => globalThis.console.groupCollapsed?.(...args),
  groupEnd: (...args) => globalThis.console.groupEnd?.(...args),
  clear: () => globalThis.console.clear?.(),
  count: (label) => globalThis.console.count?.(label),
  countReset: (label) => globalThis.console.countReset?.(label),
  assert: (value, ...args) => globalThis.console.assert?.(value, ...args),
  profile: () => {},
  profileEnd: () => {},
  time: (label) => globalThis.console.time?.(label),
  timeLog: (label, ...args) => globalThis.console.timeLog?.(label, ...args),
  timeEnd: (label) => globalThis.console.timeEnd?.(label),
  timeStamp: (label) => notification("Timeline.timeStamp", { label }),
  context: () => console,
};

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

// COTTONTAIL-COMPAT: node:inspector server - local Session protocol supports Runtime.evaluate and event delivery; DevTools WebSocket server/open(), debugger breakpoints, heap snapshots, and full domain coverage need JavaScriptCore inspector/runtime hooks.

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
