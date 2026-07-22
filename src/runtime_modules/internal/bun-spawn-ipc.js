import { deserializeJscValue, serializeJscValue } from "./jsc-value-serialization.js";

const ipcPrefix = "__COTTONTAIL_IPC__";
const advancedPrefix = "A:";
const jsonPrefix = "J:";
const advancedEnvelopeKey = "__cottontailBunSpawnIpcAdvanced";
const inheritedNodeIpcSymbol = Symbol.for("cottontail.inheritedNodeIpc");

function invalidIpcMessage(message) {
  if (message === undefined) {
    const error = new TypeError('The "message" argument must be specified');
    error.code = "ERR_MISSING_ARGS";
    return error;
  }
  const type = typeof message;
  const received = type === "bigint"
    ? `type bigint (${String(message)}n)`
    : `type ${type} (${String(message)})`;
  const error = new TypeError(
    'The "message" argument must be one of type string, object, number, or boolean. ' +
      `Received ${received}`,
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function validateBunIpcMessage(message) {
  if (message === undefined || typeof message === "bigint" || typeof message === "symbol") {
    throw invalidIpcMessage(message);
  }
}

function encodeAdvancedMessage(message) {
  try {
    return Buffer.from(serializeJscValue(message)).toString("base64");
  } catch (error) {
    if (!String(error?.message ?? error).includes("Unserializable value")) throw error;
    const cloneError = new Error("The object can not be cloned.");
    cloneError.name = "DataCloneError";
    throw cloneError;
  }
}

function decodeAdvancedEnvelope(message) {
  if (message == null || typeof message !== "object" || message[advancedEnvelopeKey] !== 1 ||
      typeof message.data !== "string") {
    return message;
  }
  return deserializeJscValue(Buffer.from(message.data, "base64"));
}

export function encodeBunSpawnIpc(message, nodeProtocol = false, serialization = undefined) {
  validateBunIpcMessage(message);
  const mode = serialization ?? (nodeProtocol ? "json" : "advanced");
  if (mode !== "json" && mode !== "advanced") {
    throw new TypeError('serialization must be "json" or "advanced"');
  }

  if (nodeProtocol) {
    // Node's JSON channel is newline-delimited without Cottontail framing.
    return `${JSON.stringify(message)}\n`;
  }
  if (mode === "advanced") {
    return `${ipcPrefix}${advancedPrefix}${encodeAdvancedMessage(message)}\n`;
  }
  return `${ipcPrefix}${jsonPrefix}${JSON.stringify(message)}\n`;
}

export function decodeBunSpawnIpc(line) {
  let text = String(line);
  if (text.startsWith(ipcPrefix)) text = text.slice(ipcPrefix.length);
  if (text.startsWith(advancedPrefix)) {
    return deserializeJscValue(Buffer.from(text.slice(advancedPrefix.length), "base64"));
  }
  if (text.startsWith(jsonPrefix)) text = text.slice(jsonPrefix.length);
  return decodeAdvancedEnvelope(JSON.parse(text));
}

export function isCottontailIpcFrame(line) {
  return String(line).startsWith(ipcPrefix);
}

// bun/ffi.js installs a process channel before user code runs, then invokes
// this codec once Buffer and the process bootstrap are ready. Keep the original
// fd reader as the sole reader while upgrading process.send and retaining
// legacy JSON-envelope decoding for children from older Cottontail builds.
export function installInheritedBunIpcCodec(host, processObject = globalThis.process) {
  if (processObject == null || processObject.env?.COTTONTAIL_IPC_BOOTSTRAP === "node") return false;
  const fd = Number(processObject.env?.COTTONTAIL_IPC_FD);
  if (!Number.isInteger(fd) || fd <= 2 || typeof host?.ipcSend !== "function" ||
      typeof processObject.emit !== "function") {
    return false;
  }
  if (processObject.send?.__cottontailAdvancedBunIpc === true) return true;

  const originalEmit = processObject.emit;
  processObject.emit = function emit(name, ...args) {
    if (name !== "message") return originalEmit.call(this, name, ...args);
    if (args.length > 0) args[0] = decodeAdvancedEnvelope(args[0]);
    const generation = (globalThis.__cottontailProcessIpcGeneration ?? 0) + 1;
    globalThis.__cottontailProcessIpcGeneration = generation;
    globalThis.__cottontailProcessIpcPending = true;
    const emitted = originalEmit.call(this, name, ...args);
    setTimeout(() => {
      if (globalThis.__cottontailProcessIpcGeneration === generation) {
        globalThis.__cottontailProcessIpcPending = false;
      }
    }, 0);
    return emitted;
  };

  const send = function send(message, sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) {
    validateNodeIpcMessage(message, arguments.length);
    if (typeof sendHandleOrCallback === "function") callback = sendHandleOrCallback;
    else if (typeof optionsOrCallback === "function") callback = optionsOrCallback;
    if (processObject.connected === false) {
      const error = new Error("Channel closed");
      error.code = "ERR_IPC_CHANNEL_CLOSED";
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else queueMicrotask(() => processObject.emit?.("error", error));
      return false;
    }

    let ok = false;
    try {
      ok = host.ipcSend(fd, encodeBunSpawnIpc(message)) === true;
    } catch (error) {
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else queueMicrotask(() => processObject.emit?.("error", error));
      return false;
    }
    if (typeof callback === "function") queueMicrotask(() => callback(ok ? null : new Error("write failed")));
    return ok;
  };
  Object.defineProperty(send, "__cottontailAdvancedBunIpc", { value: true });
  processObject.send = send;
  return true;
}

function validateNodeIpcMessage(message, argumentCount) {
  if (argumentCount === 0 || message === undefined) {
    const error = new TypeError('The "message" argument must be specified');
    error.code = "ERR_MISSING_ARGS";
    throw error;
  }
  const type = typeof message;
  if (message === null || type === "string" || type === "object" || type === "number" || type === "boolean") return;
  const error = new TypeError(
    'The "message" argument must be one of type string, object, number, or boolean.',
  );
  error.code = "ERR_INVALID_ARG_TYPE";
  throw error;
}

// Install child_process IPC during runtime initialization so process.send works
// without requiring node:child_process from the child entrypoint. Cottontail
// children use native framed IPC; external Node children use its JSON channel.
export function installInheritedNodeIpc(host, processObject = globalThis.process) {
  if (processObject == null || typeof processObject.send === "function") return false;
  const nativeFd = Number(processObject.env?.COTTONTAIL_IPC_FD);
  const nodeFd = Number(processObject.env?.NODE_CHANNEL_FD);
  const nativeProtocol = processObject.env?.COTTONTAIL_IPC_BOOTSTRAP === "node" &&
    Number.isInteger(nativeFd) && nativeFd > 2;
  const fd = nativeProtocol ? nativeFd : nodeFd;
  if (!Number.isInteger(fd) || fd <= 2 || typeof host?.ipcSend !== "function" || typeof host?.ipcRecv !== "function") {
    return false;
  }

  // COTTONTAIL-COMPAT: Node advanced IPC uses V8's binary ValueSerializer
  // framing. The inherited bridge remains JSON-compatible; the native process
  // hook must expose Node's binary framing for cross-runtime advanced mode.
  const serializationMode = nativeProtocol
    ? processObject.env?.COTTONTAIL_IPC_SERIALIZATION
    : processObject.env?.NODE_CHANNEL_SERIALIZATION_MODE;
  const serialization = serializationMode === "advanced" ? "advanced" : "json";
  let connected = true;
  let buffer = "";
  let timer = null;
  const wrappedMethods = [];
  const decoder = new TextDecoder();
  const channelEvents = new Set(["message", "disconnect", "internalMessage"]);

  const channel = {
    ref() {
      timer?.ref?.();
      return channel;
    },
    unref() {
      timer?.unref?.();
      return channel;
    },
  };

  const restoreProcessMethods = () => {
    for (const [name, original, wrapper] of wrappedMethods) {
      if (processObject[name] === wrapper) processObject[name] = original;
    }
    wrappedMethods.length = 0;
  };

  const close = (emitDisconnect = true, closeFd = true) => {
    if (!connected) return;
    connected = false;
    processObject.connected = false;
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    processObject.channel = null;
    processObject._channel = null;
    restoreProcessMethods();
    if (nativeProtocol) {
      try { delete processObject[inheritedNodeIpcSymbol]; } catch {}
    }
    if (closeFd) {
      try { host.closeFd?.(fd); } catch {}
    }
    if (emitDisconnect) processObject.emit?.("disconnect");
  };

  const poll = () => {
    if (!connected) return;
    try {
      for (;;) {
        const event = host.ipcRecv(fd, 64 * 1024);
        if (event == null) break;
        if (event.end) {
          close();
          return;
        }
        buffer += decoder.decode(event.data ?? new ArrayBuffer(0), { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") continue;
          // Node reserves NODE_* command objects for its internal channel.
          // Bun's public IPC callback receives ordinary payloads only.
          const message = decodeBunSpawnIpc(line);
          if (message?.cmd?.startsWith?.("NODE_")) processObject.emit?.("internalMessage", message);
          else processObject.emit?.("message", message);
          updateChannelRef();
        }
      }
    } catch (error) {
      processObject.emit?.("error", error);
    }
  };

  processObject.connected = true;
  processObject.channel = channel;
  processObject._channel = channel;
  processObject.send = function send(message, sendHandleOrCallback = undefined, optionsOrCallback = undefined, callback = undefined) {
    validateNodeIpcMessage(message, arguments.length);
    if (typeof sendHandleOrCallback === "function") callback = sendHandleOrCallback;
    else if (typeof optionsOrCallback === "function") callback = optionsOrCallback;
    if (!connected) {
      const error = new Error("Channel closed");
      error.code = "ERR_IPC_CHANNEL_CLOSED";
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else queueMicrotask(() => processObject.emit?.("error", error));
      return false;
    }
    let ok = false;
    try {
      // External Node advanced IPC requires V8's binary wire format. Native
      // Cottontail children use the stock-JSC structured value codec instead.
      ok = host.ipcSend(fd, encodeBunSpawnIpc(message, !nativeProtocol, serialization)) === true;
    } catch (error) {
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else queueMicrotask(() => processObject.emit?.("error", error));
      return false;
    }
    if (typeof callback === "function") queueMicrotask(() => callback(ok ? null : new Error("write failed")));
    return ok;
  };
  processObject.disconnect = () => close();

  timer = setInterval(poll, 1);
  channel.unref();
  const updateChannelRef = () => {
    let count = 0;
    for (const name of channelEvents) count += Number(processObject.listenerCount?.(name) ?? 0);
    if (count > 0) channel.ref();
    else channel.unref();
  };
  for (const methodName of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
    const original = processObject[methodName];
    if (typeof original !== "function") continue;
    const wrapper = function (name, ...args) {
      const result = original.call(this, name, ...args);
      if (channelEvents.has(name)) channel.ref();
      return result;
    };
    processObject[methodName] = wrapper;
    wrappedMethods.push([methodName, original, wrapper]);
  }
  for (const methodName of ["off", "removeListener", "removeAllListeners"]) {
    const original = processObject[methodName];
    if (typeof original !== "function") continue;
    const wrapper = function (name, ...args) {
      const result = original.call(this, name, ...args);
      if (name === undefined || channelEvents.has(name)) updateChannelRef();
      return result;
    };
    processObject[methodName] = wrapper;
    wrappedMethods.push([methodName, original, wrapper]);
  }

  if (nativeProtocol) {
    Object.defineProperty(processObject, inheritedNodeIpcSymbol, {
      value: {
        detach() {
          const pending = buffer;
          buffer = "";
          close(false, false);
          return { buffer: pending };
        },
      },
      configurable: true,
    });
  }

  // Match Node: these variables configure bootstrap and are not left in the
  // user-visible child environment after the channel is initialized.
  try { delete processObject.env.NODE_CHANNEL_FD; } catch {}
  try { delete processObject.env.NODE_CHANNEL_SERIALIZATION_MODE; } catch {}
  processObject.channel.serializationMode = serialization;
  return true;
}
