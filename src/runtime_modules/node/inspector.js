import EventEmitter from "./events.js";

const sessions = new Set();
const networkResources = new Map();
let nextResourceId = 1;

function inspectorError(message, code = "ERR_INSPECTOR_COMMAND") {
  const error = new Error(message);
  error.code = code;
  return error;
}

function unsupportedMethodError(method) {
  const message = method.startsWith("Profiler.") && method.includes("Coverage")
    ? "Coverage APIs are not supported"
    : `Inspector method ${JSON.stringify(method)} is not supported`;
  return inspectorError(message);
}

function notImplementedError() {
  const error = new Error(
    "node:inspector is not yet implemented in Bun. Track the status & thumbs up the issue: " +
    "https://github.com/oven-sh/bun/issues/2445",
  );
  error.code = "ERR_NOT_IMPLEMENTED";
  return error;
}

function notification(method, params = {}) {
  for (const session of sessions) session.emit(method, { method, params });
}

function profileResult(startTime) {
  const endTime = performance.now() * 1000;
  return {
    profile: {
      nodes: [{
        id: 1,
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
        hitCount: 0,
        children: [],
      }],
      startTime,
      endTime: Math.max(startTime, endTime),
      samples: [],
      timeDeltas: [],
    },
  };
}

function postResult(session, method, params = {}) {
  switch (method) {
    case "Profiler.enable":
      session.profilerEnabled = true;
      return {};
    case "Profiler.disable":
      session.profilerEnabled = false;
      session.profilerRunning = false;
      return {};
    case "Profiler.start":
      if (!session.profilerEnabled) {
        throw inspectorError("Profiler is not enabled. Call Profiler.enable first.");
      }
      if (!session.profilerRunning) {
        session.profilerRunning = true;
        session.profilerStartedAt = performance.now() * 1000;
      }
      return {};
    case "Profiler.stop":
      if (!session.profilerRunning) {
        throw inspectorError("Profiler is not started. Call Profiler.start first.");
      }
      session.profilerRunning = false;
      return profileResult(session.profilerStartedAt);
    case "Profiler.setSamplingInterval": {
      if (session.profilerRunning) {
        throw inspectorError("Cannot change sampling interval while profiler is running");
      }
      const interval = Number(params.interval);
      if (!Number.isFinite(interval) || interval <= 0) {
        throw inspectorError("Sampling interval must be a positive number");
      }
      session.samplingInterval = interval;
      return {};
    }
    default:
      throw unsupportedMethodError(method);
  }
}

export class Session extends EventEmitter {
  constructor() {
    super();
    this.connected = false;
    this.profilerEnabled = false;
    this.profilerRunning = false;
    this.profilerStartedAt = 0;
    this.samplingInterval = 1000;
  }

  connect() {
    if (this.connected) throw inspectorError("Session is already connected");
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
    const run = () => {
      if (!this.connected) throw inspectorError("Session is not connected");
      return postResult(this, String(method), params ?? {});
    };
    if (typeof callback !== "function") return run();
    queueMicrotask(() => {
      let result;
      try { result = run(); } catch (error) { callback(error); return; }
      callback(null, result);
    });
    return undefined;
  }

  disconnect() {
    if (!this.connected) return;
    this.connected = false;
    this.profilerEnabled = false;
    this.profilerRunning = false;
    sessions.delete(this);
  }
}

export function close() {
  throw notImplementedError();
}

export function open() {
  throw notImplementedError();
}

export function url() {
  return undefined;
}

export function waitForDebugger() {
  throw notImplementedError();
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

// COTTONTAIL-COMPAT: node:inspector server - Session implements Bun's local
// profiler contract. DevTools transport and other protocol domains still need
// JavaScriptCore inspector hooks.

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
