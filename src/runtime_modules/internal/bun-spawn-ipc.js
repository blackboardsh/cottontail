const ipcPrefix = "__COTTONTAIL_IPC__";

export function encodeBunSpawnIpc(message, nodeProtocol = false) {
  // COTTONTAIL-COMPAT: Bun.spawn advanced IPC - JSON-compatible values use
  // this shared framing today. Cycles, BigInt, typed arrays, transfer handles,
  // and Bun's structured-clone tags need a binary serializer in the IPC hook.
  const payload = JSON.stringify(message);
  if (payload === undefined) throw new TypeError("IPC message cannot be serialized");
  return nodeProtocol ? `${payload}\n` : `${ipcPrefix}${payload}\n`;
}

export function decodeBunSpawnIpc(line) {
  const text = String(line);
  return JSON.parse(text.startsWith(ipcPrefix) ? text.slice(ipcPrefix.length) : text);
}

export function isCottontailIpcFrame(line) {
  return String(line).startsWith(ipcPrefix);
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

// A Cottontail process launched by node:child_process receives an inherited
// NODE_CHANNEL_FD instead of COTTONTAIL_IPC_FD. Install the JSON channel during
// Bun runtime initialization so process.send works without requiring
// node:child_process from the child entrypoint.
export function installInheritedNodeIpc(host, processObject = globalThis.process) {
  if (processObject == null || typeof processObject.send === "function") return false;
  const fd = Number(processObject.env?.NODE_CHANNEL_FD);
  if (!Number.isInteger(fd) || fd <= 2 || typeof host?.ipcSend !== "function" || typeof host?.ipcRecv !== "function") {
    return false;
  }

  // COTTONTAIL-COMPAT: Node advanced IPC uses V8's binary ValueSerializer
  // framing. This portable bridge implements the complete JSON channel; the
  // native process hook must expose Node's binary framing for advanced mode.
  const serialization = processObject.env?.NODE_CHANNEL_SERIALIZATION_MODE === "advanced" ? "advanced" : "json";
  let connected = true;
  let buffer = "";
  let timer = null;

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

  const close = (emitDisconnect = true) => {
    if (!connected) return;
    connected = false;
    processObject.connected = false;
    if (timer != null) {
      clearInterval(timer);
      timer = null;
    }
    processObject.channel = null;
    processObject._channel = null;
    try { host.closeFd?.(fd); } catch {}
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
        buffer += new TextDecoder().decode(event.data ?? new ArrayBuffer(0));
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
      // JSON is also the intentional fallback for advanced mode until the
      // native serializer hook described above exists.
      ok = host.ipcSend(fd, encodeBunSpawnIpc(message, true)) === true;
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
  const channelEvents = new Set(["message", "disconnect", "internalMessage"]);
  for (const methodName of ["on", "addListener", "once", "prependListener", "prependOnceListener"]) {
    const original = processObject[methodName];
    if (typeof original !== "function") continue;
    processObject[methodName] = function (name, ...args) {
      const result = original.call(this, name, ...args);
      if (channelEvents.has(name)) channel.ref();
      return result;
    };
  }

  // Match Node: these variables configure bootstrap and are not left in the
  // user-visible child environment after the channel is initialized.
  try { delete processObject.env.NODE_CHANNEL_FD; } catch {}
  try { delete processObject.env.NODE_CHANNEL_SERIALIZATION_MODE; } catch {}
  processObject.channel.serializationMode = serialization;
  return true;
}
