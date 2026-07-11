import { _wrapAsyncCallback } from "./async_hooks.js";

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
const nativeSetInterval = globalThis.setInterval.bind(globalThis);
const nativeClearInterval = globalThis.clearInterval.bind(globalThis);
const promisifyCustom = Symbol.for("nodejs.util.promisify.custom");

export function setTimeout(callback, delay = 0, ...args) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  return nativeSetTimeout(_wrapAsyncCallback(callback), delay, ...args);
}

export function clearTimeout(handle) {
  return nativeClearTimeout(handle);
}

export function setInterval(callback, delay = 0, ...args) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  return nativeSetInterval(_wrapAsyncCallback(callback), delay, ...args);
}

export function clearInterval(handle) {
  return nativeClearInterval(handle);
}

export function setImmediate(callback, ...args) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  return setTimeout(callback, 0, ...args);
}

export function clearImmediate(handle) {
  return clearTimeout(handle);
}

export const promises = {
  setTimeout(delay = 1, value = undefined, options = undefined) {
    return new Promise((resolve, reject) => {
      if (options?.signal?.aborted) {
        reject(options.signal.reason ?? new Error("AbortError"));
        return;
      }
      const handle = setTimeout(() => resolve(value), delay);
      options?.signal?.addEventListener?.("abort", () => {
        clearTimeout(handle);
        reject(options.signal.reason ?? new Error("AbortError"));
      }, { once: true });
    });
  },
  setImmediate(value = undefined, options = undefined) {
    return promises.setTimeout(0, value, options);
  },
  async *setInterval(delay = 1, value = undefined, options = undefined) {
    while (!options?.signal?.aborted) {
      yield await promises.setTimeout(delay, value, options);
    }
  },
  scheduler: {
    wait(delay = 1, options = undefined) {
      return promises.setTimeout(delay, undefined, options);
    },
    yield() {
      return promises.setImmediate();
    },
  },
};

Object.defineProperty(setTimeout, promisifyCustom, {
  value: promises.setTimeout,
  configurable: true,
});
Object.defineProperty(setImmediate, promisifyCustom, {
  value: promises.setImmediate,
  configurable: true,
});

export default {
  clearImmediate,
  clearInterval,
  clearTimeout,
  promises,
  setImmediate,
  setInterval,
  setTimeout,
};
