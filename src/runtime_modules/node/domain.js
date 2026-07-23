import { EventEmitter } from "./events.js";

export const _stack = [];
export let active = null;

function setActive(domain) {
  active = domain ?? _stack[_stack.length - 1] ?? null;
  if (globalThis.process) globalThis.process.domain = active;
}

function clearDomainStack() {
  _stack.length = 0;
  setActive(null);
}

export class Domain extends EventEmitter {
  constructor() {
    super();
    this.members = [];
  }

  enter() {
    _stack.push(this);
    setActive(this);
    return this;
  }

  exit() {
    const index = _stack.lastIndexOf(this);
    if (index >= 0) _stack.splice(index);
    setActive(null);
    return this;
  }

  add(emitter) {
    if (!emitter || this.members.includes(emitter)) return emitter;
    this.members.push(emitter);
    const handler = (error) => this.emit("error", error);
    emitter.__cottontailDomainErrorHandler = handler;
    emitter.on?.("error", handler);
    return emitter;
  }

  remove(emitter) {
    this.members = this.members.filter((item) => item !== emitter);
    if (emitter?.__cottontailDomainErrorHandler) {
      emitter.off?.("error", emitter.__cottontailDomainErrorHandler);
      delete emitter.__cottontailDomainErrorHandler;
    }
    return emitter;
  }

  bind(callback) {
    if (typeof callback !== "function") throw new TypeError("domain.bind requires a function");
    const domain = this;
    return function bound(...args) {
      domain.enter();
      try {
        return callback.apply(this, args);
      } catch (error) {
        if (domain._errorHandler(error)) return undefined;
        throw error;
      } finally {
        if (_stack.includes(domain)) domain.exit();
      }
    };
  }

  intercept(callback) {
    if (typeof callback !== "function") throw new TypeError("domain.intercept requires a function");
    return (error, ...args) => {
      if (error) {
        this.emit("error", error);
        return undefined;
      }
      return this.run(callback, ...args);
    };
  }

  run(callback, ...args) {
    this.enter();
    try {
      return callback(...args);
    } catch (error) {
      if (this._errorHandler(error)) return undefined;
      throw error;
    } finally {
      if (_stack.includes(this)) this.exit();
    }
  }

  _errorHandler(error) {
    try {
      if ((typeof error === "object" && error !== null) || typeof error === "function") {
        Object.defineProperties(error, {
          domain: { value: this, configurable: true, writable: true },
          domainThrown: { value: true, configurable: true, writable: true },
        });
      }
    } catch {}

    while (active === this) this.exit();
    let caught = false;
    if (this.listenerCount("error") > 0) {
      try {
        caught = this.emit("error", error);
      } catch (nextError) {
        const parent = active;
        if (parent && parent !== this && typeof parent._errorHandler === "function") {
          return parent._errorHandler(nextError);
        }
        clearDomainStack();
        throw nextError;
      }
    }
    clearDomainStack();
    return caught;
  }

  dispose() {
    for (const member of [...this.members]) this.remove(member);
    this.removeAllListeners();
    this.exit();
  }
}

export function create() {
  return new Domain();
}

export const createDomain = create;

export default { Domain, _stack, active, create, createDomain };
