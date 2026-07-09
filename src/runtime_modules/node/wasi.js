function makeUnsupportedImport(name) {
  return () => {
    throw new Error(`WASI import ${name} is not implemented in Cottontail yet`);
  };
}

export class WASI {
  constructor(options = {}) {
    this.args = Array.from(options.args ?? [], String);
    this.env = { ...(options.env ?? {}) };
    this.preopens = { ...(options.preopens ?? {}) };
    this.returnOnExit = options.returnOnExit === true;
    this.wasiImport = new Proxy({}, {
      get(target, property) {
        if (typeof property !== "string") return target[property];
        return target[property] ??= makeUnsupportedImport(property);
      },
    });
  }

  getImportObject() {
    return { wasi_snapshot_preview1: this.wasiImport };
  }

  start(instance) {
    const start = instance?.exports?._start;
    if (typeof start !== "function") throw new TypeError("WASI.start requires a WebAssembly.Instance with an _start export");
    const result = start();
    return this.returnOnExit ? Number(result ?? 0) : undefined;
  }

  initialize(instance) {
    const initialize = instance?.exports?._initialize;
    if (typeof initialize === "function") initialize();
  }
}

// COTTONTAIL-COMPAT: node:wasi syscalls - WASI object lifecycle is implemented; syscall imports throw until a native WASI layer is added.

export default { WASI };
