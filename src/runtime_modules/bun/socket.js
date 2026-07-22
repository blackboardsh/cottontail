import * as nodeNet from "../node/net.js";
import {
  _connectMemoryTransport as nodeTlsConnectMemoryTransport,
  _upgradeServerSocket as nodeTlsUpgradeServerSocket,
  connect as nodeTlsConnect,
  createServer as nodeTlsCreateServer,
} from "../node/tls.js";
import { _wrapAsyncCallback } from "../node/async_hooks.js";

function asBuffer(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (globalThis.Buffer?.from) return globalThis.Buffer.from(value ?? "");
  return new TextEncoder().encode(String(value ?? ""));
}
function sharedArrayBufferBytes(data) {
  if (typeof SharedArrayBuffer !== "function" || !(data instanceof SharedArrayBuffer)) return null;
  if (data.byteLength === 0) return new Uint8Array(0);
  const copy = new Uint8Array(data.byteLength);
  copy.set(new Uint8Array(data));
  return copy;
}

function coerceServeOptionString(value, name) {
  if (typeof value === "symbol") throw new TypeError(`${name} must be coercible to a string`);
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" && typeof value !== "function") return String(value);

  for (const methodName of ["toString", "valueOf"]) {
    const method = value[methodName];
    if (typeof method !== "function") continue;
    const result = method.call(value);
    if (result === null || result === undefined || typeof result === "symbol") {
      throw new TypeError(`${name} must be coercible to a string`);
    }
    if (typeof result !== "object" && typeof result !== "function") return String(result);
  }
  throw new TypeError(`${name} must be coercible to a string`);
}

const bunSocketCallbackError = Symbol("cottontail.bunSocketCallbackError");
const bunSocketCallbackNames = {
  open: "onOpen",
  close: "onClose",
  data: "onData",
  drain: "onWritable",
  timeout: "onTimeout",
  connectError: "onConnectError",
  end: "onEnd",
  error: "onError",
  handshake: "onHandshake",
};

