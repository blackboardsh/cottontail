// Bun.S3Client — AWS SigV4 signing (presigned URLs + header-signed requests)
// over fetch. Covers the S3 API surface exercised by upstream regression
// tests: client/file presign, write with CR/LF header validation, and the
// common convenience methods.

import { createHash, createHmac } from "../node/crypto.js";

const DEFAULT_REGION = "us-east-1";

function env(name) {
  return globalThis.process?.env?.[name];
}

function awsEncode(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeKeyPath(key) {
  return String(key)
    .split("/")
    .map(awsEncode)
    .join("/");
}

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

function amzTimestamp(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, "");
  const amzDate = `${iso.slice(0, 15)}Z`;
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function checkCRLF(value, name) {
  if (typeof value === "string" && /[\r\n]/.test(value)) {
    throw new Error(
      `Invalid ${name}: CR/LF characters are not allowed in header values`,
    );
  }
}

function resolveOptions(clientOptions = {}, callOptions = {}) {
  const merged = { ...clientOptions, ...callOptions };
  merged.region ??= env("S3_REGION") ?? env("AWS_REGION") ?? DEFAULT_REGION;
  merged.accessKeyId ??= env("S3_ACCESS_KEY_ID") ?? env("AWS_ACCESS_KEY_ID");
  merged.secretAccessKey ??= env("S3_SECRET_ACCESS_KEY") ?? env("AWS_SECRET_ACCESS_KEY");
  merged.sessionToken ??= env("S3_SESSION_TOKEN") ?? env("AWS_SESSION_TOKEN");
  merged.bucket ??= env("S3_BUCKET") ?? env("AWS_BUCKET");
  merged.endpoint ??= env("S3_ENDPOINT") ?? env("AWS_ENDPOINT");
  return merged;
}

function resolveTarget(path, options) {
  let bucket = options.bucket;
  let key = String(path ?? "");
  if (key.startsWith("s3://")) {
    const rest = key.slice(5);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      bucket = rest.slice(0, slash);
      key = rest.slice(slash + 1);
    } else {
      bucket = rest;
      key = "";
    }
  }
  while (key.startsWith("/")) key = key.slice(1);
  if (!bucket) {
    const slash = key.indexOf("/");
    if (slash > 0) {
      bucket = key.slice(0, slash);
      key = key.slice(slash + 1);
    }
  }
  if (!bucket) throw new Error("S3Client requires a bucket (pass `bucket` in options or use an s3:// URL)");
  let endpoint = options.endpoint || `https://s3.${options.region}.amazonaws.com`;
  endpoint = String(endpoint).replace(/\/+$/, "");
  const url = new URL(endpoint);
  const canonicalPath = `${url.pathname.replace(/\/+$/, "")}/${awsEncode(bucket)}/${encodeKeyPath(key)}`;
  return { bucket, key, url, canonicalPath };
}

function requireCredentials(options) {
  if (!options.accessKeyId || !options.secretAccessKey) {
    throw new Error("S3Client requires accessKeyId and secretAccessKey");
  }
}

