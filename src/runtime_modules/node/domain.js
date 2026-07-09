import { EventEmitter } from "./events.js";

export const _stack = [];
export let active = null;

function setActive(domain) {
  active = domain ?? _stack[_stack.length - 1] ?? null;
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
    if (index >= 0) _stack.splice(index, 1);
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
    return (...args) => this.run(callback, ...args);
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
      this.emit("error", error);
      return undefined;
    } finally {
      this.exit();
    }
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