function bunSocketInvalidArgument(message) {
  const error = new TypeError(message);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function normalizeBunSocketHandlers(value, isServer = false) {
  if (value === undefined) throw bunSocketInvalidArgument("SocketOptions.socket is required");
  if (value === null || typeof value !== "object") {
    throw bunSocketInvalidArgument("SocketHandler must be an object");
  }

  const handlers = { binaryType: "buffer", isServer };
  let callbackCount = 0;
  for (const [name, callbackName] of Object.entries(bunSocketCallbackNames)) {
    const callback = value[name];
    if (callback == null) continue;
    if (typeof callback !== "function") {
      throw bunSocketInvalidArgument(`Expected "${callbackName}" callback to be a function`);
    }
    handlers[name] = _wrapAsyncCallback(callback);
    callbackCount += 1;
  }

  if (value.binaryType !== undefined) {
    if (typeof value.binaryType !== "string") {
      throw bunSocketInvalidArgument("SocketHandler.binaryType must be a string");
    }
    if (value.binaryType !== "arraybuffer" && value.binaryType !== "buffer" && value.binaryType !== "uint8array") {
      throw bunSocketInvalidArgument('SocketHandler.binaryType must be "arraybuffer", "buffer", or "uint8array"');
    }
    handlers.binaryType = value.binaryType;
  }

  if (handlers.data == null && handlers.drain == null && callbackCount === 0) {
    throw bunSocketInvalidArgument('Expected at least "data" or "drain" callback');
  }
  return handlers;
}

function createBunSocketHandlerState(value, isServer = false) {
  return { current: normalizeBunSocketHandlers(value, isServer), isServer };
}

function reloadBunSocketHandlerState(state, value) {
  const handlers = normalizeBunSocketHandlers(value, state.isServer);
  state.current = handlers;
}

function normalizeBunSocketCallbackError(error) {
  if (!(error instanceof Error)) return error;
  const missingVariable = /^Can't find variable: (.+)$/.exec(String(error.message));
  if (missingVariable) error.message = `${missingVariable[1]} is not defined`;
  return error;
}

function bunSocketTlsTransport(socket) {
  const transport = {
    get connecting() { return socket.connecting; },
    get destroyed() { return socket.destroyed; },
    get writable() { return socket.writable; },
    get readable() { return socket.readable; },
    get remoteAddress() { return socket.remoteAddress; },
    get _host() { return socket._host; },
    on(name, callback) {
      socket.on(name, callback);
      return transport;
    },
    once(name, callback) {
      socket.once(name, callback);
      return transport;
    },
    removeListener(name, callback) {
      socket.removeListener(name, callback);
      return transport;
    },
    write(chunk) {
      const write = socket.__cottontailNodeWrite ?? socket.write.bind(socket);
      return write(chunk) !== false;
    },
    end(...args) {
      const end = socket.__cottontailNodeEnd ?? socket.end.bind(socket);
      end(...args);
      return transport;
    },
    destroy(error) {
      socket.destroy(error);
      return transport;
    },
    pause() {
      socket.pause();
      return transport;
    },
    resume() {
      socket.resume();
      return transport;
    },
    ref() {
      socket.ref();
      return transport;
    },
    unref() {
      socket.unref();
      return transport;
    },
  };
  return transport;
}

function bunSocketUpgradeTlsError(error) {
  if (!(error instanceof Error)) error = new Error(String(error));
  if (error.code == null || /^ERR_(?:SSL|OSSL)/.test(String(error.code))) {
    error.code = "ERR_BORINGSSL";
  }
  return error;
}

function upgradeBunSocketToTls(socket, options) {
  if (socket.destroyed || socket.connecting || !socket.readable || !socket.writable) return undefined;
  if (socket._isPipe) return undefined;
  if (options === null || typeof options !== "object") throw new TypeError("Expected options object");
  const isServer = socket.listener != null;
  const handlerState = createBunSocketHandlerState(options.socket, isServer);
  const tls = options.tls;
  if (tls !== true && (tls === null || typeof tls !== "object" || Object.keys(tls).length === 0)) {
    throw new TypeError('Expected "tls" option');
  }

  const normalized = {
    hostname: String(socket._host ?? socket.remoteAddress ?? "localhost"),
    port: Number(socket.remotePort ?? 0),
  };
  const tlsOptions = bunSocketTlsOptions(tls, normalized, isServer);
  let tlsSocket;
  try {
    if (isServer) {
      tlsSocket = nodeTlsUpgradeServerSocket(socket, {
        ...tlsOptions,
        isServer: true,
        allowHalfOpen: socket.allowHalfOpen === true,
      });
      tlsSocket.listener = socket.listener;
    } else {
      const transport = bunSocketTlsTransport(socket);
      tlsSocket = nodeTlsConnectMemoryTransport(transport, {
        ...tlsOptions,
        host: normalized.hostname,
        port: normalized.port,
      });
    }
  } catch (error) {
    throw bunSocketUpgradeTlsError(error);
  }

  tlsSocket.allowHalfOpen = socket.allowHalfOpen === true;
  const attached = attachBunSocketHandlers(tlsSocket, handlerState, options.data);
  if (typeof attached.handlers.handshake === "function") attached.call("open", tlsSocket);
  tlsSocket.once(isServer ? "secure" : "secureConnect", () => {
    completeBunTlsHandshake(attached);
    if (typeof attached.handlers.drain === "function") {
      queueMicrotask(() => {
        if (!tlsSocket.destroyed) attached.call("drain", tlsSocket);
      });
    }
  });
  return [socket, tlsSocket];
}

function defineBunSocketMethod(socket, name, value) {
  Object.defineProperty(socket, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: false,
  });
}

function bunSocketRangeError(name, value, maximum) {
  const error = new RangeError(`The value of "${name}" is out of range. It must be >= 0 and <= ${maximum}. Received ${String(value)}`);
  error.code = "ERR_OUT_OF_RANGE";
  return error;
}

function bunSocketWriteArguments(args, label) {
  const data = args[0];
  if (data === undefined) return new Uint8Array(0);

  let byteOffset = args[1];
  let byteLength = args[2];
  let encoding = args[3];
  if (typeof byteLength === "string") {
    encoding = byteLength;
    byteLength = undefined;
  } else if (typeof byteOffset === "string") {
    encoding = byteOffset;
    byteOffset = undefined;
  }
  if (encoding !== undefined && typeof encoding !== "string") {
    throw bunSocketInvalidArgument(`Socket.${label} encoding must be a string`);
  }
  if (encoding !== undefined && (byteOffset !== undefined || byteLength !== undefined)) {
    throw new Error("Encoding cannot be combined with byteOffset or byteLength");
  }

  let bytes;
  if (typeof data === "string") {
    bytes = globalThis.Buffer?.from
      ? globalThis.Buffer.from(data, encoding ?? "utf8")
      : new TextEncoder().encode(data);
  } else {
    const sharedCopy = sharedArrayBufferBytes(data);
    if (sharedCopy != null) bytes = sharedCopy;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else throw bunSocketInvalidArgument(`Socket.${label} data must be a string, buffer, or blob`);
  }

  const offset = byteOffset === undefined ? 0 : byteOffset;
  if (!Number.isInteger(offset)) {
    throw bunSocketInvalidArgument(`Socket.${label} byteOffset must be an integer`);
  }
  if (offset < 0 || offset > bytes.byteLength) throw bunSocketRangeError("byteOffset", offset, bytes.byteLength);

  const length = byteLength === undefined ? bytes.byteLength : byteLength;
  if (!Number.isInteger(length)) {
    throw bunSocketInvalidArgument(`Socket.${label} byteLength must be an integer`);
  }
  const remaining = bytes.byteLength - offset;
  if (length < 0 || length > remaining) throw bunSocketRangeError("byteLength", length, remaining);
  return bytes.subarray(offset, offset + length);
}

