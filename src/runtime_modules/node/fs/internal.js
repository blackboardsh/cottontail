const canonicalEncodings = new Map([
  ["ascii", "ascii"],
  ["base64", "base64"],
  ["base64url", "base64url"],
  ["binary", "latin1"],
  ["buffer", "buffer"],
  ["hex", "hex"],
  ["latin1", "latin1"],
  ["ucs2", "utf16le"],
  ["ucs-2", "utf16le"],
  ["utf8", "utf8"],
  ["utf-8", "utf8"],
  ["utf16le", "utf16le"],
  ["utf16-le", "utf16le"],
]);

function describeReceived(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `type string ('${value}')`;
  if (typeof value === "object") return `an instance of ${value.constructor?.name ?? "Object"}`;
  return `type ${typeof value} (${String(value)})`;
}

export function invalidArgType(name, expected, value) {
  const error = new TypeError(
    `The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

export function invalidArgValue(name, value, reason = "is invalid") {
  const error = new TypeError(`The argument '${name}' ${reason}. Received '${String(value)}'`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

export function outOfRange(name, range, value) {
  const error = new RangeError(
    `The value of "${name}" is out of range. It must be ${range}. Received ${String(value)}`,
  );
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

export function encodingFromOptions(options, fallback = undefined) {
  const encoding = typeof options === "string"
    ? options
    : options && typeof options === "object" && options.encoding != null
      ? options.encoding
      : fallback;
  if (!encoding) return fallback;
  const normalized = typeof encoding === "string" ? canonicalEncodings.get(encoding.toLowerCase()) : undefined;
  if (normalized === undefined) {
    const error = new TypeError(`encoding '${String(encoding)}' is an invalid encoding`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  return normalized;
}

export function allocationLimitForEncoding(encoding) {
  const configured = Number(globalThis.__cottontailSyntheticAllocationLimit);
  if (!Number.isFinite(configured) || configured <= 0) return Number.MAX_SAFE_INTEGER;
  const normalized = String(encoding ?? "buffer").toLowerCase();
  if (normalized === "hex") return configured * 2;
  if (normalized === "base64" || normalized === "base64url") return configured * 3;
  if (
    normalized === "utf8" || normalized === "utf-8" ||
    normalized === "ucs2" || normalized === "ucs-2" ||
    normalized === "utf16le" || normalized === "utf-16le"
  ) {
    return configured * 4;
  }
  return configured;
}

export function validateAbortSignal(signal, name = "options.signal") {
  if (signal == null) return null;
  if (
    typeof signal !== "object" ||
    typeof signal.aborted !== "boolean" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    throw invalidArgType(name, "an instance of AbortSignal", signal);
  }
  return signal;
}

export function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

const abortableTasks = new WeakMap();
let pendingAbortableTasks = [];
let abortableTaskDrainScheduled = false;

class FSReqPromise {}

function registerActiveRequest(request) {
  globalThis.cottontail?.activeRequestRegister?.(request);
  return request;
}

function unregisterActiveRequest(request) {
  if (request != null) globalThis.cottontail?.activeRequestUnregister?.(request);
}

function scheduleAbortableTurn(callback) {
  const nextTick = globalThis.process?.nextTick;
  if (typeof nextTick === "function") nextTick(callback);
  else queueMicrotask(callback);
}

function drainAbortableTasks() {
  abortableTaskDrainScheduled = false;
  const tasks = pendingAbortableTasks;
  pendingAbortableTasks = [];
  for (const task of tasks) runAbortableTask(task);
}

function armAbortableTaskDrain() {
  scheduleAbortableTurn(drainAbortableTasks);
}

function queueAbortableTask(task) {
  pendingAbortableTasks.push(task);
  if (abortableTaskDrainScheduled) return;
  abortableTaskDrainScheduled = true;
  // COTTONTAIL-COMPAT: process.nextTick callbacks drain JSC jobs before they
  // return. Two queue stages let a next-tick abort run before fs settlement
  // without resuming the caller inside the abort callback's async frame.
  scheduleAbortableTurn(armAbortableTaskDrain);
}

function finishAbortableTask(task, callback, value) {
  if (task.settled) return;
  task.settled = true;

  const signal = task.signal;
  const tasks = signal && abortableTasks.get(signal);
  if (tasks) {
    tasks.delete(task);
    if (tasks.size === 0) {
      abortableTasks.delete(signal);
      signal.removeEventListener("abort", onAbortableSignalAbort);
    }
  }

  task.signal = null;
  task.operation = null;
  task.resolve = null;
  task.reject = null;
  unregisterActiveRequest(task.activeRequest);
  task.activeRequest = null;
  callback(value);
}

function onAbortableSignalAbort(event) {
  const signal = event?.currentTarget ?? event?.target ?? this;
  const tasks = abortableTasks.get(signal);
  if (!tasks) return;
  const reason = abortReason(signal);
  for (const task of tasks) {
    task.aborted = true;
    task.abortedWith = reason;
  }
}

function runAbortableTask(task) {
  if (task.settled) return;
  const signal = task.signal;
  if (task.aborted || signal?.aborted) {
    finishAbortableTask(task, task.reject, task.aborted ? task.abortedWith : abortReason(signal));
    return;
  }
  try {
    finishAbortableTask(task, task.resolve, task.operation());
  } catch (error) {
    finishAbortableTask(task, task.reject, error);
  }
}

// COTTONTAIL-COMPAT: Bun's native fs task checks the signal before dispatch
// and again when the task completes. The host syscall is synchronous, so task
// records and one shared listener avoid retaining a closure graph per request.
export function runAbortable(operation, signal = null, activeRequest = undefined) {
  signal = validateAbortSignal(signal);
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  const request = registerActiveRequest(activeRequest ?? new FSReqPromise());
  if (signal == null) {
    return Promise.resolve().then(() => {
      try {
        return operation();
      } finally {
        unregisterActiveRequest(request);
      }
    });
  }

  const deferred = Promise.withResolvers();
  const task = {
    activeRequest: request,
    aborted: false,
    abortedWith: undefined,
    operation,
    reject: deferred.reject,
    resolve: deferred.resolve,
    settled: false,
    signal,
  };

  if (signal) {
    let tasks = abortableTasks.get(signal);
    if (!tasks) {
      tasks = new Set();
      abortableTasks.set(signal, tasks);
      signal.addEventListener("abort", onAbortableSignalAbort, { once: true });
    }
    tasks.add(task);
  }

  queueAbortableTask(task);
  return deferred.promise;
}

export function validateInteger(value, name, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "number") throw invalidArgType(name, "of type number", value);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw outOfRange(name, `>= ${minimum} and <= ${maximum}`, value);
  }
  return value;
}

export function validateFd(fd) {
  return validateInteger(fd, "fd", 0, 0x7fffffff);
}

export function validatePosition(position, name = "position") {
  if (position == null) return null;
  if (typeof position === "bigint") {
    if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw outOfRange(name, `>= 0 and <= ${Number.MAX_SAFE_INTEGER}`, position);
    }
    return Number(position);
  }
  return validateInteger(position, name, 0, Number.MAX_SAFE_INTEGER);
}

export function validateBufferRange(buffer, offset = 0, length = undefined) {
  if (!ArrayBuffer.isView(buffer)) {
    throw invalidArgType("buffer", "an instance of Buffer, TypedArray, or DataView", buffer);
  }
  offset = validateInteger(offset ?? 0, "offset", 0, buffer.byteLength);
  length = length == null ? buffer.byteLength - offset : validateInteger(length, "length", 0, buffer.byteLength);
  if (offset + length > buffer.byteLength) {
    throw outOfRange("length", `<= ${buffer.byteLength - offset}`, length);
  }
  return { buffer, offset, length };
}
