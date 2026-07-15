const channels = globalThis.__cottontailDiagnosticsChannels ??= new Map();

export class Channel {
  constructor(name) {
    validateChannelName(name);
    this.name = name;
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
    return this._subscribers.delete(callback);
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
  validateChannelName(name);
  let current = channels.get(name);
  if (!current) {
    current = new Channel(name);
    channels.set(name, current);
  }
  return current;
}

function validateChannelName(name) {
  if (typeof name !== "string" && typeof name !== "symbol") {
    throw new TypeError('The "channel" argument must be of type string or symbol');
  }
}

export function hasSubscribers(name) {
  return channel(name).hasSubscribers;
}

export function subscribe(name, callback) {
  validateChannelName(name);
  if (typeof callback !== "function") {
    throw new TypeError('The "subscription" argument must be of type function');
  }
  channel(name).subscribe(callback);
}

export function unsubscribe(name, callback) {
  validateChannelName(name);
  return channel(name).unsubscribe(callback);
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