function armBunSocketWritable(socket) {
  if (!socket._watchId && socket.fd != null) socket._startRead?.();
  if (socket._watchId) cottontail.fdWatchSetWritable?.(socket._watchId, true);
}

function writeBunSocketBytes(socket, bytes) {
  if (socket.destroyed || !socket.writable) return -1;
  if (socket.encrypted) {
    if (socket._tlsId == null && !socket.connecting) return -1;
    if (socket.connecting) {
      const accepted = socket.__cottontailNodeWrite(bytes);
      if (accepted === false) socket.__cottontailBunNeedsDrain = true;
      return bytes.byteLength;
    }
    const written = Number(socket._writeBunTlsBytesSome?.(bytes) ?? -1);
    if (!Number.isFinite(written) || written < 0) return -1;
    if (written < bytes.byteLength || socket._tlsWriteBlocked) socket.__cottontailBunNeedsDrain = true;
    return Math.min(bytes.byteLength, Math.trunc(written));
  }
  if (socket.fd == null) return -1;
  if (bytes.byteLength === 0) return 0;

  let written;
  try {
    written = Number(cottontail.fdWriteSome(socket.fd, bytes));
  } catch (error) {
    queueMicrotask(() => {
      if (!socket.destroyed) socket.destroy(error);
    });
    return -1;
  }
  if (!Number.isFinite(written) || written < 0) return -1;
  written = Math.min(bytes.byteLength, Math.trunc(written));
  socket._bytesDispatchedValue = (Number(socket._bytesDispatchedValue) || 0) + written;
  if (written > 0) socket._refreshTimeout?.();
  if (written < bytes.byteLength) {
    socket.__cottontailBunNeedsDrain = true;
    armBunSocketWritable(socket);
  }
  return written;
}

