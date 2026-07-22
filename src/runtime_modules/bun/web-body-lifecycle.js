export function bodyStreamIsDisturbed(stream) {
  return stream?._disturbed === true ||
    stream?.readableDidRead === true ||
    stream?.readableAborted === true;
}

export function bodyWasUsed(owner) {
  return owner._bodyUsed === true ||
    bodyStreamIsDisturbed(owner._bodyStream) ||
    bodyStreamIsDisturbed(owner._body);
}

export function bodyValueForConsumption(owner, isStreamingBody) {
  const body = owner._body;
  const exposed = owner._bodyStream;
  if (exposed == null) return body;
  if (isStreamingBody(body)) return exposed;
  if (!exposed.locked) {
    try {
      exposed.cancel()?.catch?.(() => {});
    } catch {}
  }
  return body;
}

export function takeBody(owner, isStreamingBody) {
  if (owner._bodyStream?.locked) throw new TypeError("ReadableStream is locked");
  if (bodyWasUsed(owner)) throw new TypeError("Body already used");
  const body = bodyValueForConsumption(owner, isStreamingBody);
  if (body != null) owner._bodyUsed = true;
  return body;
}

function consumedByteLength(value) {
  if (value == null) return 0;
  if (typeof value.byteLength === "number") return value.byteLength;
  if (typeof value.length === "number") return value.length;
  return new TextEncoder().encode(String(value)).byteLength;
}

export function bodyStreamFor(owner, createReadableStream, isStreamingBody, startBodyConsumption) {
  if (owner._bodyStream !== undefined) return owner._bodyStream;

  const sourceBody = owner._body;
  const stream = createReadableStream(sourceBody);
  owner._bodyStream = stream;
  if (!stream) return stream;

  owner._bodyLocksUse ??= !isStreamingBody(sourceBody);
  const startBody = () => startBodyConsumption(sourceBody);
  const getReader = stream.getReader?.bind(stream);
  if (getReader) {
    stream.getReader = (...args) => {
      startBody();
      let reader;
      try {
        reader = getReader(...args);
      } catch (error) {
        if (stream.locked) throw new TypeError("ReadableStream is locked");
        throw error;
      }
      if (owner._bodyLocksUse) owner._bodyUsed = true;
      const read = reader.read.bind(reader);
      reader.read = (...readArgs) => {
        owner._bodyUsed = true;
        const result = read(...readArgs);
        if (typeof owner._bodyConsumedBytes !== "number") return result;
        return result.then(item => {
          owner._bodyConsumedBytes += consumedByteLength(item?.value);
          return item;
        });
      };
      return reader;
    };
  }

  const asyncIterator = stream[Symbol.asyncIterator]?.bind(stream);
  if (asyncIterator) {
    stream[Symbol.asyncIterator] = (...args) => {
      let iterator;
      let started = false;
      const start = () => {
        if (started) return;
        started = true;
        startBody();
        owner._bodyUsed = true;
        iterator = asyncIterator(...args);
      };
      return {
        next(...nextArgs) {
          start();
          return iterator.next(...nextArgs);
        },
        return(...returnArgs) {
          if (!started) return Promise.resolve({ value: returnArgs[0], done: true });
          return iterator.return?.(...returnArgs) ?? Promise.resolve({ value: returnArgs[0], done: true });
        },
        throw(...throwArgs) {
          start();
          if (typeof iterator.throw === "function") return iterator.throw(...throwArgs);
          return Promise.reject(throwArgs[0]);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  }

  return stream;
}

const fetchBodyFinalizerStates = new WeakMap();
const fetchBodyFinalizer = typeof FinalizationRegistry === "function"
  ? new FinalizationRegistry((held) => {
      if (held?.consumed) return;
      const cleanup = held?.cleanup;
      try {
        if (typeof cleanup === "function") cleanup();
        else {
          const cancellation = cleanup?.cancel?.();
          cancellation?.catch?.(() => {});
        }
      } catch {}
    })
  : null;

export function registerFetchBodyFinalizer(response, body, cleanupSymbol) {
  if (!response || !body || typeof body.cancel !== "function") return;
  const state = {
    cleanup: body[cleanupSymbol] ?? body,
    consumed: false,
  };
  fetchBodyFinalizerStates.set(body, state);
  fetchBodyFinalizer?.register(response, state, body);
}

export function markFetchBodyConsumed(body) {
  const state = body && fetchBodyFinalizerStates.get(body);
  if (!state) return;
  state.consumed = true;
  // Once a consumer owns the stream, the response finalizer must not retain
  // its transport cleanup closure until a later GC/finalization turn.
  fetchBodyFinalizer?.unregister(body);
  fetchBodyFinalizerStates.delete(body);
}
