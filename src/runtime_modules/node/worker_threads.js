import { EventEmitter } from "./events.js";
import { resolve } from "./path.js";
import { Readable, Writable } from "./stream.js";
import "../bun/ffi.js";

const environmentData = new Map();
const markedUntransferable = new WeakSet();
const markedUncloneable = new WeakSet();
const workerInstances = new Map();
const broadcastChannels = new Map();
let nextPortId = 1;

export const SHARE_ENV = Symbol.for("nodejs.worker_threads.SHARE_ENV");
export const isMainThread = !cottontail.isWorker?.();
export const isInternalThread = false;
export const threadId = isMainThread ? 0 : 1;
export const threadName = isMainThread ? "" : "worker";
export const workerData = isMainThread ? null : globalThis.__cottontailWorkerData ?? null;
export const resourceLimits = {};

function serializeForWrapper(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === "bigint") return item.toString();
    if (typeof item === "function" || typeof item === "symbol") return undefined;
    return item;
  });
}

function normalizeWorkerPath(filename, evalMode = false) {
  if (evalMode) {
    const dir = `${cottontail.cwd()}/.cottontail-tmp`;
    cottontail.mkdirSync?.(dir, true);
    const sourcePath = `${dir}/worker-eval-${Date.now()}-${Math.floor(Math.random() * 1000000)}.js`;
    cottontail.writeFile(sourcePath, String(filename));
    return sourcePath;
  }
  const text = String(filename);
  if (text.startsWith("file://")) return decodeURIComponent(new URL(text).pathname);
  if (text.startsWith("data:")) throw new Error("data: workers are not supported by Cottontail worker_threads yet");
  return resolve(text);
}

function makeWorkerWrapper(targetPath, options = {}) {
  const dir = `${cottontail.cwd()}/.cottontail-tmp`;
  cottontail.mkdirSync?.(dir, true);
  const wrapperPath = `${dir}/worker-thread-${Date.now()}-${Math.floor(Math.random() * 1000000)}.js`;
  const targetUrl = `file://${targetPath}`;
  const workerDataJson = serializeForWrapper(options.workerData ?? null);
  const source = [
    `globalThis.__cottontailWorkerData = ${workerDataJson};`,
    `globalThis.__cottontailWorkerThreadName = ${JSON.stringify(options.name ?? "")};`,
    `globalThis.workerData = globalThis.__cottontailWorkerData;`,
    `globalThis.parentPort = {`,
    `  on(name, handler) { if (String(name) === "message") globalThis.addEventListener("message", (event) => handler(event.data)); return this; },`,
    `  once(name, handler) { const wrapped = (value) => { handler(value); }; return this.on(name, wrapped); },`,
    `  off() { return this; },`,
    `  postMessage(value) { globalThis.postMessage(value); },`,
    `  close() {}, ref() { return this; }, unref() { return this; }`,
    `};`,
    `await import(${JSON.stringify(targetUrl)});`,
  ].join("\n");
  cottontail.writeFile(wrapperPath, source);
  return wrapperPath;
}

class NullWritable extends Writable {
  write(_chunk, encoding = undefined, callback = undefined) {
    if (typeof encoding === "function") callback = encoding;
    callback?.();
    return true;
  }
}

export class Worker extends EventEmitter {
  constructor(filename, options = {}) {
    super();
    const target = normalizeWorkerPath(filename, options.eval === true);
    const wrapper = makeWorkerWrapper(target, options);
    this.threadId = 0;
    this.threadName = options.name ?? "";
    this.resourceLimits = { ...(options.resourceLimits ?? {}) };
    this.stdin = options.stdin ? new NullWritable() : null;
    this.stdout = new Readable();
    this.stderr = new Readable();
    this._worker = new globalThis.Worker(wrapper);
    this.threadId = this._worker.id ?? this._worker.handle?.id ?? 0;
    workerInstances.set(this.threadId, this);
    this._worker.onmessage = (event) => this.emit("message", event.data);
    this._worker.onerror = (event) => this.emit("error", event?.error ?? new Error(String(event?.message ?? event)));
    queueMicrotask(() => this.emit("online"));
  }

  postMessage(value, transferList = undefined) {
    void transferList;
    this._worker.postMessage(value);
  }

  terminate() {
    this._worker.terminate();
    workerInstances.delete(this.threadId);
    this.emit("exit", 0);
    return Promise.resolve(0);
  }

  ref() { return this; }
  unref() { return this; }

  getHeapStatistics() {
    return Promise.resolve(globalThis.process?.memoryUsage?.() ?? {});
  }

  getHeapSnapshot() {
    return Promise.resolve(Readable.from(["{}"]));
  }

