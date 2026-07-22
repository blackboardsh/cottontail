import { deserializeJscValue, serializeJscValue } from "./jsc-value-serialization.js";

const ipcPrefix = "__COTTONTAIL_IPC__";
const advancedPrefix = "A:";
const jsonPrefix = "J:";
const advancedEnvelopeKey = "__cottontailBunSpawnIpcAdvanced";
const nodeIpcEnvelopeKey = "__cottontailIpcEnvelope";
const inheritedNodeIpcSymbol = Symbol.for("cottontail.inheritedNodeIpc");

function nodeNetConstructors() {
  const runtimeRequire = globalThis.__ctMetaRequire ?? globalThis.require;
  if (typeof runtimeRequire !== "function") return {};
  try {
    return runtimeRequire("node:net") ?? {};
  } catch {
    return {};
  }
}

export function bunSpawnIpcHandleInfo(handle = undefined) {
  if (handle == null) return null;
  const { Server: NetServer, Socket: NetSocket } = nodeNetConstructors();
  const isSocket = typeof NetSocket === "function" && handle instanceof NetSocket;
  const isServer = typeof NetServer === "function" && handle instanceof NetServer;
  if (Number.isInteger(handle) && handle >= 0) return { fd: Number(handle), type: "net.Handle" };
  if (Number.isInteger(handle.fd) && handle.fd >= 0) {
    return {
      fd: Number(handle.fd),
      type: isSocket ? "net.Socket" : "net.Handle",
    };
  }
  if (Number.isInteger(handle._fd) && handle._fd >= 0) {
    return {
      fd: Number(handle._fd),
      type: isServer ? "net.Server" : "net.Handle",
    };
  }
  if (Number.isInteger(handle._handle?.fd) && handle._handle.fd >= 0) {
    return {
      fd: Number(handle._handle.fd),
      type: isServer ? "net.Server" : isSocket ? "net.Socket" : "net.Handle",
    };
  }
  return null;
}

