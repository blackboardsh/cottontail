const terminalStates = new WeakMap();

function terminalFdListeners() {
  const listeners = globalThis.__cottontailFdWatchListeners ??= new Map();
  if (!globalThis.__cottontailFdWatchHandlerInstalled && typeof cottontail.fdSetEventHandler === "function") {
    globalThis.__cottontailFdWatchHandlerInstalled = true;
    cottontail.fdSetEventHandler((event) => {
      const listener = listeners.get(Number(event?.id));
      if (typeof listener === "function") listener(event);
    });
  }
  return listeners;
}

function closeTerminalResource(resource) {
  if (!resource || resource.closed) return;
  resource.closed = true;
  if (resource.watchId) {
    terminalFdListeners().delete(resource.watchId);
    cottontail.fdWatchStop?.(resource.watchId);
    resource.watchId = 0;
  }
  const descriptors = new Set([resource.masterFd, resource.readFd, resource.writeFd, resource.slaveFd]);
  for (const fd of descriptors) {
    if (Number.isInteger(fd) && fd >= 0) {
      try { cottontail.closeFd?.(fd); } catch {}
    }
  }
  resource.masterFd = -1;
  resource.readFd = -1;
  resource.writeFd = -1;
  resource.slaveFd = -1;
}

const terminalFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry(closeTerminalResource)
  : null;

function terminalState(value) {
  const state = terminalStates.get(value);
  if (!state) throw new TypeError("Expected a Terminal object");
  return state;
}

function notifyTerminalExit(terminal, code = 0, signal = null) {
  if (!terminal) return;
  const state = terminalStates.get(terminal);
  if (!state || state.exitNotified) return;
  state.exitNotified = true;
  if (typeof state.exit !== "function") return;
  queueMicrotask(() => {
    try {
      state.exit(terminal, code, signal);
    } catch (error) {
      queueMicrotask(() => { throw error; });
    }
  });
}

export function terminalSpawnFd(terminal) {
  if (!terminal) return undefined;
  const state = terminalState(terminal);
  if (state.closed || state.resource.slaveFd < 0) throw new Error("terminal is closed");
  return state.resource.slaveFd;
}

export function terminalProcessExited(terminal, code, signal) {
  notifyTerminalExit(terminal, code ?? 0, signal ?? null);
}

export class Terminal {
  constructor(options) {
    if (options == null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Terminal constructor requires an options object");
    }
    if (typeof cottontail.terminalCreate !== "function") {
      throw new Error("PTY not supported on this platform");
    }

    const cols = typeof options.cols === "number" && Number.isInteger(options.cols) && options.cols > 0 && options.cols <= 0xffff
      ? options.cols
      : 80;
    const rows = typeof options.rows === "number" && Number.isInteger(options.rows) && options.rows > 0 && options.rows <= 0xffff
      ? options.rows
      : 24;
    const name = typeof options.name === "string" && options.name.length > 0 ? options.name : "xterm-256color";
    if (name.length > 128) throw new TypeError("Terminal name too long (max 128 characters)");

    const native = cottontail.terminalCreate(cols, rows);
    const resource = {
      closed: false,
      watchId: 0,
      masterFd: Number(native?.masterFd ?? -1),
      readFd: Number(native?.readFd ?? -1),
      writeFd: Number(native?.writeFd ?? -1),
      slaveFd: Number(native?.slaveFd ?? -1),
    };
    if ([resource.masterFd, resource.readFd, resource.writeFd, resource.slaveFd].some((fd) => !Number.isInteger(fd) || fd < 0)) {
      closeTerminalResource(resource);
      throw new Error("Failed to open PTY");
    }

    const state = {
      resource,
      closed: false,
      referenced: true,
      exitNotified: false,
      name,
      data: typeof options.data === "function" ? _wrapAsyncCallback(options.data) : undefined,
      exit: typeof options.exit === "function" ? _wrapAsyncCallback(options.exit) : undefined,
      drain: typeof options.drain === "function" ? _wrapAsyncCallback(options.drain) : undefined,
    };
    terminalStates.set(this, state);

    try {
      const watch = cottontail.fdWatchStart(resource.readFd, 64 * 1024, true, false);
      resource.watchId = Number(watch?.id ?? 0);
      if (!resource.watchId) throw new Error("Failed to start terminal reader");
      terminalFdListeners().set(resource.watchId, (event) => {
        if (state.closed) return;
        if (event?.type === "data") {
          if (typeof state.data !== "function") return;
          const bytes = asBuffer(event.data ?? new ArrayBuffer(0));
          if (bytes.byteLength === 0) return;
          try {
            state.data(this, bytes);
          } catch (error) {
            queueMicrotask(() => { throw error; });
          }
          return;
        }
        if (event?.type === "end" || event?.type === "error") {
          terminalFdListeners().delete(resource.watchId);
          resource.watchId = 0;
          notifyTerminalExit(this, 0, null);
        }
      });
      terminalFinalizer?.register(this, resource, resource);
    } catch (error) {
      terminalStates.delete(this);
      closeTerminalResource(resource);
      throw error;
    }
  }