  cpuUsage() {
    return Promise.resolve(globalThis.process?.cpuUsage?.() ?? { user: 0, system: 0 });
  }

  startCpuProfile() {
    return Promise.resolve({ stop: () => Promise.resolve({}) });
  }

  startHeapProfile() {
    return Promise.resolve({ stop: () => Promise.resolve({}) });
  }
}

export class MessagePort extends EventEmitter {
  constructor() {
    super();
    this._id = nextPortId++;
    this._queue = [];
    this._closed = false;
    this._started = false;
    this._peer = null;
    this.onmessage = null;
    this.onmessageerror = null;
    this._ref = true;
  }

  postMessage(value, transferList = undefined) {
    void transferList;
    if (this._closed || !this._peer || this._peer._closed) return;
    this._peer._queue.push(value);
    this._peer._dispatch();
  }

  start() {
    this._started = true;
    this._dispatch();
  }

  close() {
    this._closed = true;
    this.emit("close");
  }

  ref() { this._ref = true; return this; }
  unref() { this._ref = false; return this; }
  hasRef() { return this._ref; }

  _dispatch() {
    if (!this._started && typeof this.onmessage !== "function" && this.listenerCount("message") === 0) return;
    while (this._queue.length > 0) {
      const value = this._queue.shift();
      const event = { data: value };
      if (typeof this.onmessage === "function") this.onmessage(event);
      this.emit("message", value);
    }
  }
}

export class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}

export class BroadcastChannel extends EventEmitter {
  constructor(name) {
    super();
    this.name = String(name);
    this.onmessage = null;
    this.onmessageerror = null;
    this._closed = false;
    const channels = broadcastChannels.get(this.name) ?? new Set();
    channels.add(this);
    broadcastChannels.set(this.name, channels);
  }

  postMessage(value) {
    for (const channel of broadcastChannels.get(this.name) ?? []) {
      if (channel === this || channel._closed) continue;
      queueMicrotask(() => {
        const event = { data: value };
        channel.onmessage?.(event);
        channel.emit("message", event);
      });
    }
  }

  close() {
    this._closed = true;
    broadcastChannels.get(this.name)?.delete(this);
  }

  ref() { return this; }
  unref() { return this; }
}

export const parentPort = isMainThread ? null : new class ParentPort extends EventEmitter {
  constructor() {
    super();
    globalThis.addEventListener?.("message", (event) => this.emit("message", event.data));
  }

  postMessage(value) {
    globalThis.postMessage?.(value);
  }

  close() {}
  ref() { return this; }
  unref() { return this; }
}();

if (!isMainThread) {
  globalThis.parentPort ??= parentPort;
  globalThis.workerData ??= workerData;
}

export function setEnvironmentData(key, value) {
  environmentData.set(key, value);
}

export function getEnvironmentData(key) {
  return environmentData.get(key);
}

export function markAsUntransferable(object) {
  if (object && typeof object === "object") markedUntransferable.add(object);
}

export function isMarkedAsUntransferable(object) {
  return Boolean(object && typeof object === "object" && markedUntransferable.has(object));
}

export function markAsUncloneable(object) {
  if (object && typeof object === "object") markedUncloneable.add(object);
}

export function moveMessagePortToContext(port, contextifiedSandbox) {
  void contextifiedSandbox;
  return port;
}

export function receiveMessageOnPort(port) {
  if (!port?._queue || port._queue.length === 0) return undefined;
  return { message: port._queue.shift() };
}

export function postMessageToThread(targetThreadId, value, transferList = undefined, timeout = undefined) {
  void transferList;
  void timeout;
  const worker = workerInstances.get(Number(targetThreadId));
  if (!worker) return Promise.resolve(false);
  worker.postMessage(value);
  return Promise.resolve(true);
}

export const locks = {
  async request(name, options = {}, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = {};
    }
    const lock = { name: String(name), mode: options.mode ?? "exclusive" };
    return callback ? callback(lock) : undefined;
  },
  async query() {
    return { held: [], pending: [] };
  },
};

// COTTONTAIL-COMPAT: node:worker_threads - Worker/message transport uses Cottontail native workers; transferable objects, shared memory, and per-thread inspector/resource accounting need deeper runtime support.

export default {
  BroadcastChannel,
  MessageChannel,
  MessagePort,
  SHARE_ENV,
  Worker,
  getEnvironmentData,
  isInternalThread,
  isMainThread,
  isMarkedAsUntransferable,
  locks,
  markAsUncloneable,
  markAsUntransferable,
  moveMessagePortToContext,
  parentPort,
  postMessageToThread,
  receiveMessageOnPort,
  resourceLimits,
  setEnvironmentData,
  threadId,
  threadName,
  workerData,
};
