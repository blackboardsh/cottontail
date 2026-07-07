export default class EventEmitter {
  constructor() {
    this._events = new Map();
  }

  on(name, handler) {
    const handlers = this._events.get(name) ?? new Set();
    handlers.add(handler);
    this._events.set(name, handlers);
    return this;
  }

  addListener(name, handler) {
    return this.on(name, handler);
  }

  once(name, handler) {
    const wrapped = (...args) => {
      this.off(name, wrapped);
      handler(...args);
    };
    return this.on(name, wrapped);
  }

  off(name, handler) {
    this._events.get(name)?.delete(handler);
    return this;
  }

  removeListener(name, handler) {
    return this.off(name, handler);
  }

  emit(name, ...args) {
    const handlers = this._events.get(name);
    if (!handlers) return false;
    for (const handler of [...handlers]) handler(...args);
    return true;
  }
}

export { EventEmitter as EventEmitter };
