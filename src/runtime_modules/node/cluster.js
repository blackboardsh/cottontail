import EventEmitter from "./events.js";
import { fork as forkChild } from "./child_process.js";

const emitter = new EventEmitter();
let nextWorkerId = 1;

export const SCHED_NONE = 1;
export const SCHED_RR = 2;
export let schedulingPolicy = SCHED_RR;
export const settings = {};
export const workers = {};
export const isPrimary = !globalThis.process?.env?.NODE_UNIQUE_ID;
export const isMaster = isPrimary;
export const isWorker = !isPrimary;
export const _events = emitter._events;
export const _eventsCount = 0;
export const _maxListeners = undefined;

export class Worker extends EventEmitter {
  constructor(id, processObject) {
    super();
    this.id = id;
    this.process = processObject;
    this.exitedAfterDisconnect = false;
    this.state = "online";
    processObject.on?.("message", (message) => this.emit("message", message));
    processObject.on?.("error", (error) => this.emit("error", error));
    processObject.on?.("exit", (code, signal) => {
      this.state = "dead";
      delete workers[this.id];
      this.emit("exit", code, signal);
      emitter.emit("exit", this, code, signal);
    });
    processObject.on?.("close", (code, signal) => {
      this.state = "dead";
      this.emit("disconnect");
      emitter.emit("disconnect", this);
      this.emit("close", code, signal);
    });
    queueMicrotask(() => {
      this.emit("online");
      emitter.emit("online", this);
    });
  }

  send(message, sendHandle = undefined, options = undefined, callback = undefined) {
    if (typeof sendHandle === "function") {
      callback = sendHandle;
      sendHandle = undefined;
      options = undefined;
    } else if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    return this.process.send?.(message, sendHandle, options, callback) ?? false;
  }

  disconnect() {
    this.exitedAfterDisconnect = true;
    this.process.disconnect?.();
    return this;
  }

  destroy(signal = "SIGTERM") {
    this.exitedAfterDisconnect = true;
    this.process.kill?.(signal);
  }

  kill(signal = "SIGTERM") {
    return this.process.kill?.(signal);
  }

  isConnected() {
    return this.process.connected !== false;
  }

  isDead() {
    return this.state === "dead" || this.process.exitCode != null;
  }
}

export function setupPrimary(options = {}) {
  Object.assign(settings, options ?? {});
  if (settings.schedulingPolicy != null) schedulingPolicy = Number(settings.schedulingPolicy);
  return settings;
}

export const setupMaster = setupPrimary;

export function fork(env = {}) {
  if (!isPrimary) throw new Error("cluster.fork can only be called from the primary process");
  const id = nextWorkerId++;
  const exec = settings.exec ?? globalThis.process?.argv?.[1];
  if (!exec) throw new Error("cluster.setupPrimary({ exec }) is required when process.argv[1] is unavailable");
  const args = Array.from(settings.args ?? [], String);
  const child = forkChild(exec, args, {
    ...settings,
    env: {
      ...(globalThis.process?.env ?? {}),
      ...(settings.env ?? {}),
      ...(env ?? {}),
      NODE_UNIQUE_ID: String(id),
    },
    silent: settings.silent ?? true,
  });
  const worker = new Worker(id, child);
  workers[id] = worker;
  emitter.emit("fork", worker);
  return worker;
}

export function disconnect(callback = undefined) {
  const list = Object.values(workers);
  if (list.length === 0) {
    callback?.();
    return;
  }
  let remaining = list.length;
  for (const worker of list) {
    worker.once("disconnect", () => {
      remaining -= 1;
      if (remaining === 0) callback?.();
    });
    worker.disconnect();
  }
}

const cluster = Object.assign(emitter, {
  SCHED_NONE,
  SCHED_RR,
  Worker,
  _events,
  _eventsCount,
  _maxListeners,
  disconnect,
  fork,
  get isMaster() { return isMaster; },
  get isPrimary() { return isPrimary; },
  get isWorker() { return isWorker; },
  get schedulingPolicy() { return schedulingPolicy; },
  set schedulingPolicy(value) { schedulingPolicy = Number(value); },
  settings,
  setupMaster,
  setupPrimary,
  workers,
});

// COTTONTAIL-COMPAT: node:cluster scheduling - process fork/message lifecycle and POSIX shared socket/server handles are implemented; primary-managed round-robin distribution still needs a cluster scheduler.

export default cluster;
