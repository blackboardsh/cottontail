const channels = globalThis.__cottontailDiagnosticsChannels ??= new Map();

export class Channel {
  constructor(name) {
    this.name = String(name);
    this._subscribers = new Set();
  }

  get hasSubscribers() {
    return this._subscribers.size > 0;
  }

  subscribe(callback) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    this._subscribers.add(callback);
  }

  unsubscribe(callback) {
    this._subscribers.delete(callback);
  }

  publish(message) {
    for (const subscriber of [...this._subscribers]) subscriber(message, this.name);
  }

  bindStore(store, transform = undefined) {
    return transform ? transform(store) : store;
  }

  unbindStore(store) {
    return store;
  }

  runStores(context, fn, thisArg = undefined, ...args) {
    return fn.apply(thisArg, args);
  }
}

export function channel(name) {
  const key = String(name);
  let current = channels.get(key);
  if (!current) {
    current = new Channel(key);
    channels.set(key, current);
  }
  return current;
}

export function hasSubscribers(name) {
  return channel(name).hasSubscribers;
}

export function subscribe(name, callback) {
  channel(name).subscribe(callback);
}

export function unsubscribe(name, callback) {
  channel(name).unsubscribe(callback);
}

export function tracingChannel(nameOrChannels) {
  const names = typeof nameOrChannels === "string"
    ? {
      start: `${nameOrChannels}:start`,
      end: `${nameOrChannels}:end`,
      asyncStart: `${nameOrChannels}:asyncStart`,
      asyncEnd: `${nameOrChannels}:asyncEnd`,
      error: `${nameOrChannels}:error`,
    }
    : nameOrChannels;
  const result = {};
  for (const [key, value] of Object.entries(names ?? {})) result[key] = channel(value);
  result.traceSync = (fn, context = undefined, thisArg = undefined, ...args) => {
    result.start?.publish(context);
    try {
      const value = fn.apply(thisArg, args);
      result.end?.publish(context);
      return value;
    } catch (error) {
      result.error?.publish(error);
      throw error;
    }
  };
  result.tracePromise = async (fn, context = undefined, thisArg = undefined, ...args) => {
    result.asyncStart?.publish(context);
    try {
      const value = await fn.apply(thisArg, args);
      result.asyncEnd?.publish(context);
      return value;
    } catch (error) {
      result.error?.publish(error);
      throw error;
    }
  };
  result.traceCallback = result.traceSync;
  return result;
}

export default { Channel, channel, hasSubscribers, subscribe, tracingChannel, unsubscribe };