export function adoptBunSpawnIpcHandle(host, fd = undefined, type = "net.Socket") {
  if (!Number.isInteger(fd) || fd < 0) return undefined;
  try {
    const { Server: NetServer, Socket: NetSocket } = nodeNetConstructors();
    if (type === "net.Server" && typeof NetServer === "function" && typeof NetServer._fromFd === "function") {
      return NetServer._fromFd(fd);
    }
    if (type === "net.Handle") {
      let open = true;
      return {
        fd,
        close(callback = undefined) {
          if (open) {
            open = false;
            try { host.closeFd?.(fd); } catch {}
          }
          if (typeof callback === "function") queueMicrotask(callback);
        },
        ref() { return this; },
        unref() { return this; },
      };
    }
    let local;
    let remote;
    try { local = host.tcpSocketAddress?.(fd, false); } catch {}
    try { remote = host.tcpSocketAddress?.(fd, true); } catch {}
    if (typeof NetSocket !== "function") throw new Error("node:net is unavailable");
    return new NetSocket({
      fd,
      local,
      remote,
      pipe: local?.path != null || remote?.path != null,
      path: local?.path ?? remote?.path,
    });
  } catch {
    try { host.closeFd?.(fd); } catch {}
    return undefined;
  }
}

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
  if (!Number.isInteger(fd) || fd < 0 || typeof host?.ipcSend !== "function" ||
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
    let sendHandle = sendHandleOrCallback;
    let options = optionsOrCallback;
    if (typeof sendHandleOrCallback === "function") {
      callback = sendHandleOrCallback;
      sendHandle = undefined;
      options = undefined;
    } else if (typeof optionsOrCallback === "function") {
      callback = optionsOrCallback;
      options = undefined;
    } else if (options !== undefined && (options === null || typeof options !== "object")) {
      const error = new TypeError('The "options" argument must be of type object.');
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    if (processObject.connected === false) {
      const error = new Error("Channel closed");
      error.code = "ERR_IPC_CHANNEL_CLOSED";
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else queueMicrotask(() => processObject.emit?.("error", error));
      return false;
    }

    let ok = false;
    try {
      const handleInfo = bunSpawnIpcHandleInfo(sendHandle);
      if (sendHandle != null && handleInfo == null) throw invalidIpcHandle();
      ok = host.ipcSend(fd, encodeBunSpawnIpc(message), handleInfo?.fd ?? -1) === true;
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

function invalidIpcHandle() {
  const error = new TypeError("This handle type cannot be sent");
  error.code = "ERR_INVALID_HANDLE_TYPE";
  return error;
}

function decodeInheritedNodeIpcFrame(host, message, receivedFd, adoptedHandles) {
  if (message && typeof message === "object" && message[nodeIpcEnvelopeKey] === 1) {
    const handle = adoptBunSpawnIpcHandle(host, receivedFd, message.handleType);
    if (message.handleSeq != null && handle != null) {
      adoptedHandles.set(message.handleSeq, handle);
      if (adoptedHandles.size > 32) adoptedHandles.delete(adoptedHandles.keys().next().value);
    }
    return { message: message.message, handle };
  }
  if (message && typeof message === "object" && message[nodeIpcEnvelopeKey] === 3) {
    if (Number.isInteger(receivedFd) && receivedFd >= 0) {
      try { host.closeFd?.(receivedFd); } catch {}
    }
    const socket = adoptedHandles.get(message.handleSeq);
    adoptedHandles.delete(message.handleSeq);
    if (socket != null && message.data) {
      const bytes = Buffer.from(String(message.data), "base64");
      if (bytes.length > 0) {
        queueMicrotask(() => {
          try {
            const chunk = socket._encoding ? bytes.toString(socket._encoding) : bytes;
            if (typeof socket._emitData === "function") socket._emitData(chunk);
            else socket.emit?.("data", chunk);
          } catch {}
        });
      }
    }
    return null;
  }
  return {
    message,
    handle: adoptBunSpawnIpcHandle(host, receivedFd),
  };
}

function writeInheritedNodeIpc(host, fd, message, serialization, sendHandle, options, finish) {
  const handleInfo = bunSpawnIpcHandleInfo(sendHandle);
  if (sendHandle != null && handleInfo == null) throw invalidIpcHandle();
  const handleSeq = handleInfo == null
    ? undefined
    : (globalThis.__cottontailIpcHandleSequence = (globalThis.__cottontailIpcHandleSequence ?? 0) + 1);
  const payload = handleInfo == null
    ? message
    : {
        [nodeIpcEnvelopeKey]: 1,
        message,
        handleType: handleInfo.type,
        handleSeq,
      };
  if (handleInfo != null) {
    try { sendHandle?.pause?.(); } catch {}
  }
  const ok = host.ipcSend(
    fd,
    encodeBunSpawnIpc(payload, false, serialization),
    handleInfo?.fd ?? -1,
  ) === true;
  const complete = () => finish?.(ok ? null : new Error("write failed"));
  if (handleInfo == null || !ok) {
    queueMicrotask(complete);
    return ok;
  }
  setTimeout(() => {
    try {
      const pending = Array.isArray(sendHandle?._pendingData) ? sendHandle._pendingData.splice(0) : [];
      try { sendHandle?._stopRead?.(); } catch {}
      if (pending.length > 0) {
        const data = Buffer.concat(pending.map(chunk => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("base64");
        host.ipcSend(
          fd,
          encodeBunSpawnIpc({ [nodeIpcEnvelopeKey]: 3, handleSeq, data }, false, "json"),
          -1,
        );
      }
      if (sendHandle instanceof NetSocket) {
        if (options?.keepOpen === true) sendHandle.resume?.();
        else sendHandle.destroy?.();
      }
    } catch {}
    complete();
  }, 5);
  return ok;
}

// Install child_process IPC during runtime initialization so process.send works
// without requiring node:child_process from the child entrypoint. Cottontail
// children use native framed IPC; external Node children use its JSON channel.
export function installInheritedNodeIpc(host, processObject = globalThis.process) {
  if (processObject == null || typeof processObject.send === "function") return false;
  const nativeFd = Number(processObject.env?.COTTONTAIL_IPC_FD);
  const nodeFd = Number(processObject.env?.NODE_CHANNEL_FD);
  const nativeProtocol = processObject.env?.COTTONTAIL_IPC_BOOTSTRAP === "node" &&
    Number.isInteger(nativeFd) && nativeFd >= 0;
  const fd = nativeProtocol ? nativeFd : nodeFd;
  if (!Number.isInteger(fd) || fd < 0 || typeof host?.ipcSend !== "function" || typeof host?.ipcRecv !== "function") {
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
  let pendingFd;
  let timer = null;
  const wrappedMethods = [];
  const decoder = new TextDecoder();
  const adoptedHandles = new Map();
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
    if (Number.isInteger(pendingFd) && pendingFd >= 0) {
      try { host.closeFd?.(pendingFd); } catch {}
      pendingFd = undefined;
    }
    if (closeFd) {
      try { host.closeFd?.(fd); } catch {}
    }
    if (emitDisconnect) queueMicrotask(() => processObject.emit?.("disconnect"));
  };

  const poll = () => {
    if (!connected) return;
    try {
      for (;;) {
        const event = host.ipcRecv(fd, 64 * 1024);
        if (event == null) break;
        if (event.end) {
          if (Number.isInteger(event.fd) && event.fd >= 0) {
            try { host.closeFd?.(event.fd); } catch {}
          }
          close();
          return;
        }
        if (Number.isInteger(event.fd) && event.fd >= 0) {
          if (Number.isInteger(pendingFd) && pendingFd >= 0) {
            try { host.closeFd?.(pendingFd); } catch {}
          }
          pendingFd = Number(event.fd);
        }
        buffer += decoder.decode(event.data ?? new ArrayBuffer(0), { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (line === "") continue;
          const frameFd = pendingFd;
          pendingFd = undefined;
          // Node reserves NODE_* command objects for its internal channel.
          // Bun's public IPC callback receives ordinary payloads only.
          let frame;
          try {
            frame = decodeInheritedNodeIpcFrame(host, decodeBunSpawnIpc(line), frameFd, adoptedHandles);
          } catch (error) {
            if (Number.isInteger(frameFd) && frameFd >= 0) {
              try { host.closeFd?.(frameFd); } catch {}
            }
            throw error;
          }
          if (frame == null) continue;
          if (frame.message?.cmd?.startsWith?.("NODE_")) {
            processObject.emit?.("internalMessage", frame.message, frame.handle);
          } else {
            processObject.emit?.("message", frame.message, frame.handle);
          }
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
    let sendHandle = sendHandleOrCallback;
    let options = optionsOrCallback;
    if (typeof sendHandleOrCallback === "function") {
      callback = sendHandleOrCallback;
      sendHandle = undefined;
      options = undefined;
    } else if (typeof optionsOrCallback === "function") {
      callback = optionsOrCallback;
      options = undefined;
    } else if (options !== undefined && (options === null || typeof options !== "object")) {
      const error = new TypeError('The "options" argument must be of type object.');
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
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
      if (nativeProtocol) {
        ok = writeInheritedNodeIpc(host, fd, message, serialization, sendHandle, options, error => {
          if (typeof callback === "function") callback(error);
          else if (error != null) processObject.emit?.("error", error);
        });
        return ok;
      }
      if (sendHandle != null) throw invalidIpcHandle();
      ok = host.ipcSend(fd, encodeBunSpawnIpc(message, true, serialization)) === true;
    } catch (error) {
      if (typeof callback === "function") queueMicrotask(() => callback(error));
      else queueMicrotask(() => processObject.emit?.("error", error));
      return false;
    }
    if (typeof callback === "function") queueMicrotask(() => callback(ok ? null : new Error("write failed")));
    return ok;
  };
  processObject.disconnect = () => {
    if (!connected) {
      const error = new Error("IPC channel is already disconnected");
      error.code = "ERR_IPC_DISCONNECTED";
      throw error;
    }
    close();
  };

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