function signingKey(options, dateStamp) {
  const kDate = hmac(`AWS4${options.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

function canonicalQueryString(params) {
  return params
    .map(([name, value]) => [awsEncode(name), awsEncode(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function presignURL(path, options) {
  requireCredentials(options);
  checkCRLF(options.contentDisposition, "contentDisposition");
  checkCRLF(options.contentEncoding, "contentEncoding");
  checkCRLF(options.type, "type");
  const { url, canonicalPath } = resolveTarget(path, options);
  const method = String(options.method || "GET").toUpperCase();
  const expiresIn = Math.min(Math.max(Number(options.expiresIn) || 86400, 1), 604800);
  const { amzDate, dateStamp } = amzTimestamp();
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;

  const params = [
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
    ["X-Amz-Credential", `${options.accessKeyId}/${scope}`],
    ["X-Amz-Date", amzDate],
    ["X-Amz-Expires", String(expiresIn)],
    ["X-Amz-SignedHeaders", "host"],
  ];
  if (options.acl) params.push(["X-Amz-Acl", String(options.acl)]);
  if (options.sessionToken) params.push(["X-Amz-Security-Token", String(options.sessionToken)]);
  if (options.storageClass) params.push(["X-Amz-Storage-Class", String(options.storageClass)]);
  if (options.contentDisposition) params.push(["response-content-disposition", String(options.contentDisposition)]);
  if (options.type) params.push(["response-content-type", String(options.type)]);
  if (options.contentEncoding) params.push(["response-content-encoding", String(options.contentEncoding)]);

  const canonicalQuery = canonicalQueryString(params);
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
    `host:${url.host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(options, dateStamp))
    .update(stringToSign)
    .digest("hex");

  params.push(["X-Amz-Signature", signature]);
  const query = canonicalQueryString(params);
  return `${url.protocol}//${url.host}${canonicalPath}?${query}`;
}

function bodyToBytes(data) {
  if (data == null) return new Uint8Array(0);
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return data; // Blob / ReadableStream — pass through to fetch.
}

function signedHeaders(method, path, options, extraHeaders, payloadHash) {
  requireCredentials(options);
  const { url, canonicalPath } = resolveTarget(path, options);
  const { amzDate, dateStamp } = amzTimestamp();
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;

  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${String(headers[name]).trim()}\n`)
    .join("");
  const signedNames = names.join(";");
  const canonicalRequest = [
    method,
    canonicalPath,
    "",
    canonicalHeaders,
    signedNames,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(options, dateStamp))
    .update(stringToSign)
    .digest("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedNames}, Signature=${signature}`;
  delete headers.host; // fetch sets it from the URL.
  return { url: `${url.protocol}//${url.host}${canonicalPath}`, headers };
}

function startRequest(method, path, options, extraHeaders, body) {
  const payloadHash = "UNSIGNED-PAYLOAD";
  const { url, headers } = signedHeaders(method, path, options, extraHeaders, payloadHash);
  return fetch(url, { method, headers, body });
}

async function s3ErrorFromResponse(response, path) {
  const error = new Error(`S3 request failed for "${path}" with status ${response.status}`);
  error.code = response.status === 404 ? "NoSuchKey" : "S3Error";
  error.status = response.status;
  try {
    error.body = await response.text();
  } catch {}
  return error;
}

function writeImpl(path, data, options) {
  checkCRLF(options.contentDisposition, "contentDisposition");
  checkCRLF(options.contentEncoding, "contentEncoding");
  checkCRLF(options.type, "type");
  const headers = {};
  if (options.type) headers["content-type"] = String(options.type);
  if (options.contentDisposition) headers["content-disposition"] = String(options.contentDisposition);
  if (options.contentEncoding) headers["content-encoding"] = String(options.contentEncoding);
  if (options.acl) headers["x-amz-acl"] = String(options.acl);
  if (options.storageClass) headers["x-amz-storage-class"] = String(options.storageClass);
  if (options.sessionToken) headers["x-amz-security-token"] = String(options.sessionToken);
  const body = bodyToBytes(data);
  const size = typeof body?.byteLength === "number" ? body.byteLength : undefined;
  const responsePromise = startRequest("PUT", path, options, headers, body);
  return responsePromise.then(async (response) => {
    if (!response.ok) throw await s3ErrorFromResponse(response, path);
    return size ?? 0;
  });
}

class S3File {
  #path;
  #options;

  constructor(path, options) {
    this.#path = String(path ?? "");
    this.#options = options;
    this.name = this.#path;
  }

  get bucket() {
    try {
      return resolveTarget(this.#path, this.#options).bucket;
    } catch {
      return undefined;
    }
  }

  presign(callOptions = {}) {
    return presignURL(this.#path, { ...this.#options, ...callOptions });
  }

  write(data, callOptions = {}) {
    return writeImpl(this.#path, data, { ...this.#options, ...callOptions });
  }

  async #get() {
    const response = await startRequest("GET", this.#path, this.#options, {}, undefined);
    if (!response.ok) throw await s3ErrorFromResponse(response, this.#path);
    return response;
  }

  async text() {
    return (await this.#get()).text();
  }

  async json() {
    return (await this.#get()).json();
  }

  async arrayBuffer() {
    return (await this.#get()).arrayBuffer();
  }

  async bytes() {
    return new Uint8Array(await this.arrayBuffer());
  }

  stream() {
    let reader;
    const self = this;
    return new ReadableStream({
      async start() {
        const response = await self.#get();
        reader = response.body.getReader();
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel() {
        return reader?.cancel();
      },
    });
  }

  async exists() {
    const response = await startRequest("HEAD", this.#path, this.#options, {}, undefined);
    if (response.status === 404) return false;
    if (!response.ok) throw await s3ErrorFromResponse(response, this.#path);
    return true;
  }

  async stat() {
    const response = await startRequest("HEAD", this.#path, this.#options, {}, undefined);
    if (!response.ok) throw await s3ErrorFromResponse(response, this.#path);
    return {
      size: Number(response.headers.get("content-length") ?? 0),
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified")
        ? new Date(response.headers.get("last-modified"))
        : undefined,
      type: response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  async size() {
    return (await this.stat()).size;
  }

  async unlink() {
    const response = await startRequest("DELETE", this.#path, this.#options, {}, undefined);
    if (!response.ok && response.status !== 404) {
      throw await s3ErrorFromResponse(response, this.#path);
    }
  }

  delete() {
    return this.unlink();
  }

  slice() {
    return this;
  }
}

export class S3Client {
  #options;

  constructor(options = {}) {
    if (typeof options === "string") options = { endpoint: options };
    this.#options = { ...options };
  }

  get options() {
    return { ...this.#options };
  }

  file(path, callOptions = {}) {
    return new S3File(path, resolveOptions(this.#options, callOptions));
  }

  presign(path, callOptions = {}) {
    return presignURL(path, resolveOptions(this.#options, callOptions));
  }

  write(path, data, callOptions = {}) {
    return writeImpl(path, data, resolveOptions(this.#options, callOptions));
  }

  exists(path, callOptions = {}) {
    return this.file(path, callOptions).exists();
  }

  stat(path, callOptions = {}) {
    return this.file(path, callOptions).stat();
  }

  size(path, callOptions = {}) {
    return this.file(path, callOptions).size();
  }

  unlink(path, callOptions = {}) {
    return this.file(path, callOptions).unlink();
  }

  delete(path, callOptions = {}) {
    return this.unlink(path, callOptions);
  }

  static file(path, options = {}) {
    return new S3Client(options).file(path);
  }

  static presign(path, options = {}) {
    return new S3Client(options).presign(path);
  }

  static write(path, data, options = {}) {
    return new S3Client(options).write(path, data);
  }

  static exists(path, options = {}) {
    return new S3Client(options).exists(path);
  }

  static stat(path, options = {}) {
    return new S3Client(options).stat(path);
  }

  static size(path, options = {}) {
    return new S3Client(options).size(path);
  }

  static unlink(path, options = {}) {
    return new S3Client(options).unlink(path);
  }

  static delete(path, options = {}) {
    return new S3Client(options).unlink(path);
  }
}

export const s3 = new Proxy(new S3Client({}), {
  get(target, property, receiver) {
    return Reflect.get(target, property, target);
  },
});

export function s3File(path, options = {}) {
  return new S3Client(options).file(path);
}
