function loadFsNamespace(moduleModule) {
  const namespace = moduleModule.loadEmbeddedRuntimeModule("node/fs.js");
  return namespace?.default ?? namespace;
}

function fastWriteSync(fd, data, offset = undefined, length = undefined, position = null) {
  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const byteLength = view?.byteLength;
  const byteOffset = offset ?? 0;
  const writeLength = length ?? byteLength;
  if (!Number.isInteger(fd) || fd < 0 ||
      !ArrayBuffer.isView(view) ||
      !Number.isInteger(byteOffset) || byteOffset < 0 ||
      !Number.isInteger(writeLength) || writeLength < 0 ||
      byteOffset + writeLength > byteLength ||
      position != null) {
    return undefined;
  }
  if (writeLength === 0) return 0;
  return Number(cottontail.fdWriteAt(fd, view, byteOffset, writeLength, null));
}

function createFastFsFacade(moduleModule) {
  let full;
  const load = () => full ??= loadFsNamespace(moduleModule);
  const writeSync = (...args) => {
    const result = fastWriteSync(...args);
    return result === undefined ? Reflect.apply(load().writeSync, load(), args) : result;
  };
  const target = Object.create(null);
  Object.defineProperty(target, "writeSync", {
    value: writeSync,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return new Proxy(target, {
    get(current, property, receiver) {
      if (Reflect.has(current, property)) return Reflect.get(current, property, receiver);
      return Reflect.get(load(), property, load());
    },
    set(_current, property, value) {
      return Reflect.set(load(), property, value, load());
    },
    has(current, property) {
      return Reflect.has(current, property) || Reflect.has(load(), property);
    },
    ownKeys() {
      return Reflect.ownKeys(load());
    },
    getOwnPropertyDescriptor(current, property) {
      if (property === "default") return undefined;
      return Reflect.getOwnPropertyDescriptor(current, property) ??
        Reflect.getOwnPropertyDescriptor(load(), property);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(load());
    },
  });
}

export function installFastEvalCommonJsBuiltins(moduleModule) {
  const fs = createFastFsFacade(moduleModule);
  moduleModule.__setBuiltinModules({ fs, "node:fs": fs });
}
