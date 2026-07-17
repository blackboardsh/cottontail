const validEncodings = new Set([
  "ascii",
  "base64",
  "base64url",
  "binary",
  "buffer",
  "hex",
  "latin1",
  "ucs2",
  "ucs-2",
  "utf8",
  "utf-8",
  "utf16le",
  "utf-16le",
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
  if (encoding == null) return encoding;
  if (typeof encoding !== "string") {
    throw invalidArgType("encoding", "of type string", encoding);
  }
  if (!validEncodings.has(encoding.toLowerCase())) {
    throw invalidArgValue("encoding", encoding);
  }
  return encoding;
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

// COTTONTAIL-COMPAT: Bun's native fs task checks the signal before dispatch
// and again when the task completes. Preserve that lifecycle and listener
// cleanup here; the host syscall itself is still synchronous.
export function runAbortable(operation, signal = null) {
  signal = validateAbortSignal(signal);
  if (signal?.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal?.addEventListener("abort", onAbort, { once: true });

    queueMicrotask(() => {
      if (settled) return;
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        const result = operation();
        Promise.resolve(result).then(
          value => finish(resolve, value),
          error => finish(reject, error),
        );
      } catch (error) {
        finish(reject, error);
      }
    });
  });
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