function attachBunSocketHandlers(socket, handlerState, data = undefined, connectionState = undefined) {
  socket.data = data;
  socket.__cottontailBunHandlerState = handlerState;

  const call = (name, ...args) => {
    const handlers = handlerState.current;
    const callback = handlers?.[name];
    if (typeof callback !== "function") {
      if (name === "error") throw args[1];
      return undefined;
    }
    try {
      return callback.apply(socket, args);
    } catch (error) {
      error = normalizeBunSocketCallbackError(error);
      if (name !== "error" && typeof handlers.error === "function") {
        handlers.error.call(socket, socket, error);
        return { [bunSocketCallbackError]: true, error };
      }
      throw error;
    }
  };
  socket.__cottontailBunCall = call;

  if (!socket.__cottontailBunSocketMethods) {
    const nodeWrite = socket.write.bind(socket);
    const nodeEnd = socket.end.bind(socket);
    const nodePause = socket.pause.bind(socket);
    const nodeResume = socket.resume.bind(socket);
    const nodeRef = socket.ref.bind(socket);
    const nodeUnref = socket.unref.bind(socket);
    const nodeDestroy = socket.destroy.bind(socket);
    Object.defineProperties(socket, {
      __cottontailBunSocketMethods: { value: true },
      __cottontailNodeWrite: { value: nodeWrite },
      __cottontailNodeEnd: { value: nodeEnd },
    });

    defineBunSocketMethod(socket, "write", function write(data, byteOffset, byteLength) {
      if (socket.destroyed || !socket.writable || (!socket.encrypted && socket.fd == null)) return -1;
      return writeBunSocketBytes(socket, bunSocketWriteArguments(arguments, "write"));
    });
    defineBunSocketMethod(socket, "end", function end(data, byteOffset, byteLength) {
      if (socket.destroyed || !socket.writable || (!socket.encrypted && socket.fd == null)) return -1;
      const bytes = bunSocketWriteArguments(arguments, "end");
      const written = writeBunSocketBytes(socket, bytes);
      if (written < 0) return written;
      if (written === bytes.byteLength) {
        nodeEnd();
        socket.__cottontailBunShutdown = true;
      } else {
        socket.__cottontailBunEndAfterDrain = true;
      }
      return written;
    });
    defineBunSocketMethod(socket, "flush", function flush() {
      socket._flushTlsPendingWrites?.();
      return undefined;
    });
    defineBunSocketMethod(socket, "shutdown", function shutdown(read) {
      if (socket.destroyed) return undefined;
      if (read) {
        if (!socket.encrypted && socket.fd != null) {
          try { cottontail.tcpSocketShutdown?.(socket.fd, true); } catch {}
        }
        nodePause();
        socket.readable = false;
        socket._stopRead?.();
      } else {
        nodeEnd();
      }
      socket.__cottontailBunShutdown = true;
      return undefined;
    });
    defineBunSocketMethod(socket, "timeout", function timeout(seconds) {
      if (arguments.length === 0) throw new Error("Expected 1 argument, got 0");
      const value = Math.trunc(Number(seconds));
      if (value < 0) throw new Error("Timeout must be a positive integer");
      socket._timeoutValue = Number.isFinite(value) ? value * 1000 : 0;
      socket._refreshTimeout?.();
      return undefined;
    });
    defineBunSocketMethod(socket, "pause", function pause() {
      nodePause();
      return undefined;
    });
    defineBunSocketMethod(socket, "resume", function resume() {
      nodeResume();
      return undefined;
    });
    defineBunSocketMethod(socket, "ref", function ref() {
      nodeRef();
      return undefined;
    });
    defineBunSocketMethod(socket, "unref", function unref() {
      nodeUnref();
      return undefined;
    });
    defineBunSocketMethod(socket, "setNoDelay", function setNoDelay(enabled) {
      if (socket.destroyed || socket.fd == null || socket._isPipe) return false;
      return cottontail.tcpSocketSetNoDelay?.(socket.fd, arguments.length === 0 ? true : Boolean(enabled)) === true;
    });
    defineBunSocketMethod(socket, "setKeepAlive", function setKeepAlive(enabled, initialDelay) {
      if (socket.destroyed || socket.fd == null || socket._isPipe) return false;
      const delay = Number(arguments.length > 1 ? initialDelay : 0);
      if (!Number.isInteger(delay) || delay < 0) throw bunSocketRangeError("initialDelay", initialDelay, 0x7fffffff);
      return cottontail.tcpSocketSetKeepAlive?.(socket.fd, Boolean(enabled), delay * 1000) === true;
    });
    defineBunSocketMethod(socket, "terminate", function terminate() {
      if (socket.destroyed) return undefined;
      if (socket.encrypted || socket.fd == null) {
        nodeDestroy();
        return undefined;
      }
      const fd = socket.fd;
      socket._stopRead?.();
      socket.fd = null;
      try { cottontail.tcpSocketReset?.(fd); }
      catch { try { cottontail.closeFd?.(fd); } catch {} }
      socket._destroyImmediately?.();
      return undefined;
    });
    defineBunSocketMethod(socket, "close", function close() {
      socket._destroyImmediately?.();
      if (!socket.destroyed) nodeDestroy();
      return undefined;
    });
    defineBunSocketMethod(socket, "reload", function reload(nextOptions) {
      if (arguments.length === 0) throw new Error("Expected 1 argument");
      if (socket.destroyed) return undefined;
      if (nextOptions === null || typeof nextOptions !== "object") throw new TypeError("Expected options object");
      if (nextOptions.socket === undefined) throw new TypeError('Expected "socket" option');
      reloadBunSocketHandlerState(socket.__cottontailBunHandlerState, nextOptions.socket);
      return undefined;
    });
    defineBunSocketMethod(socket, "getAuthorizationError", function getAuthorizationError() {
      return socket.encrypted ? bunSocketAuthorizationError(socket) : null;
    });
    if (!socket.encrypted) {
      defineBunSocketMethod(socket, "upgradeTLS", function upgradeTLS(options) {
        return upgradeBunSocketToTls(socket, options);
      });
    }
    Object.defineProperty(socket, "readyState", {
      get() {
        if (socket.destroyed || socket._closeEmitted) return -1;
        if (socket.__cottontailBunShutdown || !socket.writable) return -2;
        if (socket.fd != null || socket.encrypted) return 1;
        if (socket.connecting) return 2;
        return 0;
      },
      configurable: true,
      enumerable: false,
    });
    Object.defineProperty(socket, Symbol.dispose, {
      value() {
        socket.end();
      },
      configurable: true,
    });
    Object.defineProperty(socket, Symbol.asyncDispose, {
      value() {
        if (socket.destroyed || socket._closeEmitted) return Promise.resolve();
        return new Promise((resolve) => {
          socket.once("close", resolve);
          socket.end();
        });
      },
      configurable: true,
    });
    socket.__cottontailBunWritable = () => {
      if (socket.destroyed || (!socket.__cottontailBunNeedsDrain && !socket.__cottontailBunEndAfterDrain)) return;
      socket.__cottontailBunNeedsDrain = false;
      if (socket.__cottontailBunEndAfterDrain) {
        socket.__cottontailBunEndAfterDrain = false;
        nodeEnd();
        socket.__cottontailBunShutdown = true;
        return;
      }
      socket.__cottontailBunCall?.("drain", socket);
    };
  }

  socket.on("data", (chunk) => {
    const binaryType = handlerState.current.binaryType;
    let value = chunk;
    if (binaryType === "arraybuffer") {
      const bytes = asBuffer(chunk);
      value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    } else if (binaryType === "uint8array") {
      const bytes = asBuffer(chunk);
      value = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else if (!globalThis.Buffer?.isBuffer?.(value) && globalThis.Buffer?.from) {
      value = globalThis.Buffer.from(asBuffer(value));
    }
    call("data", socket, value);
  });
  socket.on("drain", () => {
    if (socket.encrypted && !socket.authorized) {
      socket.__cottontailBunDrainAfterHandshake = true;
      return;
    }
    socket.__cottontailBunNeedsDrain = false;
    if (socket.__cottontailBunEndAfterDrain) {
      socket.__cottontailBunEndAfterDrain = false;
      socket.__cottontailNodeEnd?.();
      socket.__cottontailBunShutdown = true;
      return;
    }
    call("drain", socket);
  });
  socket.on("end", () => {
    if (typeof handlerState.current.end === "function") call("end", socket);
    else if (!socket.destroyed) socket._destroyImmediately?.();
  });
  socket.on("timeout", () => call("timeout", socket));
  socket.on("error", (error) => {
    socket.__cottontailBunCloseError = error;
    if (connectionState?.connecting) {
      connectionState.connecting = false;
      connectionState.failed = true;
      const connectError = new Error("Failed to connect");
      connectError.code = error?.code ?? "ECONNREFUSED";
      connectError.errno = error?.errno ?? connectError.code;
      try {
        call("connectError", socket, connectError);
      } finally {
        connectionState.reject?.(connectError);
      }
      return;
    }
    if (socket.encrypted && socket._secureEventsEmitted !== true && typeof handlerState.current.error !== "function") {
      return;
    }
    call("error", socket, error);
  });
  socket.on("close", (hadError) => {
    if (connectionState?.failed && !connectionState.opened) return;
    call("close", socket, hadError ? socket.__cottontailBunCloseError ?? new Error("Socket closed with an error") : undefined);
  });
  return {
    socket,
    call,
    get handlers() { return handlerState.current; },
  };
}

function callBunSocketOpen(attached, closeOnError = true) {
  let result;
  try {
    result = attached.call("open", attached.socket);
  } catch (error) {
    if (closeOnError) attached.socket.destroy();
    throw error;
  }
  if (result instanceof Error) {
    if (closeOnError) attached.socket.destroy(result);
    else attached.call("error", attached.socket, result);
  } else if (result?.[bunSocketCallbackError] && closeOnError) {
    attached.socket.destroy();
  }
  return result;
}

function normalizeBunSocketOptions(options) {
  if (options === null || typeof options !== "object") throw new TypeError("Bun socket options must be an object");
  const booleanOptions = ["exclusive", "allowHalfOpen", "reusePort", "ipv6Only"];
  for (const name of booleanOptions) {
    if (options[name] !== undefined && typeof options[name] !== "boolean") {
      throw bunSocketInvalidArgument(`SocketOptions.${name} must be a boolean`);
    }
  }
  if (options.backlog !== undefined && (!Number.isInteger(Number(options.backlog)) || Number(options.backlog) < 0)) {
    throw bunSocketRangeError("backlog", options.backlog, 0x7fffffff);
  }
  if (options.tls != null && options.tls !== false && options.tls !== true && typeof options.tls !== "object") {
    throw new TypeError("TLSOptions must be an object");
  }

  let fd;
  if (options.fd !== undefined) {
    if (typeof options.fd !== "number") {
      throw bunSocketInvalidArgument("SocketOptions.fd must be a number");
    }
    fd = options.fd;
    if (!Number.isInteger(fd)) {
      const error = new RangeError(`SocketOptions.fd must be an integer (received ${String(options.fd)})`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    if (fd < -0x80000000 || fd > 0x7fffffff) {
      throw bunSocketRangeError("fd", options.fd, 0x7fffffff);
    }
  }

  let unix = "";
  if (fd === undefined && options.unix) {
    unix = coerceServeOptionString(options.unix, "unix");
    if (unix.startsWith("file://") || unix.startsWith("unix://") || unix.startsWith("sock://")) {
      unix = unix.slice(7);
    }
    if (unix.includes("\0")) throw new TypeError("unix must not contain NUL bytes");
  }

  let hostname = "";
  let port = 0;
  const hostnameValue = options.hostname !== undefined ? options.hostname : options.host;
  if (fd === undefined && !unix && hostnameValue) {
    hostname = coerceServeOptionString(hostnameValue, "hostname");
    let portValue = options.port;
    if (portValue === undefined && hostname.includes("://")) {
      try {
        const parsed = new URL(hostname);
        if (parsed.port !== "") portValue = parsed.port;
        hostname = parsed.hostname || hostname;
      } catch {}
    }
    if (portValue == null) throw bunSocketInvalidArgument('Missing "port"');
    port = Number(portValue);
    if (!Number.isInteger(port)) {
      const error = new RangeError(`SocketOptions.port must be an integer (received ${String(portValue)})`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
    if (port < 0 || port > 65535) {
      const error = new RangeError(`SocketOptions.port must be in the range [0, 65535] (received ${String(portValue)})`);
      error.code = "ERR_OUT_OF_RANGE";
      throw error;
    }
  }
  if (fd === undefined && !unix && !hostname) {
    throw bunSocketInvalidArgument('Expected either "hostname" or "unix"');
  }
  return {
    fd,
    unix,
    hostname,
    port,
    backlog: Number(options.backlog ?? 128),
    exclusive: options.exclusive === true,
    allowHalfOpen: options.allowHalfOpen === true,
    reusePort: options.reusePort === true,
    ipv6Only: options.ipv6Only === true,
  };
}

function bunSocketTlsOptions(value, normalized, isServer = false) {
  const input = value === true ? {} : value;
  const options = { ...(input ?? {}) };
  if (options.servername == null && options.serverName != null) options.servername = options.serverName;
  delete options.serverName;
  if (!isServer) {
    // Bun reports certificate verification through the handshake callback but
    // does not abort an otherwise successful TLS handshake on verification.
    options.rejectUnauthorized = false;
    if (options.servername == null && normalized.hostname && !nodeNet.isIP(normalized.hostname)) {
      options.servername = normalized.hostname;
    }
  }
  return options;
}

function bunSocketAuthorizationError(socket) {
  const code = socket.authorizationError;
  if (code == null) return null;
  const info = socket._currentTlsInfo?.();
  const error = new Error(info?.verifyErrorMessage ?? String(code));
  error.code = String(code);
  return error;
}

function completeBunTlsHandshake(attached) {
  const socket = attached.socket;
  const authorizationError = bunSocketAuthorizationError(socket);
  // Bun's `authorized` flag reflects transport handshake success. Certificate
  // verification details remain available as the third callback argument.
  socket.authorized = true;
  if (typeof attached.handlers?.handshake === "function") {
    attached.call("handshake", socket, true, authorizationError);
  } else {
    callBunSocketOpen(attached, false);
  }
  if (socket.__cottontailBunDrainAfterHandshake) {
    socket.__cottontailBunDrainAfterHandshake = false;
    queueMicrotask(() => {
      if (!socket.destroyed) attached.call("drain", socket);
    });
  }
}

export function connect(options) {
  if (arguments.length === 0) throw bunSocketInvalidArgument("Missing argument");
  if (options === null || typeof options !== "object") throw new TypeError("Bun socket options must be an object");
  const handlerState = createBunSocketHandlerState(options.socket, false);
  const normalized = normalizeBunSocketOptions(options);
  const promise = new Promise((resolve, reject) => {
    const state = { connecting: true, opened: false, failed: false, reject };
    let socket;
    let attached;
    const useTls = options.tls != null && options.tls !== false;
    if (useTls) {
      let transport;
      if (normalized.fd !== undefined) {
        transport = new nodeNet.Socket({ allowHalfOpen: normalized.allowHalfOpen });
        try {
          cottontail.fstatSync(normalized.fd);
          transport._attachFd(normalized.fd, undefined, undefined, true);
        } catch (error) {
          state.connecting = false;
          state.failed = true;
          const connectError = new Error("Failed to connect");
          connectError.code = error?.code ?? "EBADF";
          connectError.errno = error?.errno ?? connectError.code;
          reject(connectError);
          return;
        }
      } else {
        transport = nodeNet.connect(normalized.unix
          ? { path: normalized.unix, allowHalfOpen: normalized.allowHalfOpen }
          : { host: normalized.hostname, port: normalized.port, allowHalfOpen: normalized.allowHalfOpen });
      }
      socket = nodeTlsConnect({
        ...bunSocketTlsOptions(options.tls, normalized),
        socket: transport,
        host: normalized.hostname,
        port: normalized.port,
      });
      socket.allowHalfOpen = normalized.allowHalfOpen;
      attached = attachBunSocketHandlers(socket, handlerState, options.data, state);
      let settled = false;
      const settle = () => {
        if (settled || state.failed) return;
        settled = true;
        state.connecting = false;
        state.opened = true;
        resolve(socket);
      };
      let transportOpened = false;
      const onTransportOpen = () => {
        if (transportOpened) return;
        transportOpened = true;
        settle();
        if (typeof attached.handlers.handshake === "function") callBunSocketOpen(attached);
      };
      socket.once("connect", onTransportOpen);
      if (transport.connecting) transport.once("connect", onTransportOpen);
      else queueMicrotask(onTransportOpen);
      socket.once("secureConnect", () => {
        if (state.failed) return;
        completeBunTlsHandshake(attached);
        settle();
      });
      return;
    }
    const onConnect = () => {
      if (state.failed) return;
      state.connecting = false;
      state.opened = true;
      resolve(socket);
      callBunSocketOpen(attached);
    };
    if (normalized.fd !== undefined) {
      socket = new nodeNet.Socket({ allowHalfOpen: normalized.allowHalfOpen });
      attached = attachBunSocketHandlers(socket, handlerState, options.data, state);
      socket.once("connect", onConnect);
      try {
        cottontail.fstatSync(normalized.fd);
        socket._attachFd(normalized.fd, undefined, undefined, true);
      } catch (error) {
        state.connecting = false;
        state.failed = true;
        const connectError = new Error("Failed to connect");
        connectError.code = error?.code ?? "EBADF";
        connectError.errno = error?.errno ?? connectError.code;
        attached.call("connectError", socket, connectError);
        reject(connectError);
      }
    } else {
      socket = nodeNet.connect(normalized.unix
        ? { path: normalized.unix, allowHalfOpen: normalized.allowHalfOpen }
        : { host: normalized.hostname, port: normalized.port, allowHalfOpen: normalized.allowHalfOpen });
      attached = attachBunSocketHandlers(socket, handlerState, options.data, state);
      socket.once("connect", onConnect);
    }
  });
  if (typeof handlerState.current.connectError === "function") promise.catch(() => {});
  return promise;
}

export function listen(options) {
  if (arguments.length === 0) throw bunSocketInvalidArgument("Missing argument");
  if (options === null || typeof options !== "object") throw new TypeError("Bun socket options must be an object");
  const handlerState = createBunSocketHandlerState(options.socket, true);
  const normalized = normalizeBunSocketOptions(options);
  if (normalized.fd !== undefined) {
    const error = new Error("Bun does not support listening on a file descriptor.");
    error.code = "EINVAL";
    throw error;
  }

  const useTls = options.tls != null && options.tls !== false;
  let server;
  let address;
  if (useTls) {
    const tlsList = Array.isArray(options.tls) ? options.tls : [options.tls];
    if (tlsList.length === 0) throw new TypeError("TLSOptions must be an object");
    server = nodeTlsCreateServer({
      ...bunSocketTlsOptions(tlsList[0], normalized, true),
      allowHalfOpen: normalized.allowHalfOpen,
    });
    for (let index = 1; index < tlsList.length; index += 1) {
      const item = tlsList[index];
      if (item == null || typeof item !== "object" || typeof item.serverName !== "string" || item.serverName.length === 0) {
        throw new TypeError("SNI tls object must have a serverName");
      }
      server.addContext(item.serverName, bunSocketTlsOptions(item, normalized, true));
    }
    server.listen(normalized.unix
      ? { path: normalized.unix, backlog: normalized.backlog }
      : {
          host: normalized.hostname,
          port: normalized.port,
          backlog: normalized.backlog,
          exclusive: normalized.exclusive,
          ipv6Only: normalized.ipv6Only,
          reusePort: normalized.reusePort,
        });
    address = server.address();
  } else {
    const native = normalized.unix
      ? cottontail.unixServerListen(normalized.unix, normalized.backlog)
      : cottontail.tcpServerListen(
          normalized.port,
          normalized.hostname,
          nodeNet.isIP(normalized.hostname) || 0,
          normalized.backlog,
          normalized.ipv6Only,
          normalized.reusePort,
          normalized.exclusive,
        );
    address = normalized.unix ? { path: String(native.path ?? normalized.unix), family: "Unix" } : native.address;
    server = nodeNet.Server._fromFd(native.fd, {
      pipe: Boolean(normalized.unix),
      path: normalized.unix || undefined,
      ownsPipePath: Boolean(normalized.unix),
      allowHalfOpen: normalized.allowHalfOpen,
      pauseOnConnect: true,
    });
  }
  let stopped = false;
  let listenerData = options.data;
  const tlsConnections = new WeakMap();

  server.on("connection", (socket) => {
    socket.listener = listener;
    socket.allowHalfOpen = normalized.allowHalfOpen;
    socket._timeoutValue = 120_000;
    socket._refreshTimeout?.();
    const attached = attachBunSocketHandlers(socket, handlerState, listenerData);
    if (useTls) {
      tlsConnections.set(socket, attached);
      if (typeof attached.handlers?.handshake === "function") callBunSocketOpen(attached);
    } else {
      // Keep accepted bytes in the kernel until the synchronous open callback
      // has had a chance to replace the fd with a TLS transport.
      socket._paused = false;
      callBunSocketOpen(attached);
      if (!socket.destroyed && !socket._paused) socket.resume();
    }
  });
  if (useTls) {
    server.on("secureConnection", (socket) => {
      const attached = tlsConnections.get(socket);
      if (attached != null) completeBunTlsHandshake(attached);
    });
  }

  const listener = {
    get data() {
      return listenerData;
    },
    set data(value) {
      listenerData = value;
    },
    get connections() {
      return Number(server._connections ?? server._activeSockets?.size ?? 0);
    },
    get fd() {
      return server._fd == null ? -1 : Number(server._fd);
    },
    hostname: normalized.unix ? undefined : normalized.hostname,
    port: normalized.unix ? undefined : Number(address?.port ?? normalized.port),
    unix: normalized.unix || undefined,
    stop(closeActiveConnections) {
      if (stopped) return;
      stopped = true;
      server.close();
      if (closeActiveConnections === true) server._closeActiveConnections?.();
    },
    ref() {
      server.ref();
    },
    unref() {
      server.unref();
    },
    reload(nextOptions) {
      if (arguments.length === 0) throw new Error("Expected 1 argument");
      if (nextOptions === null || typeof nextOptions !== "object") throw new TypeError("Expected options object");
      if (nextOptions.socket === undefined) throw new TypeError('Expected "socket" object');
      reloadBunSocketHandlerState(handlerState, nextOptions.socket);
      return undefined;
    },
    addServerName(serverName, tls) {
      if (!useTls) throw new Error("addServerName requires SSL support");
      if (typeof serverName !== "string") throw new TypeError("hostname pattern expects a string");
      if (serverName.length === 0) throw new TypeError("hostname pattern cannot be empty");
      server.addContext(serverName, bunSocketTlsOptions(tls, normalized, true));
    },
    getsockname(out) {
      if (out === null || typeof out !== "object") throw new TypeError("getsockname requires an object");
      if (normalized.unix) {
        out.family = "Unix";
        out.address = String(address?.path ?? normalized.unix);
      } else {
        out.family = String(address?.family ?? (listener.hostname.includes(":") ? "IPv6" : "IPv4"));
        out.address = String(address?.address ?? listener.hostname);
        out.port = listener.port;
      }
      return undefined;
    },
    [Symbol.dispose]() {
      listener.stop(true);
    },
    [Symbol.asyncDispose]() {
      listener.stop(true);
      return Promise.resolve();
    },
  };
  return listener;
}
