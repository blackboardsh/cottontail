// node-fetch compatibility shim (ported from Bun's src/js/thirdparty/node-fetch.ts):
// backed by the native fetch/Request/Response/Headers with node-fetch's
// looser behaviors (relative URLs, headers.raw(), buffer(), node-stream bodies).

import { Readable, Stream, PassThrough } from "../node/stream.js";
import { Buffer } from "../node/buffer.js";

const WebResponse = globalThis.Response;
const WebRequest = globalThis.Request;
const WebHeaders = globalThis.Headers;
const WebBlob = globalThis.Blob;
const WebFormData = globalThis.FormData;
const WebFile = globalThis.File ?? globalThis.Blob;
const nativeFetch = globalThis.fetch;

class Headers extends WebHeaders {
  raw() {
    const obj = typeof this.toJSON === "function" ? this.toJSON() : Object.fromEntries(this.entries());
    for (const key in obj) {
      const val = obj[key];
      if (!Array.isArray(val)) obj[key] = [val];
    }
    return obj;
  }

  // node-fetch inherits sort() from URLSearchParams; calling it throws there.
  sort() {
    throw new TypeError("Expected this to be instanceof URLSearchParams");
  }
}
const HeadersPrototype = Headers.prototype;

const kHeaders = Symbol("kHeaders");
const kBody = Symbol("kBody");
const kUrl = Symbol("kUrl");

class Response extends WebResponse {
  constructor(body, init) {
    if (body && typeof body === "object" && (body instanceof Stream || body instanceof Readable)) {
      body = Readable.toWeb(body);
    }
    super(body, init);
  }

  get body() {
    let body = this[kBody];
    if (!body) {
      const web = super.body;
      if (!web) return null;
      body = this[kBody] = typeof Readable.fromWeb === "function" ? Readable.fromWeb(web) : web;
    }
    return body;
  }

  get headers() {
    return (this[kHeaders] ??= Object.setPrototypeOf(super.headers, HeadersPrototype));
  }

  clone() {
    return Object.setPrototypeOf(super.clone(), ResponsePrototype);
  }

  async buffer() {
    return Buffer.from(await super.arrayBuffer());
  }

  get type() {
    return super.ok ? "default" : "error";
  }
}
const ResponsePrototype = Response.prototype;

class Request extends WebRequest {
  constructor(input, init) {
    // node-fetch is relaxed with the URL: "/" is accepted (bun issue #4947).
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
    if (init.body instanceof Stream || init.body instanceof Readable) {
      let readable = init.body;
      if (!(readable instanceof Readable)) {
        const passthrough = new PassThrough();
        readable.pipe(passthrough);
        readable = passthrough;
      }
      init = { ...init, body: Readable.toWeb(readable) };
    }
  }
  const response = await nativeFetch.call(undefined, url, init);
  Object.setPrototypeOf(response, ResponsePrototype);
  return response;
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

export {
  AbortError,
  WebBlob as Blob,
  FetchBaseError,
  FetchError,
  WebFile as File,
  WebFormData as FormData,
  Headers,
  Request,
  Response,
  blobFrom,
  blobFromSync,
  fileFrom,
  fileFromSync,
  isRedirect,
  fetch,
};

export default Object.assign(fetch, {
  AbortError,
  Blob: WebBlob,
  FetchBaseError,
  FetchError,
  File: WebFile,
  FormData: WebFormData,
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