  get closed() {
    return terminalState(this).closed;
  }

  set closed(_) {
    throw new TypeError("Terminal.closed is read-only");
  }

  get inputFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 0) ?? 0);
  }

  set inputFlags(value) {
    this.#setFlags(0, value);
  }

  get outputFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 1) ?? 0);
  }

  set outputFlags(value) {
    this.#setFlags(1, value);
  }

  get localFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 2) ?? 0);
  }

  set localFlags(value) {
    this.#setFlags(2, value);
  }

  get controlFlags() {
    const state = terminalState(this);
    return state.closed ? 0 : Number(cottontail.terminalGetFlags?.(state.resource.masterFd, 3) ?? 0);
  }

  set controlFlags(value) {
    this.#setFlags(3, value);
  }

  #setFlags(kind, value) {
    const state = terminalState(this);
    if (state.closed) return;
    cottontail.terminalSetFlags?.(state.resource.masterFd, kind, Number(value));
  }

  write(data) {
    const state = terminalState(this);
    if (state.closed) throw new Error("Terminal is closed");
    if (data == null || (typeof data !== "string" && !(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data))) {
      throw new TypeError("write() argument must be a string or ArrayBuffer");
    }
    const bytes = typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.byteLength === 0) return 0;
    const written = Number(cottontail.terminalWrite?.(state.resource.writeFd, bytes) ?? -1);
    if (!Number.isInteger(written) || written < 0) throw new Error("Failed to write to terminal");
    if (typeof state.drain === "function") {
      queueMicrotask(() => {
        try { state.drain(this); } catch (error) { queueMicrotask(() => { throw error; }); }
      });
    }
    return written;
  }

  resize(cols, rows) {
    const state = terminalState(this);
    if (state.closed) throw new Error("Terminal is closed");
    if (typeof cols !== "number" || !Number.isFinite(cols) || cols <= 0 || cols > 0xffff) {
      throw new TypeError("resize() requires valid cols argument");
    }
    if (typeof rows !== "number" || !Number.isFinite(rows) || rows <= 0 || rows > 0xffff) {
      throw new TypeError("resize() requires valid rows argument");
    }
    cottontail.terminalResize?.(state.resource.masterFd, Math.trunc(cols), Math.trunc(rows));
  }

  setRawMode(enabled) {
    const state = terminalState(this);
    if (state.closed) throw new Error("Terminal is closed");
    cottontail.terminalSetRawMode?.(state.resource.masterFd, Boolean(enabled));
  }

  ref() {
    const state = terminalState(this);
    state.referenced = true;
    if (state.resource.watchId) cottontail.fdWatchSetRef?.(state.resource.watchId, true);
  }

  unref() {
    const state = terminalState(this);
    state.referenced = false;
    if (state.resource.watchId) cottontail.fdWatchSetRef?.(state.resource.watchId, false);
  }

  close() {
    const state = terminalState(this);
    if (state.closed) return;
    state.closed = true;
    closeTerminalResource(state.resource);
    terminalFinalizer?.unregister(state.resource);
    notifyTerminalExit(this, 0, null);
  }

  [Symbol.dispose]() {
    this.close();
  }

  async [Symbol.asyncDispose]() {
    this.close();
  }
}

export function setRawMode(fd, enabled) {
  return cottontail.terminalSetRawMode(fd, Boolean(enabled));
}
