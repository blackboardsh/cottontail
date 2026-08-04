export function createRequestResponseRuntime({
  activeServeRequestBodyStateSymbol,
  asBuffer,
  bodyStreamIsDisturbed,
  bodyWasUsed,
  bunInspectPropertyDescriptor,
  concatManyBuffers,
  CookieMap,
  ctInspectSymbol,
  estimatedMemoryCostSymbol,
  handledRejectedPromise,
  isAbortSignal,
  isBunFileLike,
  isStreamingBody,
  lifecycleBodyStreamFor,
  lifecycleBodyValueForConsumption,
  lifecycleTakeBody,
  nodeInspect,
  randomBytes,
  serveUpgradeContexts,
  URL,
  URLSearchParams,
}) {
  function sharedArrayBufferBytes(data) {
    if (typeof SharedArrayBuffer !== "function" || !(data instanceof SharedArrayBuffer)) return null;
    // Creating a view over an empty SharedArrayBuffer trips a host bug
    // ("Buffer is already detached"); avoid touching it.
    if (data.byteLength === 0) return new Uint8Array(0);
    const copy = new Uint8Array(data.byteLength);
    copy.set(new Uint8Array(data));
    return copy;
  }
  
  function bytesFromData(data) {
    if (data == null) return new Uint8Array(0);
    const sharedCopy = sharedArrayBufferBytes(data);
    if (sharedCopy) return sharedCopy;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new TextEncoder().encode(String(data));
  }
  
  function snapshotBufferSource(data) {
    const sharedCopy = sharedArrayBufferBytes(data);
    if (sharedCopy) return new Blob([sharedCopy]);
    const source = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Blob([source]);
  }
  
  const fetchBodyStartSymbol = Symbol("cottontail.fetchBodyStart");

  function concatBodyChunks(chunks) {
    if (chunks.length === 1) return asBuffer(chunks[0]);
    const concatNative = globalThis.cottontail?.concatHttpBodyChunks;
    if (typeof concatNative === "function") {
      return new Uint8Array(concatNative(chunks));
    }
    return concatManyBuffers(chunks);
  }
  
  async function bytesFromBody(body) {
    if (body == null) return new Uint8Array(0);
    body?.[fetchBodyStartSymbol]?.();
    const nativeBufferedBody = body?.[activeServeRequestBodyStateSymbol]?.readAllNative?.(false);
    if (nativeBufferedBody != null) {
      if (!body.locked && typeof body.getReader === "function") body.getReader();
      return asBuffer(new Uint8Array(await nativeBufferedBody));
    }
    const sharedCopy = sharedArrayBufferBytes(body);
    if (sharedCopy) return sharedCopy;
    if (body instanceof Uint8Array) return body;
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (body instanceof FormData) return (await encodeMultipartFormData(body)).bytes;
    // Streams must be consumed through their reader (before the .bytes()
    // shortcut below) so the fetch-spec lock is acquired and retained: after a
    // body is consumed, stream.locked must remain true.
    const iterable = typeof body === "function" ? body() : body;
    if (typeof body.getReader === "function" || (iterable && typeof iterable[Symbol.asyncIterator] === "function")) {
      const chunks = [];
      await consumeStreamingBody(body, (chunk) => chunks.push(asBuffer(chunk)));
      return concatBodyChunks(chunks);
    }
    if (typeof body.bytes === "function") return asBuffer(await body.bytes());
    if (typeof body.arrayBuffer === "function") return new Uint8Array(await body.arrayBuffer());
    if (typeof body.text === "function") return new TextEncoder().encode(await body.text());
    return bytesFromData(body);
  }
  
  let nextBodySinkId = 1;
  
  async function consumeStreamingBody(body, onChunk) {
    if (body && typeof body.getReader === "function") {
      // Per the fetch spec, consuming a body keeps the stream locked: the
      // reader is intentionally never released (stream.locked stays true).
      const reader = body.getReader();
      for (;;) {
        const settled = await reader.read().then(
          (item) => ({ item, error: null }),
          (error) => ({ item: null, error }),
        );
        if (settled.error != null) throw settled.error;
        const item = settled.item;
        if (item.done) return;
        await onChunk(item.value);
      }
    }
  
    const iterable = typeof body === "function" ? body() : body;
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
      throw new TypeError("Expected a streaming response body");
    }
    const iterator = iterable[Symbol.asyncIterator]();
    const controller = {
      sinkId: nextBodySinkId++,
      async write(chunk) {
        await onChunk(chunk);
        return chunk?.byteLength ?? chunk?.length ?? String(chunk ?? "").length;
      },
      flush() {
        return 0;
      },
      async end(chunk = undefined) {
        if (chunk !== undefined) await onChunk(chunk);
      },
    };
    for (;;) {
      const item = await iterator.next(controller);
      if (item.value !== undefined && item.value !== null) await onChunk(item.value);
      if (item.done) return;
    }
  }
  
  async function textFromBody(body) {
    if (body == null) return "";
    if (typeof body === "string") return stripUtf8BOMText(body);
    if (body instanceof Blob) return stripUtf8BOMText(await body.text());
    const nativeBufferedText = body?.[activeServeRequestBodyStateSymbol]?.readAllNative?.(true);
    if (nativeBufferedText != null) {
      if (!body.locked && typeof body.getReader === "function") body.getReader();
      const value = await nativeBufferedText;
      if (typeof value === "string") return stripUtf8BOMText(value);
      return stripUtf8BOMText(new TextDecoder().decode(value));
    }
    return stripUtf8BOMText(new TextDecoder().decode(await bytesFromBody(body)));
  }
  
  const maxBufferedServeBodyBytes = 2 * 1024 * 1024;
  let bufferedServeBodyBytes = 0;
  const bufferedServeBodyWaiters = [];
  
  function releaseBufferedServeBodyWaiters() {
    while (bufferedServeBodyWaiters.length > 0) {
      const waiter = bufferedServeBodyWaiters[0];
      if (bufferedServeBodyBytes !== 0 && bufferedServeBodyBytes + waiter.cost > maxBufferedServeBodyBytes) return;
      bufferedServeBodyWaiters.shift();
      bufferedServeBodyBytes += waiter.cost;
      waiter.resolve();
    }
  }
  
  async function withBufferedServeBody(body, callback) {
    const byteSize = Number(body?.[activeServeRequestBodyStateSymbol]?.byteSize);
    if (!Number.isFinite(byteSize) || byteSize <= 0) return callback();
    const cost = Math.min(maxBufferedServeBodyBytes, byteSize);
    if (bufferedServeBodyWaiters.length > 0 ||
        (bufferedServeBodyBytes !== 0 && bufferedServeBodyBytes + cost > maxBufferedServeBodyBytes)) {
      await new Promise(resolve => {
        bufferedServeBodyWaiters.push({ cost, resolve });
        releaseBufferedServeBodyWaiters();
      });
    } else {
      bufferedServeBodyBytes += cost;
    }
    try {
      return await callback();
    } finally {
      bufferedServeBodyBytes = Math.max(0, bufferedServeBodyBytes - cost);
      releaseBufferedServeBodyWaiters();
    }
  }
  
  function consumeBodyText(owner) {
    if (owner._bodyStream?.locked) return handledRejectedPromise(new TypeError("ReadableStream is locked"));
    if (bodyWasUsed(owner)) return handledRejectedPromise(new TypeError("Body already used"));
    const body = bodyValueForConsumption(owner);
    if (body != null) owner._bodyUsed = true;
    return withBufferedServeBody(body, () => textFromBody(body));
  }
  
  function consumeBodyJson(owner) {
    if (owner._bodyStream?.locked) return handledRejectedPromise(new TypeError("ReadableStream is locked"));
    if (bodyWasUsed(owner)) return handledRejectedPromise(new TypeError("Body already used"));
    const body = bodyValueForConsumption(owner);
    if (body != null) owner._bodyUsed = true;
    return withBufferedServeBody(body, async () => parseBodyJson(await textFromBody(body)));
  }
  
  function bodyReadableStream(body) {
    if (body == null) return null;
    if (typeof body.getReader === "function") return body;
    const iterable = typeof body === "function" ? body() : body;
    if (iterable && typeof iterable[Symbol.asyncIterator] === "function") {
      const iterator = iterable[Symbol.asyncIterator]();
      let pending = null;
      let closed = false;
      let activeChunks = null;
      const queuedChunks = [];
      const sink = {
        sinkId: nextBodySinkId++,
        write(chunk) {
          const target = activeChunks ?? queuedChunks;
          target.push(chunk);
          return chunk?.byteLength ?? chunk?.length ?? String(chunk ?? "").length;
        },
        flush() {
          return 0;
        },
        end(chunk = undefined) {
          if (chunk !== undefined) this.write(chunk);
          closed = true;
          return Promise.resolve();
        },
      };
  
      const nextItem = async (wait) => {
        if (!pending) pending = iterator.next(sink);
        if (wait) {
          const item = await pending;
          pending = null;
          return { settled: true, item };
        }
        let settled = false;
        let item;
        let error;
        pending.then(
          (value) => {
            settled = true;
            item = value;
          },
          (reason) => {
            settled = true;
            error = reason;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!settled) return { settled: false };
        pending = null;
        if (error) throw error;
        return { settled: true, item };
      };
  
      return new globalThis.ReadableStream({
        async pull(controller) {
          if (closed) {
            controller.close();
            return;
          }
          const chunks = queuedChunks.splice(0);
          activeChunks = chunks;
          try {
            for (;;) {
              const result = await nextItem(chunks.length === 0);
              if (!result.settled) break;
              const item = result.item;
              if (item.value !== undefined && item.value !== null) chunks.push(item.value);
              if (item.done) {
                closed = true;
                break;
              }
            }
          } finally {
            activeChunks = null;
          }
          if (chunks.length > 0) controller.enqueue(concatManyBuffers(chunks));
          if (closed) controller.close();
        },
        cancel(reason = undefined) {
          closed = true;
          return iterator.return?.(reason);
        },
      });
    }
    return new globalThis.ReadableStream({
      async start(controller) {
        try {
          const bytes = await bytesFromBody(body);
          if (bytes.byteLength > 0) controller.enqueue(bytes);
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });
  }
  
  function bodyValueForConsumption(owner) {
    return lifecycleBodyValueForConsumption(owner, isStreamingBody);
  }
  
  function bodyStreamFor(owner) {
    const nativeBody = owner?._body;
    if (nativeBody?.[activeServeRequestBodyStateSymbol]) {
      owner._bodyStream ??= nativeBody;
      return owner._bodyStream;
    }
    return lifecycleBodyStreamFor(
      owner,
      bodyReadableStream,
      isStreamingBody,
      sourceBody => sourceBody?.[fetchBodyStartSymbol]?.(),
    );
  }
  
  function arrayBufferFromBytes(bytes) {
    if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  
  const blobBodyCache = new WeakMap();
  const textBodyCache = new WeakMap();
  
  function cachedBlobForBytes(bytes, type = "") {
    let typedCache = blobBodyCache.get(bytes);
    if (!typedCache) {
      typedCache = new Map();
      blobBodyCache.set(bytes, typedCache);
    }
    const key = String(type || "");
    let blob = typedCache.get(key);
    if (!blob) {
      blob = new Blob([arrayBufferFromBytes(bytes)], { type: key });
      typedCache.set(key, blob);
    }
    return blob;
  }
  
  function cachedTextForBytes(bytes) {
    let text = textBodyCache.get(bytes);
    if (text === undefined) {
      text = new TextDecoder().decode(bytes);
      textBodyCache.set(bytes, text);
    }
    return text;
  }
  
  // Bun exposes URLSearchParams.prototype.size as configurable + enumerable.
  if (URLSearchParams?.prototype) {
    const sizeDescriptor = Object.getOwnPropertyDescriptor(URLSearchParams.prototype, "size");
    if (!sizeDescriptor || !sizeDescriptor.configurable || !sizeDescriptor.enumerable) {
      Object.defineProperty(URLSearchParams.prototype, "size", {
        get: sizeDescriptor?.get ?? function size() {
          let count = 0;
          for (const _ of this) count += 1;
          return count;
        },
        enumerable: true,
        configurable: true,
      });
    }
  }
  
  // Bun's non-standard URLSearchParams extensions.
  if (URLSearchParams?.prototype && typeof URLSearchParams.prototype.toJSON !== "function") {
    Object.defineProperties(URLSearchParams.prototype, {
      toJSON: {
        value: function toJSON() {
          const result = {};
          for (const [key, value] of this) {
            if (Object.prototype.hasOwnProperty.call(result, key)) {
              if (Array.isArray(result[key])) result[key].push(value);
              else result[key] = [result[key], value];
            } else {
              result[key] = value;
            }
          }
          return result;
        },
        writable: true,
        configurable: true,
      },
      length: {
        get() {
          let count = 0;
          for (const _ of this) count += 1;
          return count;
        },
        configurable: true,
      },
      [Symbol.for("nodejs.util.inspect.custom")]: {
        value: function inspect() {
          const entries = Object.entries(this.toJSON());
          if (entries.length === 0) return "URLSearchParams {}";
          const lines = entries.map(([key, value]) => {
            const rendered = Array.isArray(value)
              ? `[ ${value.map((item) => JSON.stringify(item)).join(", ")} ]`
              : JSON.stringify(value);
            return `  ${JSON.stringify(key)}: ${rendered},`;
          });
          return `URLSearchParams {\n${lines.join("\n")}\n}`;
        },
        writable: true,
        configurable: true,
      },
    });
  }
  
  // Bun prints URL objects as an expanded property list (see url.test.ts).
  if (URL?.prototype && !URL.prototype[Symbol.for("nodejs.util.inspect.custom")]) {
    Object.defineProperty(URL.prototype, Symbol.for("nodejs.util.inspect.custom"), {
      value: function inspect() {
        const searchParamsText = String(
          this.searchParams?.[Symbol.for("nodejs.util.inspect.custom")]?.() ?? this.searchParams,
        ).replace(/\n/g, "\n  ");
        return [
          "URL {",
          `  href: ${JSON.stringify(this.href)},`,
          `  origin: ${JSON.stringify(this.origin)},`,
          `  protocol: ${JSON.stringify(this.protocol)},`,
          `  username: ${JSON.stringify(this.username)},`,
          `  password: ${JSON.stringify(this.password)},`,
          `  host: ${JSON.stringify(this.host)},`,
          `  hostname: ${JSON.stringify(this.hostname)},`,
          `  port: ${JSON.stringify(this.port)},`,
          `  pathname: ${JSON.stringify(this.pathname)},`,
          `  hash: ${JSON.stringify(this.hash)},`,
          `  search: ${JSON.stringify(this.search)},`,
          `  searchParams: ${searchParamsText},`,
          "  toJSON: [Function: toJSON],",
          "  toString: [Function: toString],",
          "}",
        ].join("\n");
      },
      writable: true,
      configurable: true,
    });
  }
  
  if (URL?.prototype && !Object.getOwnPropertyDescriptor(URL.prototype, estimatedMemoryCostSymbol)) {
    Object.defineProperty(URL.prototype, estimatedMemoryCostSymbol, {
      configurable: true,
      get() {
        return 128 + String(this.href ?? "").length;
      },
    });
  }
  
  if (URLSearchParams?.prototype &&
      !Object.getOwnPropertyDescriptor(URLSearchParams.prototype, estimatedMemoryCostSymbol)) {
    Object.defineProperty(URLSearchParams.prototype, estimatedMemoryCostSymbol, {
      configurable: true,
      get() {
        return 128 + String(this).length;
      },
    });
  }
  
  class Headers {
    constructor(init = undefined) {
      this._values = new Map();
      this._allValues = new Map();
      if (init === undefined) return;
      // WebIDL HeadersInit: primitives (including null and strings) throw.
      if (init === null || (typeof init !== "object" && typeof init !== "function")) {
        throw new TypeError("Headers can only be constructed from an object or an iterable of [name, value] pairs");
      }
      if (init instanceof Headers) {
        // Copy from the internal map to preserve original header casing.
        for (const [normalized, entry] of init._values) {
          if (normalized === "set-cookie") {
            for (const value of init._allValues.get(normalized) ?? []) this.append(entry.key, value);
          } else {
            this.append(entry.key, entry.value);
          }
        }
        return;
      }
      // Per WebIDL, Symbol.iterator is read exactly once: a defined but
      // non-callable iterator is a TypeError, undefined selects the record path.
      const iteratorMethod = init[Symbol.iterator];
      if (iteratorMethod !== undefined) {
        if (typeof iteratorMethod !== "function") {
          throw new TypeError("Headers init is not iterable");
        }
        const iterator = iteratorMethod.call(init);
        for (;;) {
          const step = iterator.next();
          if (step.done) break;
          const entry = step.value;
          if (entry === null || (typeof entry !== "object" && typeof entry !== "function")) {
            throw new TypeError("Headers sequence must contain [name, value] pairs");
          }
          const pair = Array.isArray(entry) ? entry : Array.from(entry);
          if (pair.length !== 2) {
            throw new TypeError("Headers sequence must contain [name, value] pairs");
          }
          this.append(pair[0], pair[1]);
        }
        return;
      }
      // record<ByteString, ByteString>: own enumerable properties; symbol keys
      // cannot convert to ByteString and throw.
      for (const key of Reflect.ownKeys(init)) {
        const descriptor = Object.getOwnPropertyDescriptor(init, key);
        if (!descriptor || !descriptor.enumerable) continue;
        if (typeof key === "symbol") {
          throw new TypeError("Header name must be a string");
        }
        this.append(key, init[key]);
      }
    }
    getSetCookie() {
      return [...(this._allValues.get("set-cookie") ?? [])];
    }
    append(key, value) {
      if (arguments.length < 2) {
        throw new TypeError(`Headers.append requires 2 arguments, received ${arguments.length}`);
      }
      const name = headerNameToString(key);
      validateHeaderName(name);
      const stringValue = normalizeHeaderValueText(headerValueToString(value, name));
      validateHeaderValue(stringValue, name);
      const normalized = name.toLowerCase();
      const existing = this._values.get(normalized);
      const allValues = this._allValues.get(normalized) ?? [];
      allValues.push(stringValue);
      this._allValues.set(normalized, allValues);
      // Per the fetch spec, cookie is the only header whose values combine with
      // "; " instead of ", " when appended.
      const separator = normalized === "cookie" ? "; " : ", ";
      this._values.set(normalized, {
        key: existing?.key ?? name,
        value: existing ? `${existing.value}${separator}${stringValue}` : stringValue,
      });
    }
    set(key, value) {
      if (arguments.length < 2) {
        throw new TypeError(`Headers.set requires 2 arguments, received ${arguments.length}`);
      }
      const name = headerNameToString(key);
      validateHeaderName(name);
      const stringValue = normalizeHeaderValueText(headerValueToString(value, name));
      validateHeaderValue(stringValue, name);
      const normalized = name.toLowerCase();
      this._allValues.set(normalized, [stringValue]);
      this._values.set(normalized, { key: name, value: stringValue });
    }
    get(key) {
      if (arguments.length < 1) {
        throw new TypeError("Headers.get requires 1 argument, received 0");
      }
      const name = headerNameToString(key);
      validateHeaderName(name);
      return this._values.get(name.toLowerCase())?.value ?? null;
    }
    getAll(key) {
      if (arguments.length < 1) {
        throw new TypeError("Headers.getAll requires 1 argument, received 0");
      }
      const normalized = headerNameToString(key).toLowerCase();
      if (normalized !== "set-cookie") {
        throw new TypeError('getAll() can only be used with the "Set-Cookie" header');
      }
      return [...(this._allValues.get(normalized) ?? [])];
    }
    has(key) {
      if (arguments.length < 1) {
        throw new TypeError("Headers.has requires 1 argument, received 0");
      }
      const name = headerNameToString(key);
      validateHeaderName(name);
      return this._values.has(name.toLowerCase());
    }
    delete(key) {
      if (arguments.length < 1) {
        throw new TypeError("Headers.delete requires 1 argument, received 0");
      }
      const name = headerNameToString(key);
      validateHeaderName(name);
      const normalized = name.toLowerCase();
      this._allValues.delete(normalized);
      this._values.delete(normalized);
    }
    _sortedEntries() {
      const entries = [];
      const setCookies = [];
      for (const [normalized, entry] of this._values) {
        if (normalized === "set-cookie") {
          for (const value of this._allValues.get(normalized) ?? []) setCookies.push([normalized, value]);
        } else {
          entries.push([normalized, entry.value]);
        }
      }
      entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      // Bun (WebCore FetchHeaders) iterates set-cookie entries after all other
      // headers, in insertion order.
      entries.push(...setCookies);
      return entries;
    }
    forEach(callback, thisArg = undefined) {
      if (typeof callback !== "function") {
        throw new TypeError("Headers.forEach requires the callback to be a function");
      }
      for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }
    toJSON() {
      const result = {};
      const entries = [...this._values.entries()]
        .map(([normalized, { value }]) => [
          normalized,
          normalized === "set-cookie" ? [...(this._allValues.get(normalized) ?? [])] : value,
        ])
        .sort(([left], [right]) => left.localeCompare(right));
      for (const [key, value] of entries) result[key] = value;
      return result;
    }
    // Iteration is live per the fetch spec: each step re-reads the sorted and
    // combined header list rather than iterating over a snapshot.
    *entries() {
      for (let index = 0; ; index += 1) {
        const snapshot = this._sortedEntries();
        if (index >= snapshot.length) return;
        yield snapshot[index];
      }
    }
    *keys() {
      for (const [key] of this.entries()) yield key;
    }
    *values() {
      for (const [, value] of this.entries()) yield value;
    }
    get count() {
      const setCookies = this._allValues.get("set-cookie")?.length ?? 0;
      return this._values.size + Math.max(0, setCookies - 1);
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    get [estimatedMemoryCostSymbol]() {
      let size = 128;
      for (const [key, value] of this.entries()) size += key.length + value.length + 32;
      return size;
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      const entries = [];
      for (const [normalized, entry] of this._values) {
        if (normalized === "set-cookie") {
          for (const value of this._allValues.get(normalized) ?? []) entries.push([normalized, value]);
        } else {
          entries.push([normalized, entry.value]);
        }
      }
      if (entries.length === 0) return "Headers {}";
      // Bun lists well-known header names before custom ones, each entry with a
      // trailing comma.
      const known = entries.filter(([key]) => wellKnownHeaderNames.has(key));
      const custom = entries.filter(([key]) => !wellKnownHeaderNames.has(key));
      const lines = [...known, ...custom].map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
      return `Headers {\n${lines.join("\n")}\n}`;
    }
  }
  
  Object.defineProperty(Headers.prototype, Symbol.toStringTag, {
    value: "Headers",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  
  const wellKnownHeaderNames = new Set([
    "accept", "accept-charset", "accept-encoding", "accept-language", "accept-ranges",
    "access-control-allow-credentials", "access-control-allow-headers", "access-control-allow-methods",
    "access-control-allow-origin", "access-control-expose-headers", "access-control-max-age",
    "access-control-request-headers", "access-control-request-method", "age", "allow", "authorization",
    "cache-control", "connection", "content-disposition", "content-encoding", "content-language",
    "content-length", "content-location", "content-range", "content-security-policy", "content-type",
    "cookie", "date", "etag", "expect", "expires", "forwarded", "from", "host", "if-match",
    "if-modified-since", "if-none-match", "if-range", "if-unmodified-since", "last-modified", "link",
    "location", "max-forwards", "origin", "pragma", "proxy-authenticate", "proxy-authorization",
    "range", "referer", "referrer-policy", "refresh", "retry-after", "sec-websocket-accept",
    "sec-websocket-extensions", "sec-websocket-key", "sec-websocket-protocol", "sec-websocket-version",
    "server", "set-cookie", "strict-transport-security", "te", "trailer", "transfer-encoding",
    "upgrade", "upgrade-insecure-requests", "user-agent", "vary", "via", "warning", "www-authenticate",
    "x-content-type-options", "x-frame-options", "x-requested-with", "x-xss-protection",
  ]);
  
  // Header validation is deliberately regex-free: user code can sabotage
  // RegExp.prototype.exec (which `.test()` consults) and Headers must still work.
  const invalidHeaderErrorSymbol = Symbol("cottontail.invalidHeader");
  
  function invalidHeaderError(message) {
    const error = new TypeError(message);
    Object.defineProperty(error, invalidHeaderErrorSymbol, { value: true });
    return error;
  }
  
  function headerNameToString(name) {
    if (typeof name === "symbol") throw new TypeError("Header name must be a string");
    return String(name);
  }
  
  function headerValueToString(value, name) {
    if (typeof value === "symbol") throw new TypeError(`Header "${name}" value must be a string`);
    return String(value);
  }
  
  // HTTP token code points per RFC 9110.
  function isHeaderTokenCode(code) {
    if (code >= 0x30 && code <= 0x39) return true; // 0-9
    if (code >= 0x41 && code <= 0x5a) return true; // A-Z
    if (code >= 0x61 && code <= 0x7a) return true; // a-z
    switch (code) {
      case 0x21: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27:
      case 0x2a: case 0x2b: case 0x2d: case 0x2e: case 0x5e: case 0x5f:
      case 0x60: case 0x7c: case 0x7e:
        return true;
      default:
        return false;
    }
  }
  
  function validateHeaderName(nameText) {
    if (nameText.length === 0) {
      throw invalidHeaderError(`Invalid header name: '${nameText}'`);
    }
    for (let index = 0; index < nameText.length; index += 1) {
      if (!isHeaderTokenCode(nameText.charCodeAt(index))) {
        throw invalidHeaderError(`Invalid header name: '${nameText}'`);
      }
    }
  }
  
  function isHeaderWhitespaceCode(code) {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
  }
  
  // Strip leading/trailing HTTP whitespace per the fetch spec value normalize.
  function normalizeHeaderValueText(valueText) {
    let start = 0;
    let end = valueText.length;
    while (start < end && isHeaderWhitespaceCode(valueText.charCodeAt(start))) start += 1;
    while (end > start && isHeaderWhitespaceCode(valueText.charCodeAt(end - 1))) end -= 1;
    return start === 0 && end === valueText.length ? valueText : valueText.slice(start, end);
  }
  
  function validateHeaderValue(valueText, nameText) {
    for (let index = 0; index < valueText.length; index += 1) {
      const code = valueText.charCodeAt(index);
      if (code === 0x00 || code === 0x0a || code === 0x0d || code > 0xff) {
        throw invalidHeaderError(`Header value is not valid. Header '${nameText}' has invalid value: '${valueText}'`);
      }
    }
  }
  
  function headersGetAll(name) {
    const normalized = String(name).toLowerCase();
    if (normalized === "set-cookie" && typeof this.getSetCookie === "function") return this.getSetCookie();
    const value = this.get?.(name);
    return value == null ? [] : [String(value)];
  }
  
  class FormData {
    constructor() {
      this._entries = [];
    }
    append(name, value, filename = undefined) {
      if (arguments.length < 2) {
        throw new TypeError(`FormData.append requires at least 2 arguments, received ${arguments.length}`);
      }
      this._entries.push(makeFormDataEntry(name, value, filename));
    }
    set(name, value, filename = undefined) {
      if (arguments.length < 2) {
        throw new TypeError(`FormData.set requires at least 2 arguments, received ${arguments.length}`);
      }
      const entry = makeFormDataEntry(name, value, filename);
      this.delete(entry[0]);
      this._entries.push(entry);
    }
    get length() {
      return this._entries.length;
    }
    get(name) {
      const key = String(name);
      const found = this._entries.find((entry) => entry[0] === key);
      return found ? found[1] : null;
    }
    getAll(name) {
      const key = String(name);
      return this._entries.filter((entry) => entry[0] === key).map((entry) => entry[1]);
    }
    has(name) {
      const key = String(name);
      return this._entries.some((entry) => entry[0] === key);
    }
    delete(name) {
      const key = String(name);
      this._entries = this._entries.filter((entry) => entry[0] !== key);
    }
    *entries() {
      for (const [key, value] of this._entries) yield [key, value];
    }
    *keys() {
      for (const [key] of this._entries) yield key;
    }
    *values() {
      for (const [, value] of this._entries) yield value;
    }
    forEach(callback, thisArg = undefined) {
      if (typeof callback !== "function") {
        throw new TypeError("FormData.forEach requires the callback to be a function");
      }
      for (const [key, value] of this._entries) callback.call(thisArg, value, key, this);
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    get [estimatedMemoryCostSymbol]() {
      let size = 128;
      for (const [key, value] of this._entries) {
        size += key.length + 64;
        if (typeof value === "string") size += value.length;
        else if (typeof value?.size === "number" && Number.isFinite(value.size)) size += Math.max(0, value.size);
      }
      return size;
    }
    toJSON() {
      const result = {};
      for (const [key, value] of this._entries) {
        const serialized = typeof value === "string"
          ? value
          : { name: typeof value?.name === "string" ? value.name : "", size: value?.size ?? 0 };
        if (Object.hasOwn(result, key)) {
          if (!Array.isArray(result[key])) result[key] = [result[key]];
          result[key].push(serialized);
        } else {
          result[key] = serialized;
        }
      }
      return result;
    }
    static from(data, boundary = undefined) {
      let text;
      let blobBytes = data?._bytes instanceof Uint8Array ? data._bytes : null;
      if (blobBytes === null && data instanceof Blob && typeof data._getBytes === "function") {
        const bytes = data._getBytes();
        if (bytes instanceof Uint8Array) blobBytes = bytes;
        else if (ArrayBuffer.isView(bytes)) {
          blobBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        }
      }
      const byteLength = data instanceof ArrayBuffer
        ? data.byteLength
        : ArrayBuffer.isView(data)
          ? data.byteLength
          : blobBytes !== null
            ? blobBytes.byteLength
            : typeof data === "string" ? data.length : 0;
      const allocationLimit = globalThis.__cottontailSyntheticAllocationLimit ?? 0x7fffffff;
      if (byteLength > allocationLimit) {
        throw new RangeError(`Cannot create a string longer than ${allocationLimit} characters`);
      }
      if (typeof data === "string") text = data;
      else if (data instanceof ArrayBuffer) text = stringLatin1FromBytes(new Uint8Array(data));
      else if (ArrayBuffer.isView(data)) text = stringLatin1FromBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      else if (blobBytes !== null) text = stringLatin1FromBytes(blobBytes);
      else text = String(data);
      if (boundary != null) return parseMultipartFormDataText(text, String(boundary));
      const result = new FormData();
      for (const [key, value] of new URLSearchParams(text)) result.append(key, value);
      return result;
    }
  }
  
  Object.defineProperty(FormData.prototype, Symbol.toStringTag, {
    value: "FormData",
    writable: false,
    enumerable: false,
    configurable: true,
  });
  
  function stringLatin1FromBytes(bytes) {
    let output = "";
    for (const byte of bytes) output += String.fromCharCode(byte);
    return output;
  }
  
  function isBlobLikeFormValue(value) {
    return value != null && typeof value === "object" &&
      typeof value.arrayBuffer === "function" &&
      (value instanceof Blob || typeof value.stream === "function" || typeof value.text === "function");
  }

  // A File whose contents delegate to an underlying blob-like source without
  // eagerly copying it. This is part of the shared Request/FormData runtime so
  // every bootstrap observes the same file-entry behavior.
  let FormDataFileClass = null;
  function formDataFileView(source, filename) {
    FormDataFileClass ??= class File extends globalThis.File {
      constructor(src, name) {
        super([], name, {
          type: typeof src?.type === "string" ? src.type : "",
          lastModified: Number(src?.lastModified ?? 0) || 0,
        });
        this._source = src;
      }
      get size() {
        return Number(this._source?.size ?? 0);
      }
      async arrayBuffer() {
        return await this._source.arrayBuffer();
      }
      async bytes() {
        if (typeof this._source.bytes === "function") return asBuffer(await this._source.bytes());
        return asBuffer(new Uint8Array(await this._source.arrayBuffer()));
      }
      async text() {
        return await this._source.text();
      }
      stream() {
        if (typeof this._source.stream === "function") return this._source.stream();
        return super.stream();
      }
      slice(...args) {
        if (typeof this._source.slice === "function") return this._source.slice(...args);
        return super.slice(...args);
      }
    };
    const name = filename !== undefined
      ? filename
      : (typeof source?.name === "string" && source.name !== "" ? source.name : "blob");
    return new FormDataFileClass(source, name);
  }

  function makeFormDataEntry(name, value, filename) {
    if (typeof name === "symbol") throw new TypeError("FormData field name must be a string");
    const key = String(name);
    if (!isBlobLikeFormValue(value)) {
      if (filename !== undefined) {
        throw new TypeError("The filename argument can only be used when the value is a Blob or File");
      }
      if (typeof value === "symbol") throw new TypeError("FormData field value cannot be a symbol");
      return [key, String(value)];
    }
    if (filename !== undefined) {
      return [key, formDataFileView(value, String(filename))];
    }
    // A Blob keeps its identity (Bun does not wrap it into a File named
    // "blob"); lazy file refs (Bun.file) become Blob-compatible views.
    if (value instanceof Blob) return [key, value];
    return [key, formDataFileView(value, undefined)];
  }
  
  function snapshotFormDataBody(formData) {
    const snapshot = new FormData();
    snapshot._entries = formData._entries.map(([name, value]) => {
      if (typeof value === "string") return [name, value];
      const filename = typeof value?.name === "string" && value.name !== "" ? value.name : "blob";
      let source = value;
      const seen = new Set();
      while (source != null && typeof source === "object" && !seen.has(source)) {
        const nested = source._source ?? source[bodyBlobSourceSymbol];
        if (nested == null) break;
        seen.add(source);
        source = nested;
      }
      if (typeof source?._bunFilePath === "string" &&
          !Array.isArray(source._blobChunks) && cottontail.existsSync(source._bunFilePath)) {
        let bytes = asBuffer(cottontail.readFileBuffer(source._bunFilePath));
        const start = Number(source._bunFileStart);
        const end = Number(source._bunFileEnd);
        if (Number.isFinite(start) && Number.isFinite(end)) {
          bytes = bytes.subarray(
            Math.max(0, Math.min(bytes.byteLength, start)),
            Math.max(0, Math.min(bytes.byteLength, end)),
          );
        }
        source = new Blob([bytes], { type: typeof value?.type === "string" ? value.type : "" });
      }
      return [name, formDataFileView(source, filename)];
    });
    if (formData._boundary != null) snapshot._boundary = formData._boundary;
    return snapshot;
  }
  
  const bodyBlobSourceSymbol = Symbol("cottontail.bodyBlobSource");
  const bodyBlobSlice = Blob.prototype.slice;
  let BodyBlobViewClass = null;
  
  function lazyBlobBodyView(source) {
    BodyBlobViewClass ??= class Blob extends globalThis.Blob {
      constructor(value) {
        super([], { type: typeof value?.type === "string" ? value.type : "" });
        Object.defineProperty(this, bodyBlobSourceSymbol, { value });
      }
      get size() {
        return Number(this[bodyBlobSourceSymbol]?.size ?? 0);
      }
      get name() {
        return this[bodyBlobSourceSymbol]?.name;
      }
      get lastModified() {
        return this[bodyBlobSourceSymbol]?.lastModified;
      }
      get fd() {
        return this[bodyBlobSourceSymbol]?.fd;
      }
      get _bunFilePath() {
        return this[bodyBlobSourceSymbol]?._bunFilePath;
      }
      get _bunFileStart() {
        return this[bodyBlobSourceSymbol]?._bunFileStart;
      }
      get _bunFileEnd() {
        return this[bodyBlobSourceSymbol]?._bunFileEnd;
      }
      async arrayBuffer() {
        return await this[bodyBlobSourceSymbol].arrayBuffer();
      }
      async bytes() {
        const source = this[bodyBlobSourceSymbol];
        if (typeof source.bytes === "function") return asBuffer(await source.bytes());
        return asBuffer(new Uint8Array(await source.arrayBuffer()));
      }
      async text() {
        return await this[bodyBlobSourceSymbol].text();
      }
      stream() {
        const source = this[bodyBlobSourceSymbol];
        return typeof source.stream === "function" ? source.stream() : super.stream();
      }
      slice(...args) {
        const source = this[bodyBlobSourceSymbol];
        return typeof source.slice === "function" ? source.slice(...args) : super.slice(...args);
      }
      exists(...args) {
        return this[bodyBlobSourceSymbol].exists(...args);
      }
      writer(...args) {
        return this[bodyBlobSourceSymbol].writer(...args);
      }
      stat(...args) {
        return this[bodyBlobSourceSymbol].stat(...args);
      }
      write(...args) {
        return this[bodyBlobSourceSymbol].write(...args);
      }
      delete(...args) {
        return this[bodyBlobSourceSymbol].delete(...args);
      }
      unlink(...args) {
        return this[bodyBlobSourceSymbol].unlink(...args);
      }
    };
    return new BodyBlobViewClass(source);
  }
  
  const plainBlobBodySnapshots = new WeakMap();

  function snapshotBlobBody(blob) {
    const source = blob?.[bodyBlobSourceSymbol] ?? blob;
    if (source?._source != null) {
      return formDataFileView(source._source, typeof source.name === "string" ? source.name : undefined);
    }
    if (isBunFileLike(source)) return lazyBlobBodyView(source);
    if (typeof globalThis.File === "function" && source instanceof globalThis.File) {
      return new globalThis.File([source], source.name, {
        type: source.type,
        lastModified: source.lastModified,
      });
    }
    if (Object.getPrototypeOf(source) === Blob.prototype) {
      let snapshot = plainBlobBodySnapshots.get(source);
      if (snapshot == null) {
        snapshot = bodyBlobSlice.call(source, 0, source.size, source.type);
        plainBlobBodySnapshots.set(source, snapshot);
        plainBlobBodySnapshots.set(snapshot, snapshot);
      }
      return snapshot;
    }
    return bodyBlobSlice.call(source, 0, source.size, source.type);
  }
  
  function snapshotBodyValue(body) {
    if (body == null) return null;
    if (typeof body === "symbol") throw new TypeError("Cannot convert a symbol to a string");
    if (typeof body === "string") return body;
    if (isURLSearchParamsLike(body)) return serializeURLSearchParamsBody(body);
    if (body instanceof FormData) return snapshotFormDataBody(body);
    if (body instanceof Blob) return snapshotBlobBody(body);
    const isSharedBuffer = typeof SharedArrayBuffer === "function" && body instanceof SharedArrayBuffer;
    if (isSharedBuffer || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      return snapshotBufferSource(body);
    }
    if (isBunFileLike(body) || isStreamingBody(body)) return body;
    if (Array.isArray(body)) {
      for (const part of body) {
        if (typeof part === "symbol") throw new TypeError("Cannot convert a symbol to a string");
      }
      return new Blob(body);
    }
    return String(body);
  }
  
  function formDataBoundary(formData) {
    // Lowercase so the boundary survives Blob type normalization (which
    // lowercases MIME types) when a multipart body round-trips through blob().
    return formData._boundary ??= `----cottontailformboundary${randomBytes(12).toString("hex")}`;
  }
  
  function isURLSearchParamsLike(value) {
    if (value == null || typeof value !== "object") return false;
    if (value instanceof URLSearchParams) return true;
    const GlobalURLSearchParams = globalThis.URLSearchParams;
    return typeof GlobalURLSearchParams === "function" && value instanceof GlobalURLSearchParams;
  }
  
  const urlSearchParamsEntries = URLSearchParams.prototype.entries;
  
  function serializeURLSearchParamsBody(searchParams) {
    let output = "";
    for (const [name, value] of urlSearchParamsEntries.call(searchParams)) {
      if (output !== "") output += "&";
      output += `${formUrlEncodeComponent(name)}=${formUrlEncodeComponent(value)}`;
    }
    return output;
  }
  
  function toWellFormedBodyString(input) {
    const value = String(input);
    let output = null;
    let segmentStart = 0;
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          index += 1;
          continue;
        }
      }
      if (code < 0xd800 || code > 0xdfff) continue;
      output ??= "";
      output += `${value.slice(segmentStart, index)}\ufffd`;
      segmentStart = index + 1;
    }
    return output == null ? value : output + value.slice(segmentStart);
  }
  
  function formUrlEncodeComponent(value) {
    const text = String(value);
    // COTTONTAIL-COMPAT: Avoid copying large ASCII form fields when every byte is
    // already in the application/x-www-form-urlencoded percent-encode set.
    if (/^[A-Za-z0-9*._-]*$/.test(text)) return text;
    let encoded = encodeURIComponent(toWellFormedBodyString(text)).replaceAll("%20", "+");
    if (/[!'()~]/.test(encoded)) {
      encoded = encoded.replace(/[!'()~]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase()}`
      );
    }
    return encoded;
  }
  
  (function patchURLSearchParamsSerialization() {
    const proto = URLSearchParams?.prototype;
    const entries = proto?.entries;
    if (!proto || typeof entries !== "function" || proto.toString?.__cottontailFastFormEncoding) return;
    const toString = function toString() {
      let output = "";
      for (const [name, value] of entries.call(this)) {
        if (output !== "") output += "&";
        output += `${formUrlEncodeComponent(name)}=${formUrlEncodeComponent(value)}`;
      }
      return output;
    };
    toString.__cottontailFastFormEncoding = true;
    Object.defineProperty(proto, "toString", { value: toString, writable: true, configurable: true });
  })();
  
  function parseBodyJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      throw new SyntaxError("Failed to parse JSON");
    }
  }
  
  // Fill in the fetch-spec default Content-Type for bodies that imply one.
  function setDefaultBodyContentType(headers, body) {
    if (body == null || headers.has("content-type")) return;
    if (body instanceof FormData) {
      headers.set("Content-Type", `multipart/form-data; boundary=${formDataBoundary(body)}`);
    } else if (isURLSearchParamsLike(body)) {
      headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
    } else if (body instanceof Blob && typeof body.type === "string" && body.type !== "") {
      headers.set("Content-Type", body.type);
    }
  }
  
  // Bun surfaces missing Bun.file() FormData parts as a synchronous ENOENT when
  // the body is attached to a Response/Request.
  function assertFormDataFilesExist(formData) {
    for (const [, value] of formData._entries) {
      let source = value;
      const seen = new Set();
      while (source != null && typeof source === "object" && !seen.has(source)) {
        const nested = source._source ?? source[bodyBlobSourceSymbol];
        if (nested == null) break;
        seen.add(source);
        source = nested;
      }
      if (source != null && typeof source === "object" && typeof source._bunFilePath === "string" &&
          !cottontail.existsSync(source._bunFilePath)) {
        const error = new Error(`ENOENT: no such file or directory, open '${source._bunFilePath}'`);
        error.code = "ENOENT";
        error.errno = -2;
        error.syscall = "open";
        error.path = source._bunFilePath;
        throw error;
      }
    }
  }
  
  function escapeMultipartHeader(value) {
    return String(value).replace(/\r|\n/g, " ").replace(/"/g, "%22");
  }
  
  async function encodeMultipartFormData(formData) {
    const boundary = formDataBoundary(formData);
    const chunks = [];
    for (const [name, value] of formData._entries) {
      const isFilePart = typeof value !== "string";
      let header = `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeader(name)}"`;
      if (isFilePart) {
        const filename = typeof value?.name === "string" && value.name !== "" ? value.name : "blob";
        header += `; filename="${escapeMultipartHeader(filename)}"`;
      }
      header += "\r\n";
      if (isFilePart && value?.type) header += `Content-Type: ${value.type}\r\n`;
      chunks.push(new TextEncoder().encode(`${header}\r\n`));
      chunks.push(await bytesFromBody(value));
      chunks.push(new TextEncoder().encode("\r\n"));
    }
    chunks.push(new TextEncoder().encode(`--${boundary}--\r\n`));
    return { boundary, bytes: concatManyBuffers(chunks) };
  }
  
  function stripUtf8BOMText(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }
  
  function blobTypeFromBodyHeaders(headers) {
    const type = headers.get("content-type") ?? "";
    if (/^(?:text\/|application\/json(?:;|$))/i.test(type)) {
      return `${type.split(";", 1)[0]};charset=utf-8`;
    }
    if (/^application\/(?:xml|javascript|x-www-form-urlencoded)$/i.test(type)) {
      return `${type};charset=utf-8`;
    }
    return type;
  }
  
  // Reinterpret latin1-decoded bytes as UTF-8 when that produces valid text.
  function utf8FromLatin1Text(text) {
    const value = String(text ?? "");
    if (!/[\x80-\xff]/.test(value)) return value;
    const bytes = Buffer.from(value, "latin1");
    const decoded = bytes.toString("utf8");
    return Buffer.from(decoded, "utf8").equals(bytes) ? decoded : value;
  }
  
  async function parseMultipartFormData(body, contentType) {
    const contentTypeText = String(contentType ?? "");
    const parsedContentType = parseParameterizedHeader(contentTypeText);
    if (parsedContentType.value === "application/x-www-form-urlencoded") {
      const text = stripUtf8BOMText(new TextDecoder().decode(await bytesFromBody(body)));
      const result = new FormData();
      for (const [name, value] of new URLSearchParams(text)) result.append(name, value);
      return result;
    }
    if (parsedContentType.value !== "multipart/form-data") {
      throw new TypeError("Body cannot be decoded as form data");
    }
    const boundary = parsedContentType.parameters.get("boundary");
    if (!boundary || /[\r\n]/.test(boundary)) {
      throw new TypeError("Missing multipart boundary");
    }
    // WHATWG aliases "latin1" to windows-1252, so TextDecoder remaps bytes in
    // the 0x80-0x9f range. Multipart parsing needs a lossless byte string.
    const source = stringLatin1FromBytes(await bytesFromBody(body));
    return parseMultipartFormDataText(source, boundary);
  }
  
  function splitHeaderParameters(value) {
    const segments = [];
    let segment = "";
    let quoted = false;
    let escaped = false;
    for (const character of String(value)) {
      if (escaped) {
        segment += character;
        escaped = false;
        continue;
      }
      if (quoted && character === "\\") {
        segment += character;
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = !quoted;
        segment += character;
        continue;
      }
      if (character === ";" && !quoted) {
        segments.push(segment);
        segment = "";
        continue;
      }
      segment += character;
    }
    segments.push(segment);
    return segments;
  }
  
  function unquoteHeaderParameter(value) {
    const text = String(value).trim();
    if (!text.startsWith('"')) return text;
    if (text.length < 2 || !text.endsWith('"')) return undefined;
    let result = "";
    let escaped = false;
    for (const character of text.slice(1, -1)) {
      if (escaped) {
        result += character;
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else {
        result += character;
      }
    }
    if (escaped) result += "\\";
    return result;
  }
  
  function parseParameterizedHeader(value, allowBunExtendedFilename = false) {
    const [rawValue = "", ...rawParameters] = splitHeaderParameters(value);
    const parameters = new Map();
    for (const rawParameter of rawParameters) {
      const parameter = rawParameter.trim();
      let equals = parameter.indexOf("=");
      let name;
      let rawParameterValue;
      if (equals >= 0) {
        name = parameter.slice(0, equals).trim().toLowerCase();
        rawParameterValue = parameter.slice(equals + 1);
      } else if (allowBunExtendedFilename && parameter.toLowerCase().startsWith("filename*")) {
        // Bun's copied fixture accepts `filename*UTF-8''...` without the RFC
        // 5987 equals sign, so preserve that production parser behavior.
        name = "filename*";
        rawParameterValue = parameter.slice("filename*".length);
      } else {
        continue;
      }
      const parsedValue = unquoteHeaderParameter(rawParameterValue);
      if (name && parsedValue !== undefined && !parameters.has(name)) parameters.set(name, parsedValue);
    }
    return { value: rawValue.trim().toLowerCase(), parameters };
  }
  
  function percentDecodedHeaderBytes(value) {
    const bytes = [];
    for (let index = 0; index < value.length;) {
      if (value[index] === "%") {
        const pair = value.slice(index + 1, index + 3);
        if (!/^[0-9A-Fa-f]{2}$/.test(pair)) return null;
        bytes.push(parseInt(pair, 16));
        index += 3;
        continue;
      }
      const code = value.charCodeAt(index);
      if (code > 0x7f) return null;
      bytes.push(code);
      index += 1;
    }
    return Uint8Array.from(bytes);
  }
  
  function decodeExtendedHeaderValue(value) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(value);
    if (!match) return undefined;
    const bytes = percentDecodedHeaderBytes(match[2]);
    if (!bytes) return undefined;
    const charset = match[1].trim().toLowerCase();
    try {
      if (charset === "utf-8" || charset === "utf8") {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      }
      if (charset === "iso-8859-1" || charset === "latin1") {
        return Array.from(bytes, byte => String.fromCharCode(byte)).join("");
      }
    } catch {}
    return undefined;
  }
  
  function parseMultipartPartHeaders(source) {
    const headers = new Map();
    for (const line of source.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) throw new TypeError("FormData parse error: expected a part header");
      const name = line.slice(0, colon).trim().toLowerCase();
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
        throw new TypeError("FormData parse error: expected a part header");
      }
      if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
    }
    return headers;
  }
  
  function parseMultipartFormDataText(source, boundary) {
    const result = new FormData();
    const delimiter = `--${boundary}`;
    if (!source.includes(`${delimiter}--`)) {
      throw new TypeError("FormData parse error missing final boundary");
    }
    if (!source.startsWith(delimiter)) {
      throw new TypeError("FormData parse error: missing initial boundary");
    }
    let cursor = delimiter.length;
    if (source.startsWith("--", cursor)) return result;
    if (!source.startsWith("\r\n", cursor)) {
      throw new TypeError("FormData parse error: invalid boundary");
    }
    cursor += 2;
  
    for (;;) {
      const separator = source.indexOf("\r\n\r\n", cursor);
      if (separator < 0) throw new TypeError("FormData parse error: expected a part header");
      const headers = parseMultipartPartHeaders(source.slice(cursor, separator));
      const valueStart = separator + 4;
      const nextBoundary = source.indexOf(`\r\n${delimiter}`, valueStart);
      if (nextBoundary < 0) throw new TypeError("FormData parse error missing final boundary");
      const value = source.slice(valueStart, nextBoundary);
  
      const disposition = parseParameterizedHeader(headers.get("content-disposition") ?? "", true);
      const rawFieldName = disposition.value === "form-data" ? disposition.parameters.get("name") : undefined;
      if (rawFieldName === undefined) {
        throw new TypeError("FormData parse error: invalid Content-Disposition header");
      }
      const fieldName = utf8FromLatin1Text(rawFieldName);
      const extendedFilename = disposition.parameters.get("filename*");
      let filename = extendedFilename === undefined ? undefined : decodeExtendedHeaderValue(extendedFilename);
      if (filename === undefined && disposition.parameters.has("filename")) {
        filename = utf8FromLatin1Text(disposition.parameters.get("filename"));
      }
      if (filename !== undefined) {
        const type = headers.get("content-type") ?? "";
        result.append(fieldName, new Blob([Buffer.from(value, "latin1")], { type }), filename);
      } else {
        result.append(fieldName, utf8FromLatin1Text(value));
      }
  
      cursor = nextBoundary + 2 + delimiter.length;
      if (source.startsWith("--", cursor)) return result;
      if (!source.startsWith("\r\n", cursor)) {
        throw new TypeError("FormData parse error: invalid boundary");
      }
      cursor += 2;
    }
  }
  
  const requestState = new WeakMap();
  const lazyRequestURLToken = {};
  
  const bunHttpMethods = new Map([
    "ACL", "BIND", "CHECKOUT", "CONNECT", "COPY", "DELETE", "GET", "HEAD", "LINK", "LOCK",
    "M-SEARCH", "MERGE", "MKACTIVITY", "MKCALENDAR", "MKCOL", "MOVE", "NOTIFY", "OPTIONS",
    "PATCH", "POST", "PROPFIND", "PROPPATCH", "PURGE", "PUT", "QUERY", "REBIND", "REPORT",
    "SEARCH", "SOURCE", "SUBSCRIBE", "TRACE", "UNBIND", "UNLINK", "UNLOCK", "UNSUBSCRIBE",
  ].flatMap(method => [[method, method], [method.toLowerCase(), method]]));
  
  function isObjectLike(value) {
    return value !== null && (typeof value === "object" || typeof value === "function");
  }
  
  function bunString(value) {
    if (typeof value === "symbol") throw new TypeError("Cannot convert a symbol to a string");
    return String(value);
  }
  
  function bunHttpMethod(value) {
    if (value === undefined || value === null || value === "") return "GET";
    const text = bunString(value);
    return bunHttpMethods.get(text) ?? "GET";
  }
  
  function coerceBunStatus(value) {
    if (typeof value === "bigint") {
      const integer = BigInt.asIntN(64, value);
      return { number: Number(integer), display: integer.toString() };
    }
    if (typeof value === "number") {
      if (Number.isNaN(value)) return { number: 0, display: "0" };
      if (value >= 2 ** 63) {
        return { number: Number.MAX_SAFE_INTEGER, display: "9223372036854775807" };
      }
      if (value <= -(2 ** 63)) {
        return { number: Number.MIN_SAFE_INTEGER, display: "-9223372036854775808" };
      }
      const integer = BigInt(Math.trunc(value));
      return { number: Number(integer), display: integer.toString() };
    }
  
    // Bun's generic JSValue path uses JSC's ToInt32 conversion, while primitive
    // doubles and BigInts take the paths above. This intentionally wraps large
    // numeric strings before status validation.
    const number = value >> 0;
    return { number, display: String(number) };
  }
  
  function readBunResponseInit(init, rejectPrimitive = true) {
    if (init === null || init === undefined) {
      return {
        headers: new Headers(),
        headersValue: undefined,
        method: "GET",
        methodValue: undefined,
        status: 200,
        statusText: "",
      };
    }
    if (!isObjectLike(init)) {
      if (!rejectPrimitive) return null;
      throw new TypeError("Failed to construct 'Response': The provided body value is not of type 'ResponseInit'");
    }
  
    // Response.Init.init() reads these in this order. Keep each value so Request
    // can distinguish an omitted overlay field from one coercing to a default.
    const headersValue = init.headers;
    const headers = headersValue === undefined ? new Headers() : new Headers(headersValue);
  
    let status = 200;
    const statusValue = init.status;
    if (statusValue !== undefined) {
      const coerced = coerceBunStatus(statusValue);
      if (coerced.number !== 101 && (coerced.number < 200 || coerced.number >= 600)) {
        throw new RangeError(
          `The status provided (${coerced.display}) must be 101 or in the range of [200, 599]`,
        );
      }
      status = coerced.number;
    }
  
    const statusTextValue = init.statusText;
    const statusText = statusTextValue === undefined || statusTextValue === null || statusTextValue === ""
      ? ""
      : bunString(statusTextValue);
  
    const methodValue = init.method;
    const method = bunHttpMethod(methodValue);
    return { headers, headersValue, method, methodValue, status, statusText };
  }
  
  function requestInitEnum(value, name, allowed) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
    if (!allowed.includes(value)) {
      const choices = allowed.map(choice => `'${choice}'`).join(", ").replace(/, ([^,]+)$/, " or $1");
      throw new TypeError(`${name} must be one of ${choices}`);
    }
    return value;
  }
  
  function requestInitSignal(value) {
    if (value === undefined || value === null || value === "") return undefined;
    if (!isAbortSignal(value)) {
      throw new Error("Failed to construct 'Request': signal is not of type AbortSignal.");
    }
    return value;
  }
  
  function externallyOwnedBodyBytes(body) {
    if (body == null) return 0;
    if (typeof body === "string") return Buffer.byteLength(body);
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength;
    if (typeof body?.size === "number" && Number.isFinite(body.size)) return Math.max(0, body.size);
    if (body instanceof FormData) return Number(body[estimatedMemoryCostSymbol]) || 0;
    return 0;
  }
  
  let lastCanonicalFetchUrlInput = null;
  let lastCanonicalFetchUrlResult = null;

  function canonicalFetchUrl(value) {
    const text = bunString(value);
    if (text === lastCanonicalFetchUrlInput) return lastCanonicalFetchUrlResult;
    try {
      const result = new URL(text).href;
      lastCanonicalFetchUrlInput = text;
      lastCanonicalFetchUrlResult = result;
      return result;
    } catch (cause) {
      const error = new TypeError(`Failed to construct 'Request': Invalid URL "${text}"`);
      error.cause = cause;
      throw error;
    }
  }
  
  function isJSCFinalObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    if (globalThis.__cottontailProxyRegistry?.has(value)) return false;
    if (value instanceof Request || value instanceof Response) return false;
    try {
      return Object.prototype.toString.call(value) === "[object Object]";
    } catch {
      return false;
    }
  }
  
  function requestInputImplementsToString(value) {
    if (typeof value === "function") return true;
    if (!isObjectLike(value)) return false;
    const primitive = value[Symbol.toPrimitive];
    if (typeof primitive === "function") return true;
    const toString = value.toString;
    return typeof toString === "function" && toString !== Object.prototype.toString;
  }
  
  class Request {
    constructor(input, init = undefined, internalToken = null, internalURLFactory = null) {
      const urlFactory = internalToken === lazyRequestURLToken && typeof internalURLFactory === "function"
        ? internalURLFactory
        : null;
      if (urlFactory === null && (arguments.length === 0 || input === null || input === undefined)) {
        throw new TypeError("Failed to construct 'Request': expected non-empty string or object, got undefined");
      }
      const inputIsUrl = typeof input === "string" || input instanceof URL;
      if (urlFactory === null && !inputIsUrl && !isObjectLike(input)) {
        throw new TypeError("Failed to construct 'Request': expected non-empty string or object");
      }

      if (urlFactory === null && init === undefined && inputIsUrl) {
        requestState.set(this, {
          url: canonicalFetchUrl(input),
          urlFactory: null,
          method: "GET",
          headers: new Headers(),
          params: {},
          signal: new AbortController().signal,
          signalExplicit: false,
          redirect: "follow",
          cache: "default",
          mode: "cors",
          credentials: "include",
          keepalive: false,
          keepaliveExplicit: false,
          serveIdleTimeout: undefined,
        });
        this._body = null;
        this._bodyStream = undefined;
        this._bodyUsed = false;
        return;
      }
  
      const initObject = isObjectLike(init) ? init : null;
      const inputRequestState = input instanceof Request ? requestState.get(input) : null;
      const inputResponse = input instanceof Response ? input : null;
      const inputObject = isObjectLike(input) ? input : null;
      let urlText = inputIsUrl ? bunString(input) : undefined;
      let urlOverlayText;
  
      let bodySet = false;
      let rawBody = null;
      let bodyOwner = null;
      let bodyFromInit = false;
      let signal;
      let signalExplicit = false;
      let method;
      let headers;
      let redirect;
      let cache;
      let mode;
  
      const readCandidate = (candidate, explicitRequestOverlay = false, inputFallback = false) => {
        if (!candidate) return;
  
        if (!bodySet) {
          const value = candidate.body;
          if (value !== undefined) {
            bodySet = true;
            rawBody = value;
            bodyOwner = candidate instanceof Request || candidate instanceof Response ? candidate : null;
            bodyFromInit = candidate === initObject;
          }
        }
        const acceptsURLOverlay = candidate === initObject && !inputIsUrl && urlFactory === null;
        if (urlText === undefined || acceptsURLOverlay) {
          const value = candidate.url;
          if (value !== undefined) {
            const candidateUrl = bunString(value);
            if (candidateUrl !== "") {
              urlText = candidateUrl;
              if (acceptsURLOverlay) urlOverlayText = candidateUrl;
            }
          } else if (inputFallback && requestInputImplementsToString(candidate)) {
            const candidateUrl = bunString(candidate);
            if (candidateUrl !== "") urlText = candidateUrl;
          }
        }
        if (signal === undefined) {
          const value = requestInitSignal(candidate.signal);
          if (value !== undefined) {
            signal = value;
            signalExplicit = true;
          }
        }
  
        if (method === undefined || headers === undefined) {
          const responseInit = readBunResponseInit(candidate);
          const emptyHeaders = responseInit.headers._values?.size === 0;
          let hasExplicitHeaders = responseInit.headersValue !== undefined;
          let hasExplicitMethod = responseInit.methodValue !== undefined;
          if (explicitRequestOverlay) {
            // Bun repeats these fastGet() calls for a FinalObject overlay on a
            // Request/Response input before deciding whether defaults override.
            hasExplicitHeaders = candidate.headers !== undefined;
            hasExplicitMethod = candidate.method !== undefined;
          }
          const emptyOverlayOnWrapper = candidate === initObject &&
            (inputRequestState !== null || inputResponse !== null) && emptyHeaders;
          if (headers === undefined && hasExplicitHeaders && !emptyOverlayOnWrapper) {
            headers = responseInit.headers;
          }
          if (method === undefined && (!explicitRequestOverlay || hasExplicitMethod)) {
            method = responseInit.method;
          }
        }
  
        if (redirect === undefined) {
          redirect = requestInitEnum(candidate.redirect, "redirect", ["follow", "manual", "error"]);
        }
        if (cache === undefined) {
          cache = requestInitEnum(candidate.cache, "cache", [
            "default", "no-store", "reload", "no-cache", "force-cache", "only-if-cached",
          ]);
        }
        if (mode === undefined) {
          mode = requestInitEnum(candidate.mode, "mode", ["same-origin", "no-cors", "cors", "navigate"]);
        }
      };
  
      if (initObject) {
        const explicitRequestOverlay = (inputRequestState !== null || inputResponse !== null) &&
          isJSCFinalObject(initObject);
        readCandidate(initObject, explicitRequestOverlay);
      }
  
      if (inputRequestState) {
        if (!bodySet && input._body != null) {
          bodySet = true;
          rawBody = input._body;
          bodyOwner = input;
        }
        signal ??= inputRequestState.signal;
        signalExplicit ||= inputRequestState.signalExplicit === true;
        method ??= inputRequestState.method;
        if (headers === undefined) headers = new Headers(inputRequestState.headers);
        redirect ??= inputRequestState.redirect;
        cache ??= inputRequestState.cache;
        mode ??= inputRequestState.mode;
        if (urlText === undefined) urlText = input.url;
      } else if (inputResponse) {
        if (!bodySet && input._body != null) {
          bodySet = true;
          rawBody = input._body;
          bodyOwner = input;
        }
        method ??= input._method ?? "GET";
        if (headers === undefined) headers = new Headers(input.headers);
        if (urlText === undefined && input.url !== "") urlText = input.url;
      } else if (inputObject && typeof input !== "string" && !(input instanceof URL)) {
        readCandidate(inputObject, false, true);
      }
  
      if (urlOverlayText !== undefined) urlText = urlOverlayText;
  
      let url = "";
      if (urlFactory === null) {
        if (urlText === undefined || urlText === "") {
          throw new Error("Failed to construct 'Request': url is required.");
        }
        url = canonicalFetchUrl(urlText);
      }
  
      headers ??= new Headers();
      method ??= "GET";
      signal ??= new AbortController().signal;
      redirect ??= "follow";
      cache ??= "default";
      mode ??= "cors";
  
      const params = initObject?.params ?? inputRequestState?.params ?? inputObject?.params ?? {};
      const initKeepalive = initObject?.keepalive;
      const keepaliveValue = initKeepalive ?? inputRequestState?.keepalive ?? inputObject?.keepalive ?? false;
      const keepalive = Boolean(keepaliveValue);
      const keepaliveExplicit = initObject != null && initKeepalive !== undefined ||
        inputRequestState?.keepaliveExplicit === true;
      requestState.set(this, {
        url,
        urlFactory,
        method,
        headers,
        params,
        signal,
        signalExplicit,
        redirect,
        cache,
        mode,
        credentials: "include",
        keepalive,
        keepaliveExplicit,
        serveIdleTimeout: undefined,
      });
      this._body = bodyOwner instanceof Request && bodyOwner === input && bodySet && !bodyFromInit
        ? bodyForRequestCopy(bodyOwner)
        : bodyOwner instanceof Response && bodyOwner === input && bodySet && !bodyFromInit
          ? teeClonedBody(bodyOwner)
          : snapshotBodyValue(rawBody);
      setDefaultBodyContentType(headers, this._body instanceof FormData ? this._body : rawBody);
      if (this._body instanceof FormData) assertFormDataFilesExist(this._body);
      if (this._body?.locked) throw new TypeError(keepalive ? "keepalive" : "ReadableStream is locked");
      if (bodyStreamIsDisturbed(this._body)) throw new TypeError("ReadableStream has already been used");
      if (keepalive && typeof this._body?.getReader === "function") {
        throw new TypeError("keepalive");
      }
      this._bodyStream = undefined;
      this._bodyUsed = false;
    }
    get url() {
      const state = requestState.get(this);
      if (typeof state?.urlFactory === "function") {
        const url = canonicalFetchUrl(state.urlFactory());
        state.url = url;
        state.urlFactory = null;
      }
      return state?.url;
    }
    get method() { return requestState.get(this)?.method; }
    get headers() { return requestState.get(this)?.headers; }
    get params() { return requestState.get(this)?.params; }
    set params(value) {
      const state = requestState.get(this);
      if (state) state.params = value;
    }
    get signal() { return requestState.get(this)?.signal; }
    get redirect() { return requestState.get(this)?.redirect; }
    get cache() { return requestState.get(this)?.cache; }
    get mode() { return requestState.get(this)?.mode; }
    get credentials() { return requestState.get(this)?.credentials; }
    get keepalive() { return requestState.get(this)?.keepalive === true; }
    get body() {
      return bodyStreamFor(this);
    }
    get cookies() {
      return this._cookies ??= new CookieMap(this.headers.get("cookie") ?? "", { preserveFirst: true });
    }
    set cookies(_) {
      throw new TypeError("Request.cookies is readonly");
    }
    get bodyUsed() {
      return bodyWasUsed(this);
    }
    get [estimatedMemoryCostSymbol]() {
      const state = requestState.get(this);
      const headersCost = Number(state?.headers?.[estimatedMemoryCostSymbol]) || 0;
      const upgradeContext = serveUpgradeContexts.get(this);
      return 512 + externallyOwnedBodyBytes(this._body) + headersCost +
        (upgradeContext && !upgradeContext.used ? 4096 : 0);
    }
    clone() {
      if (this._bodyStream?.locked) throw new TypeError("ReadableStream is locked");
      if (bodyWasUsed(this)) throw new TypeError("Body already used");
      const cloned = new Request(this.url, {
        method: this.method,
        headers: new Headers(this.headers),
        params: this.params,
        signal: this.signal,
        redirect: this.redirect,
        cache: this.cache,
        mode: this.mode,
        credentials: this.credentials,
        keepalive: this.keepalive,
      });
      const clonedState = requestState.get(cloned);
      if (clonedState) clonedState.signalExplicit = requestState.get(this)?.signalExplicit === true;
      cloned._body = teeClonedBody(this);
      if (this._cookies) cloned._cookies = cloneCookieMap(this._cookies);
      return cloned;
    }
    _takeBody() {
      return lifecycleTakeBody(this, isStreamingBody);
    }
    async arrayBuffer() {
      const body = this._takeBody();
      if (body instanceof Blob) return body.arrayBuffer();
      return arrayBufferFromBytes(await bytesFromBody(body));
    }
    async bytes() {
      const body = this._takeBody();
      if (body instanceof Blob && typeof body.bytes === "function") return asBuffer(await body.bytes());
      return asBuffer(await bytesFromBody(body));
    }
    async blob() {
      const type = blobTypeFromBodyHeaders(this.headers);
      const body = this._takeBody();
      // Bun keeps a Blob body's own MIME type. Response headers only supply a
      // type when the consumed body did not already carry one.
      if (body instanceof Blob && (body.type || !type)) return body;
      return cachedBlobForBytes(await bytesFromBody(body), type);
    }
    text() {
      return consumeBodyText(this);
    }
    async json() {
      if (this._body instanceof Blob && typeof this._body.json === "function") {
        try {
          return await this._takeBody().json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new SyntaxError("Failed to parse JSON");
          throw error;
        }
      }
      return consumeBodyJson(this);
    }
    formData() {
      if (!(this instanceof Request)) {
        let message = "Expected this to be instanceof Request";
        if (this === null) message += ", but received null";
        else if (this !== undefined && typeof this === "object") message += `, but received an instance of ${this.constructor?.name ?? "Object"}`;
        else if (typeof this === "string") message += `, but received type string ('${this}')`;
        else if (this !== undefined) message += `, but received type ${typeof this} (${nodeInspect(this)})`;
        const error = new TypeError(message);
        error.code = "ERR_INVALID_THIS";
        throw error;
      }
      if (this._bodyStream?.locked) return handledRejectedPromise(new TypeError("ReadableStream is locked"));
      if (bodyWasUsed(this)) return handledRejectedPromise(new TypeError("Body already used"));
      this._bodyUsed = true;
      return parseMultipartFormData(bodyValueForConsumption(this), this.headers.get("content-type"));
    }
    [ctInspectSymbol]() {
      const headerInspector = bunInspectPropertyDescriptor(this.headers, ctInspectSymbol)?.value;
      const renderedHeaders = typeof headerInspector === "function"
        ? headerInspector.call(this.headers)
        : nodeInspect(this.headers);
      const size = inspectBodyByteSize(this._body) ?? "0 KB";
      return `Request (${size}) {\n  method: ${JSON.stringify(this.method)},\n  url: ${JSON.stringify(normalizeRequestUrl(this.url))},\n  headers: ${renderedHeaders}\n}`;
    }
  }
  
  function requestWithLazyURL(urlFactory, init) {
    return new Request(undefined, init, lazyRequestURLToken, urlFactory);
  }
  
  function cloneCookieMap(map) {
    const cloned = new CookieMap();
    for (const [name, value] of Map.prototype.entries.call(map)) {
      Map.prototype.set.call(cloned, name, value);
    }
    cloned._changes = map._changes.map((change) => ({ ...change }));
    cloned._initialKeys = [...map._initialKeys];
    cloned._dynamicKeys = [...map._dynamicKeys];
    return cloned;
  }
  
  function bodyForRequestCopy(source) {
    if (source._bodyStream?.locked || source._body?.locked) {
      throw new TypeError("ReadableStream is locked");
    }
    if (bodyWasUsed(source)) {
      // A consumed native body has become Bun's Empty value and remains
      // cloneable. An exposed or user-provided stream remains disturbed.
      if (source._bodyStream != null || isStreamingBody(source._body)) {
        throw new TypeError("Body already used");
      }
      return new Blob([]);
    }
    return teeClonedBody(source);
  }
  
  function teeClonedBody(source) {
    const body = source._body;
    if (!isStreamingBody(body)) {
      if (source._bodyStream != null) source._bodyLocksUse = false;
      return snapshotBodyValue(body);
    }
  
    const stream = source._bodyStream ?? bodyReadableStream(body);
    if (!stream || typeof stream.tee !== "function") return body;
    if (stream.locked) throw new TypeError("ReadableStream is locked");
    if (bodyStreamIsDisturbed(stream)) throw new TypeError("Body already used");
  
    const [original, cloned] = stream.tee();
    source._body = original;
    source._bodyStream = undefined;
    source._bodyLocksUse = undefined;
    source._bodyUsed = false;
    return cloned;
  }
  
  function normalizeRequestUrl(value) {
    const text = String(value);
    try {
      const url = new URL(text);
      const pathname = String(url.pathname || "/") || "/";
      return `${url.origin}${pathname}${url.search}${url.hash}`;
    } catch {
      return text;
    }
  }
  
  function normalizeServeDispatchUrl(value) {
    const normalized = normalizeRequestUrl(value);
    try {
      const url = new URL(normalized);
      const pathname = String(url.pathname || "/").replace(/^\/+/, "/") || "/";
      return `${url.origin}${pathname}${url.search}${url.hash}`;
    } catch {
      return normalized;
    }
  }
  
  class Response {
    constructor(body = null, init = {}) {
      const responseInit = readBunResponseInit(init);
      const rawBody = body;
      this.status = responseInit.status;
      this.statusText = responseInit.statusText;
      this.headers = responseInit.headers;
      this._method = responseInit.method;
      body = snapshotBodyValue(rawBody);
      if (body?.locked) throw new TypeError("ReadableStream is locked");
      if (bodyStreamIsDisturbed(body)) throw new TypeError("ReadableStream has already been used");
      setDefaultBodyContentType(this.headers, body instanceof FormData ? body : rawBody);
      if (body instanceof FormData) assertFormDataFilesExist(body);
      this._body = body;
      this._bodyStream = undefined;
      this._bodyUsed = false;
      this._bodyConsumedBytes = 0;
      this.url = "";
      this.redirected = false;
      this._type = "default";
    }
    get bodyUsed() {
      return bodyWasUsed(this);
    }
    get [estimatedMemoryCostSymbol]() {
      return 512 + externallyOwnedBodyBytes(this._body) +
        (Number(this.headers?.[estimatedMemoryCostSymbol]) || 0);
    }
    static json(value, init = {}) {
      const omitted = arguments.length === 0;
      if (typeof init === "number") init = { status: init };
      let body;
      if (omitted) {
        body = "";
      } else {
        try {
          body = JSON.stringify(value);
        } catch (error) {
          // Match Node's JSON.stringify BigInt message (Bun does the same).
          if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
          throw error;
        }
        // Top-level undefined/function/symbol serialize to undefined; Bun throws.
        if (body === undefined) throw new TypeError("Value is not JSON serializable");
      }
      const headers = new Headers(init.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json;charset=utf-8");
      return new Response(body, { ...init, headers });
    }
    static error() {
      const response = new Response(null);
      response.status = 0;
      response.statusText = "";
      response._type = "error";
      return response;
    }
    static redirect(url, status = 302) {
      let init = {};
      let statusCode = 302;
      if (status !== null && typeof status === "object") {
        init = status;
        statusCode = init.status === undefined ? 302 : Number(init.status);
      } else if (typeof status === "number") {
        statusCode = status;
      }
      if (statusCode !== 301 && statusCode !== 302 && statusCode !== 303 && statusCode !== 307 && statusCode !== 308) {
        throw new RangeError("Invalid status code");
      }
      const headers = new Headers(init.headers);
      headers.set("location", String(url));
      return new Response(null, { ...init, status: statusCode, headers });
    }
    clone() {
      if (this._bodyStream?.locked) throw new TypeError("ReadableStream is locked");
      if (bodyWasUsed(this)) throw new TypeError("Body already used");
      const cloned = responseWithMetadata(null, {
        status: this.status === 0 || this.status === 101 ? 200 : this.status,
        statusText: this.statusText,
        headers: new Headers(this.headers),
        method: this._method,
      }, {
        url: this.url,
        redirected: this.redirected,
        type: this._type,
      });
      cloned.status = this.status;
      cloned._body = teeClonedBody(this);
      return cloned;
    }
    _takeBody() {
      return lifecycleTakeBody(this, isStreamingBody);
    }
    async arrayBuffer() {
      const body = this._takeBody();
      if (body instanceof Blob) return body.arrayBuffer();
      return arrayBufferFromBytes(await bytesFromBody(body));
    }
    async bytes() {
      const body = this._takeBody();
      if (body instanceof Blob && typeof body.bytes === "function") return asBuffer(await body.bytes());
      return asBuffer(await bytesFromBody(body));
    }
    async blob() {
      const type = blobTypeFromBodyHeaders(this.headers);
      const body = this._takeBody();
      // Bun keeps a Blob body's own MIME type. Response headers only supply a
      // type when the consumed body did not already carry one.
      if (body instanceof Blob && (body.type || !type)) return body;
      return cachedBlobForBytes(await bytesFromBody(body), type);
    }
    text() {
      return consumeBodyText(this);
    }
    async json() {
      if (this._body instanceof Blob && typeof this._body.json === "function") {
        try {
          return await this._takeBody().json();
        } catch (error) {
          if (error instanceof SyntaxError) throw new SyntaxError("Failed to parse JSON");
          throw error;
        }
      }
      return consumeBodyJson(this);
    }
    formData() {
      if (this._bodyStream?.locked) return handledRejectedPromise(new TypeError("ReadableStream is locked"));
      if (bodyWasUsed(this)) return handledRejectedPromise(new TypeError("Body already used"));
      if (this._body != null) this._bodyUsed = true;
      return parseMultipartFormData(bodyValueForConsumption(this), this.headers.get("content-type"));
    }
    get body() {
      return bodyStreamFor(this);
    }
    get ok() {
      return this.status >= 200 && this.status < 300;
    }
    get type() {
      return this._type;
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
      const indentTail = (text) => String(text).split("\n").map((line, index) => (index === 0 ? line : `  ${line}`)).join("\n");
      const lines = [
        `ok: ${this.ok}`,
        `url: ${JSON.stringify(this.url)}`,
        `status: ${this.status}`,
        `statusText: ${JSON.stringify(this.statusText)}`,
        `headers: ${indentTail(this.headers[Symbol.for("nodejs.util.inspect.custom")]())}`,
        `redirected: ${this.redirected}`,
        `bodyUsed: ${this.bodyUsed}`,
      ];
      const body = this._body;
      const sizeText = typeof body?.getReader === "function"
        ? formatInspectBodyByteSize(this._bodyConsumedBytes, false)
        : inspectBodyByteSize(body);
      const prefix = sizeText == null ? "Response" : `Response (${sizeText})`;
      const bodyInspector = body == null ? undefined : bunInspectPropertyDescriptor(body, ctInspectSymbol)?.value;
      if (typeof bodyInspector === "function") {
        lines.push(indentTail(bodyInspector.call(body)));
      } else if (sizeText != null) {
        lines.push(sizeText === "0 KB" ? "[Blob detached]" : `Blob (${sizeText})`);
      }
      return `${prefix} {\n${lines.map((line, index) => `  ${line}${index === lines.length - 1 ? "" : ","}`).join("\n")}\n}`;
    }
  }
  
  function responseWithMetadata(body, init, metadata = undefined) {
    const response = new Response(body, init);
    if (metadata) {
      response.url = String(metadata.url ?? "");
      response.redirected = Boolean(metadata.redirected);
      response._type = String(metadata.type ?? "default");
    }
    return response;
  }
  
  // Bun renders body sizes as "N bytes" below 1 KB and with two decimals in
  // decimal units above it.
  function inspectBodyByteSize(body) {
    let size = null;
    if (body == null) return null;
    if (typeof body === "string") size = new TextEncoder().encode(body).byteLength;
    else if (body instanceof ArrayBuffer) size = body.byteLength;
    else if (ArrayBuffer.isView(body)) size = body.byteLength;
    else if (typeof body === "object" && typeof body.size === "number" && Number.isFinite(body.size)) size = body.size;
    if (size == null) return null;
    return formatInspectBodyByteSize(size, true);
  }
  
  function formatInspectBodyByteSize(size, emptyAsKilobytes) {
    if (size === 0) return emptyAsKilobytes ? "0 KB" : "0 bytes";
    if (size < 1000) return `${size} bytes`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = size;
    let unit = -1;
    do {
      value /= 1000;
      unit += 1;
    } while (value >= 1000 && unit < units.length - 1);
    return `${value.toFixed(2)} ${units[unit]}`;
  }
  
  // The host Blob lacks Bun's json()/formData() helpers and does not strip a
  // UTF-8 BOM in text(); patch the prototype to match Bun.
  (function patchBlobPrototype() {
    const proto = globalThis.Blob?.prototype;
    if (!proto) return;
    const blobNames = new WeakMap();
    if (!Object.getOwnPropertyDescriptor(proto, "name")) {
      Object.defineProperty(proto, "name", {
        get() { return blobNames.get(this); },
        set(value) { if (typeof value === "string") blobNames.set(this, value); },
        configurable: true,
      });
    }
    if (typeof proto.slice === "function" && !proto.slice.__cottontailBunSlice) {
      const originalSlice = proto.slice;
      const slice = function slice(start = undefined, end = undefined, type = "") {
        if (typeof start === "string") {
          type = start;
          start = 0;
          end = this.size;
        } else if (typeof end === "string") {
          type = end;
          end = this.size;
        }
        if (typeof start !== "number" || Number.isNaN(start)) start = 0;
        if (typeof end !== "number") end = this.size;
        else if (Number.isNaN(end)) end = 0;
        return originalSlice.call(this, start, end, type);
      };
      slice.__cottontailBunSlice = true;
      Object.defineProperty(proto, "slice", { value: slice, writable: true, configurable: true });
    }
    if (typeof proto.text === "function" && !proto.text.__cottontailBOM) {
      const originalText = proto.text;
      const wrapped = async function text() {
        return stripUtf8BOMText(String(await originalText.call(this)));
      };
      wrapped.__cottontailBOM = true;
      Object.defineProperty(proto, "text", { value: wrapped, writable: true, configurable: true });
    }
    if (typeof proto.json !== "function" || !proto.json.__cottontailBunJson) {
      const json = async function json() {
        try {
          return JSON.parse(await this.text());
        } catch {
          throw new SyntaxError("Failed to parse JSON");
        }
      };
      json.__cottontailBunJson = true;
      Object.defineProperty(proto, "json", {
        value: json,
        writable: true,
        configurable: true,
      });
    }
    if (typeof proto.formData !== "function") {
      Object.defineProperty(proto, "formData", {
        value: async function formData() {
          return parseMultipartFormData(this, this.type);
        },
        writable: true,
        configurable: true,
      });
    }
    const readOnlyBlob = function readOnlyBlob() {
      throw new TypeError("Cannot write to a Blob backed by bytes, which are always read-only");
    };
    for (const name of ["write", "unlink", "delete", "writer"]) {
      if (typeof proto[name] !== "function") {
        Object.defineProperty(proto, name, {
          value: readOnlyBlob,
          writable: true,
          configurable: true,
        });
      }
    }
    if (typeof proto.stat !== "function") {
      Object.defineProperty(proto, "stat", {
        value: async function stat() {},
        writable: true,
        configurable: true,
      });
    }
  })();
  
  
  return {
    arrayBufferFromBytes,
    bodyBlobSourceSymbol,
    bodyReadableStream,
    bodyValueForConsumption,
    bunString,
    bytesFromBody,
    bytesFromData,
    consumeStreamingBody,
    encodeMultipartFormData,
    externallyOwnedBodyBytes,
    fetchBodyStartSymbol,
    FormData,
    formDataBoundary,
    Headers,
    headersGetAll,
    inspectBodyByteSize,
    invalidHeaderErrorSymbol,
    isObjectLike,
    isURLSearchParamsLike,
    normalizeRequestUrl,
    normalizeServeDispatchUrl,
    parseMultipartFormData,
    parseMultipartFormDataText,
    Request,
    requestState,
    requestWithLazyURL,
    Response,
    responseWithMetadata,
    sharedArrayBufferBytes,
    stringLatin1FromBytes,
    stripUtf8BOMText,
  };
}
