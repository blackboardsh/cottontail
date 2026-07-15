// Bun overrides the npm packages "node-fetch", "isomorphic-fetch" and
// "@vercel/fetch" with built-in shims that delegate to the native fetch
// implementation (see bun's src/js/thirdparty/*). This module ports those
// shims on top of cottontail's fetch/Response/Request/Headers classes.
//
// The classes are imported from ./index.js (not read off globalThis) because
// user code may override globalThis.Response/Request/Headers/fetch before
// requiring "node-fetch"; the shim must keep using the originals.
import {
  fetch as bunFetch,
  FormData as BunFormData,
  Headers as WebHeaders,
  Request as WebRequest,
  Response as WebResponse,
} from "./index.js";

// Blob/File are installed on globalThis during startup (before any user code
// runs is not guaranteed for this lazily-required module, so capture the
// current values defensively; they are only used as informational exports).
const Blob = globalThis.Blob;
const File = globalThis.File;

// node-fetch's Headers subclass exposes raw() and inherits (a throwing) sort()
// from URLSearchParams.
class Headers extends WebHeaders {
  raw() {
    const obj = this.toJSON();
    for (const key in obj) {
      const val = obj[key];
      if (!Array.isArray(val)) {
        // They must all be arrays.
        obj[key] = [val];
      }
    }
    return obj;
  }

  // node-fetch inherits this due to URLSearchParams; it throws when used.
  sort() {
    throw new TypeError("Expected this to be instanceof URLSearchParams");
  }
}
const HeadersPrototype = Headers.prototype;

const kBody = Symbol("kBody");

function toWebBody(body) {
  if (body && typeof body === "object" && typeof body.pipe === "function") {
    const { Readable, Stream, PassThrough } = require("../node/stream.js");
    if (body instanceof Stream || body instanceof Readable) {
      let readable = body;
      if (!(readable instanceof Readable)) {
        const passthrough = new PassThrough();
        readable.pipe(passthrough);
        readable = passthrough;
      }
      return Readable.toWeb(readable);
    }
  }
  return body;
}

class Response extends WebResponse {
  constructor(body, init) {
    super(toWebBody(body), init);
    retagHeaders(this);
  }

  // node-fetch exposes the body as a Node.js Readable stream.
  get body() {
    let body = this[kBody];
    if (!body) {
      const web = super.body;
      if (!web) return null;
      const { Readable } = require("../node/stream.js");
      body = this[kBody] = Readable.fromWeb(web);
    }
    return body;
  }

  clone() {
    const cloned = super.clone();
    Object.setPrototypeOf(cloned, ResponsePrototype);
    retagHeaders(cloned);
    return cloned;
  }

  // Deprecated in node-fetch but still used by some frameworks.
  async buffer() {
    return Buffer.from(await super.arrayBuffer());
  }

  get type() {
    if (!(this.status >= 200 && this.status < 300)) {
      return "error";
    }
    return "default";
  }
}
const ResponsePrototype = Response.prototype;

// cottontail's Response stores headers as an own data property, so a
// prototype getter cannot re-brand it; retag the instance instead.
function retagHeaders(response) {
  try {
    const headers = response.headers;
    if (headers instanceof WebHeaders && !(headers instanceof Headers)) {
      Object.setPrototypeOf(headers, HeadersPrototype);
    }
  } catch {}
  return response;
}

const kUrl = Symbol("kUrl");

class Request extends WebRequest {
  constructor(input, init) {
    // node-fetch is relaxed with the URL: it allows "/" as a valid URL.
    if (typeof input === "string" && !URL.canParse(input)) {
      super(new URL(input, "http://localhost/"), init);
      this[kUrl] = input;
    } else {
      super(input, init);
    }
  }

  get url() {
    return this[kUrl] ?? super.url;
  }
}

async function fetch(url, init) {
  if (init?.body && typeof init.body === "object" && !init.body[Symbol.asyncIterator]) {
    const webBody = toWebBody(init.body);
    if (webBody !== init.body) init = { ...init, body: webBody };
  }
  const response = await bunFetch(url, init);
  Object.setPrototypeOf(response, ResponsePrototype);
  return retagHeaders(response);
}

class AbortError extends DOMException {
  constructor(message) {
    super(message, "AbortError");
  }
}

class FetchBaseError extends Error {
  constructor(message, type) {
    super(message);
    this.type = type;
  }
}

class FetchError extends FetchBaseError {
  constructor(message, type, systemError) {
    super(message, type);
    this.code = systemError?.code;
  }
}

function blobFrom(path, options) {
  return Promise.resolve(Bun.file(path, options));
}

function blobFromSync(path, options) {
  return Bun.file(path, options);
}

const fileFrom = blobFrom;
const fileFromSync = blobFromSync;

function isRedirect(code) {
  return code === 301 || code === 302 || code === 303 || code === 307 || code === 308;
}

const nodeFetch = Object.assign(fetch, {
  AbortError,
  Blob,
  FetchBaseError,
  FetchError,
  File,
  FormData: BunFormData,
  Headers,
  Request,
  Response,
  blobFrom,
  blobFromSync,
  fileFrom,
  fileFromSync,
  isRedirect,
  fetch,
  default: fetch,
});

export default nodeFetch;

// --- isomorphic-fetch ---------------------------------------------------
// Bun's shim is a plain wrapper around the native fetch.
function isomorphicFetchImpl(...args) {
  return bunFetch(...args);
}
isomorphicFetchImpl.default = isomorphicFetchImpl;
isomorphicFetchImpl.fetch = isomorphicFetchImpl;
export const isomorphicFetch = isomorphicFetchImpl;

// --- @vercel/fetch --------------------------------------------------------
// A factory that receives an (optional) fetch implementation and returns a
// fetch that JSON-encodes plain-object bodies.
export function vercelFetch(wrapper = bunFetch) {
  async function vercelFetchImpl(url, opts = {}) {
    if (
      opts.body &&
      typeof opts.body === "object" &&
      (!("buffer" in opts.body) || typeof opts.body.buffer !== "object" || !(opts.body.buffer instanceof ArrayBuffer))
    ) {
      opts.body = JSON.stringify(opts.body);
      if (!opts.headers) opts.headers = new WebHeaders();
      opts.headers.set("Content-Type", "application/json");
    }
    try {
      return await wrapper(url, opts);
    } catch (error) {
      error.url = url;
      error.opts = opts;
      throw error;
    }
  }
  vercelFetchImpl.default = vercelFetchImpl;
  return vercelFetchImpl;
}
vercelFetch.default = vercelFetch;
