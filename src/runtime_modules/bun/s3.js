// Bun.S3Client — AWS SigV4 signing (presigned URLs + header-signed requests)
// over fetch. Covers the S3 API surface exercised by upstream regression
// tests: client/file presign, write with CR/LF header validation, and the
// common convenience methods.

import { createHash, createHmac } from "../node/crypto.js";

const DEFAULT_REGION = "us-east-1";
const DEFAULT_PART_SIZE = 5 * 1024 * 1024;
const STORAGE_CLASSES = new Set([
  "STANDARD",
  "STANDARD_IA",
  "INTELLIGENT_TIERING",
  "EXPRESS_ONEZONE",
  "ONEZONE_IA",
  "GLACIER",
  "GLACIER_IR",
  "REDUCED_REDUNDANCY",
  "OUTPOSTS",
  "DEEP_ARCHIVE",
  "SNOW",
]);

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

function invalidArgument(message) {
  const error = new TypeError(message);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function validateOptions(options) {
  if (
    options.storageClass != null &&
    !STORAGE_CLASSES.has(String(options.storageClass))
  ) {
    throw new TypeError(`Invalid S3 storage class: ${options.storageClass}`);
  }
  return options;
}

function resolveOptions(clientOptions = {}, callOptions = {}) {
  const merged = { ...clientOptions, ...callOptions };
  merged.region ??= env("S3_REGION") ?? env("AWS_REGION") ?? DEFAULT_REGION;
  merged.accessKeyId ??= env("S3_ACCESS_KEY_ID") ?? env("AWS_ACCESS_KEY_ID");
  merged.secretAccessKey ??= env("S3_SECRET_ACCESS_KEY") ?? env("AWS_SECRET_ACCESS_KEY");
  merged.sessionToken ??= env("S3_SESSION_TOKEN") ?? env("AWS_SESSION_TOKEN");
  merged.bucket ??= env("S3_BUCKET") ?? env("AWS_BUCKET");
  merged.endpoint ??= env("S3_ENDPOINT") ?? env("AWS_ENDPOINT");
  return validateOptions(merged);
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
  let endpoint = options.endpoint;
  if (!endpoint) {
    endpoint = options.virtualHostedStyle
      ? `https://${awsEncode(bucket)}.s3.${options.region}.amazonaws.com`
      : `https://s3.${options.region}.amazonaws.com`;
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(String(endpoint))) {
    endpoint = `https://${endpoint}`;
  }
  endpoint = String(endpoint).replace(/\/+$/, "");
  const url = new URL(endpoint);
  const endpointPath = url.pathname.replace(/\/+$/, "");
  const bucketPath = options.virtualHostedStyle ? "" : `/${awsEncode(bucket)}`;
  const canonicalPath = `${endpointPath}${bucketPath}/${encodeKeyPath(key)}` || "/";
  return { bucket, key, url, canonicalPath };
}

function requireCredentials(options) {
  if (!options.accessKeyId || !options.secretAccessKey) {
    const error = new Error(
      "Missing S3 credentials. 'accessKeyId', 'secretAccessKey', 'bucket', and 'endpoint' are required",
    );
    error.code = "ERR_S3_MISSING_CREDENTIALS";
    throw error;
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
  if (options.requestPayer) params.push(["x-amz-request-payer", "requester"]);
  if (options.storageClass) params.push(["x-amz-storage-class", String(options.storageClass)]);
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

function normalizeHeaderValue(value) {
  return String(value).trim().replace(/[ \t]+/g, " ");
}

function signedHeaders(method, path, options, extraHeaders, payloadHash, queryParams = []) {
  requireCredentials(options);
  const { url, canonicalPath } = resolveTarget(path, options);
  const { amzDate, dateStamp } = amzTimestamp();
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;

  const headers = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  for (const [name, value] of Object.entries(extraHeaders || {})) {
    headers[String(name).toLowerCase()] = value;
  }
  if (options.sessionToken) {
    headers["x-amz-security-token"] = String(options.sessionToken);
  }
  if (options.requestPayer) {
    headers["x-amz-request-payer"] = "requester";
  }
  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${normalizeHeaderValue(headers[name])}\n`)
    .join("");
  const signedNames = names.join(";");
  const canonicalQuery = canonicalQueryString(queryParams);
  const canonicalRequest = [
    method,
    canonicalPath,
    canonicalQuery,
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
  const query = canonicalQuery ? `?${canonicalQuery}` : "";
  return { url: `${url.protocol}//${url.host}${canonicalPath}${query}`, headers };
}

function startRequest(method, path, options, extraHeaders, body, queryParams = []) {
  const payloadHash = "UNSIGNED-PAYLOAD";
  const { url, headers } = signedHeaders(
    method,
    path,
    options,
    extraHeaders,
    payloadHash,
    queryParams,
  );
  return fetch(url, { method, headers, body });
}

async function s3ErrorFromResponse(response, path) {
  let body = "";
  try {
    body = await response.text();
  } catch {}
  const code = xmlElementText(body, "Code") ||
    (response.status === 404 ? "NoSuchKey" : "UnknownError");
  const message = xmlElementText(body, "Message") ||
    `S3 request failed for "${path}" with status ${response.status}`;
  const error = new Error(message);
  error.code = code;
  error.status = response.status;
  error.body = body;
  return error;
}

function findXmlElement(xml, tag, from = 0, limit = xml.length) {
  const opening = `<${tag}`;
  const closing = `</${tag}>`;
  let start = from;
  while ((start = xml.indexOf(opening, start)) !== -1 && start < limit) {
    const boundary = xml.charCodeAt(start + opening.length);
    if (boundary !== 62 && boundary !== 47 && boundary !== 32 && boundary !== 9 && boundary !== 10 && boundary !== 13) {
      start += opening.length;
      continue;
    }
    const contentStart = xml.indexOf(">", start + opening.length);
    if (contentStart === -1 || contentStart >= limit) return null;
    const end = xml.indexOf(closing, contentStart + 1);
    if (end === -1 || end > limit) return null;
    return {
      start,
      contentStart: contentStart + 1,
      end,
      next: end + closing.length,
    };
  }
  return null;
}

function decodeXmlText(value) {
  if (!value.includes("&")) return value;
  return value.replace(
    /&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      switch (entity.toLowerCase()) {
        case "&quot;": return '"';
        case "&apos;": return "'";
        case "&amp;": return "&";
        case "&lt;": return "<";
        case "&gt;": return ">";
        default: {
          const hexadecimal = entity[2]?.toLowerCase() === "x";
          const digits = entity.slice(hexadecimal ? 3 : 2, -1);
          const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
          if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return entity;
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return entity;
          }
        }
      }
    },
  );
}

function xmlElementText(xml, tag, from = 0, limit = xml.length) {
  const element = findXmlElement(xml, tag, from, limit);
  if (!element) return null;
  return decodeXmlText(xml.slice(element.contentStart, element.end));
}

function parseInteger(value) {
  if (value == null || value === "" || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseListObjectContents(xml) {
  const key = xmlElementText(xml, "Key");
  if (key == null) return null;
  const result = { key };

  const eTag = xmlElementText(xml, "ETag");
  const lastModified = xmlElementText(xml, "LastModified");
  const size = parseInteger(xmlElementText(xml, "Size"));
  const storageClass = xmlElementText(xml, "StorageClass");
  const checksumType = xmlElementText(xml, "ChecksumType");
  const checksumAlgorithme = xmlElementText(xml, "ChecksumAlgorithm");
  if (eTag != null) result.eTag = eTag;
  if (lastModified != null) result.lastModified = lastModified;
  if (size !== undefined) result.size = size;
  if (storageClass != null) result.storageClass = storageClass;
  if (checksumType != null) result.checksumType = checksumType;
  if (checksumAlgorithme != null) result.checksumAlgorithme = checksumAlgorithme;

  const ownerElement = findXmlElement(xml, "Owner");
  if (ownerElement) {
    const ownerXml = xml.slice(ownerElement.contentStart, ownerElement.end);
    const id = xmlElementText(ownerXml, "ID");
    const displayName = xmlElementText(ownerXml, "DisplayName");
    const owner = {};
    if (id) owner.id = id;
    if (displayName) owner.displayName = displayName;
    if (Object.keys(owner).length > 0) result.owner = owner;
  }
  return result;
}

function parseListObjectsXml(xml) {
  const root = findXmlElement(xml, "ListBucketResult");
  if (!root) return {};

  const result = {};
  const contents = [];
  const commonPrefixes = [];
  const scalarFields = {
    Name: ["name", "string"],
    Prefix: ["prefix", "nonempty"],
    KeyCount: ["keyCount", "number"],
    MaxKeys: ["maxKeys", "number"],
    Delimiter: ["delimiter", "string"],
    EncodingType: ["encodingType", "string"],
    IsTruncated: ["isTruncated", "boolean"],
    ContinuationToken: ["continuationToken", "string"],
    NextContinuationToken: ["nextContinuationToken", "string"],
    StartAfter: ["startAfter", "string"],
  };

  let cursor = root.contentStart;
  while (cursor < root.end) {
    const start = xml.indexOf("<", cursor);
    if (start === -1 || start >= root.end) break;
    const openingEnd = xml.indexOf(">", start + 1);
    if (openingEnd === -1 || openingEnd >= root.end) break;
    const rawTag = xml.slice(start + 1, openingEnd).trim();
    if (!rawTag || rawTag[0] === "/" || rawTag[0] === "?" || rawTag[0] === "!") {
      cursor = openingEnd + 1;
      continue;
    }
    const tag = rawTag.split(/[\s/]/, 1)[0];
    const element = findXmlElement(xml, tag, start, root.end);
    if (!element || element.start !== start) {
      cursor = openingEnd + 1;
      continue;
    }

    if (tag === "Contents") {
      const item = parseListObjectContents(xml.slice(element.contentStart, element.end));
      if (item) contents.push(item);
      cursor = element.next;
      continue;
    }

    if (tag === "CommonPrefixes") {
      const group = xml.slice(element.contentStart, element.end);
      let prefixCursor = 0;
      while (prefixCursor < group.length) {
        const prefix = findXmlElement(group, "Prefix", prefixCursor);
        if (!prefix) break;
        commonPrefixes.push({
          prefix: decodeXmlText(group.slice(prefix.contentStart, prefix.end)),
        });
        prefixCursor = prefix.next;
      }
      cursor = element.next;
      continue;
    }

    const descriptor = scalarFields[tag];
    if (descriptor) {
      const value = decodeXmlText(xml.slice(element.contentStart, element.end));
      const [property, kind] = descriptor;
      if (kind === "number") {
        const number = parseInteger(value);
        if (number !== undefined) result[property] = number;
      } else if (kind === "boolean") {
        if (value === "true") result[property] = true;
        else if (value === "false") result[property] = false;
      } else if (kind !== "nonempty" || value.length > 0) {
        result[property] = value;
      }
      cursor = element.next;
      continue;
    }

    cursor = openingEnd + 1;
  }

  if (contents.length > 0) result.contents = contents;
  if (commonPrefixes.length > 0) result.commonPrefixes = commonPrefixes;
  return result;
}

function listQueryParams(listOptions) {
  const params = [];
  if (typeof listOptions.continuationToken === "string" && listOptions.continuationToken) {
    params.push(["continuation-token", listOptions.continuationToken]);
  }
  if (typeof listOptions.delimiter === "string" && listOptions.delimiter) {
    params.push(["delimiter", listOptions.delimiter]);
  }
  if (typeof listOptions.encodingType === "string" && listOptions.encodingType) {
    params.push(["encoding-type", "url"]);
  }
  if (typeof listOptions.fetchOwner === "boolean") {
    params.push(["fetch-owner", String(listOptions.fetchOwner)]);
  }
  params.push(["list-type", "2"]);
  if (typeof listOptions.maxKeys === "number" && Number.isFinite(listOptions.maxKeys) && listOptions.maxKeys !== 0) {
    params.push(["max-keys", String(Math.trunc(listOptions.maxKeys))]);
  }
  if (typeof listOptions.prefix === "string" && listOptions.prefix) {
    params.push(["prefix", listOptions.prefix]);
  }
  if (typeof listOptions.startAfter === "string" && listOptions.startAfter) {
    params.push(["start-after", listOptions.startAfter]);
  }
  return params;
}

async function listImpl(listOptions, options) {
  if (listOptions == null) listOptions = {};
  if (typeof listOptions !== "object" || Array.isArray(listOptions)) {
    throw invalidArgument('The "options" argument must be of type object');
  }
  requireCredentials(options);
  const response = await startRequest(
    "GET",
    "",
    options,
    {},
    undefined,
    listQueryParams(listOptions),
  );
  if (!response.ok) throw await s3ErrorFromResponse(response, "");
  return parseListObjectsXml(await response.text());
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
  const body = bodyToBytes(data);
  const size = typeof body?.byteLength === "number" ? body.byteLength : undefined;
  const responsePromise = startRequest("PUT", path, options, headers, body);
  return responsePromise.then(async (response) => {
    if (!response.ok) throw await s3ErrorFromResponse(response, path);
    return size ?? 0;
  });
}

function uploadHeaders(options) {
  const headers = {};
  if (options.type) headers["content-type"] = String(options.type);
  if (options.contentDisposition) headers["content-disposition"] = String(options.contentDisposition);
  if (options.contentEncoding) headers["content-encoding"] = String(options.contentEncoding);
  if (options.acl) headers["x-amz-acl"] = String(options.acl);
  if (options.storageClass) headers["x-amz-storage-class"] = String(options.storageClass);
  return headers;
}

function writerChunkToBytes(data) {
  const bytes = bodyToBytes(data);
  if (bytes instanceof Uint8Array) return new Uint8Array(bytes);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes.slice(0));
  if (bytes && typeof bytes.arrayBuffer === "function") {
    return Promise.resolve(bytes.arrayBuffer()).then((buffer) => new Uint8Array(buffer));
  }
  throw invalidArgument("S3 writer data must be a string, Blob, ArrayBuffer, or ArrayBufferView");
}

function copyChunkRange(chunks, start, length) {
  let chunkOffset = 0;
  let first = null;
  let firstStart = 0;
  let remaining = length;
  const slices = [];
  for (const chunk of chunks) {
    const chunkEnd = chunkOffset + chunk.byteLength;
    if (chunkEnd <= start) {
      chunkOffset = chunkEnd;
      continue;
    }
    const localStart = Math.max(0, start - chunkOffset);
    const take = Math.min(chunk.byteLength - localStart, remaining);
    if (take > 0) {
      if (!first) {
        first = chunk;
        firstStart = localStart;
      }
      slices.push(chunk.subarray(localStart, localStart + take));
      remaining -= take;
      if (remaining === 0) break;
    }
    chunkOffset = chunkEnd;
  }
  if (remaining !== 0) throw new Error("S3 writer buffer accounting failed");
  if (slices.length === 1) return first.subarray(firstStart, firstStart + length);
  const output = new Uint8Array(length);
  let outputOffset = 0;
  for (const slice of slices) {
    output.set(slice, outputOffset);
    outputOffset += slice.byteLength;
  }
  return output;
}

function escapeXmlText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function createS3Writer(path, baseOptions, callOptions = {}) {
  const options = resolveOptions(baseOptions, callOptions);
  checkCRLF(options.contentDisposition, "contentDisposition");
  checkCRLF(options.contentEncoding, "contentEncoding");
  checkCRLF(options.type, "type");
  const configuredPartSize = Number(options.partSize ?? DEFAULT_PART_SIZE);
  const partSize = Number.isFinite(configuredPartSize) && configuredPartSize > 0
    ? Math.trunc(configuredPartSize)
    : DEFAULT_PART_SIZE;

  const chunks = [];
  const uploadedParts = [];
  let totalSize = 0;
  let uploadedSize = 0;
  let uploadId = null;
  let nextPartNumber = 1;
  let ended = false;
  let operation = Promise.resolve();

  function appendBytes(bytes) {
    chunks.push(bytes);
    totalSize += bytes.byteLength;
    return bytes.byteLength;
  }

  async function ensureMultipartUpload() {
    if (uploadId != null) return;
    const response = await startRequest(
      "POST",
      path,
      options,
      uploadHeaders(options),
      undefined,
      [["uploads", ""]],
    );
    if (!response.ok) throw await s3ErrorFromResponse(response, path);
    const responseText = await response.text();
    uploadId = xmlElementText(responseText, "UploadId");
    if (!uploadId) {
      const error = new Error("S3 multipart upload response did not contain an UploadId");
      error.code = "UnknownError";
      error.body = responseText;
      throw error;
    }
  }

  async function uploadPart(bytes) {
    await ensureMultipartUpload();
    const partNumber = nextPartNumber++;
    const response = await startRequest(
      "PUT",
      path,
      options,
      {},
      bytes,
      [
        ["partNumber", String(partNumber)],
        ["uploadId", uploadId],
        ["x-id", "UploadPart"],
      ],
    );
    if (!response.ok) throw await s3ErrorFromResponse(response, path);
    const eTag = response.headers.get("etag");
    if (!eTag) {
      const error = new Error(`S3 multipart part ${partNumber} response did not contain an ETag`);
      error.code = "UnknownError";
      throw error;
    }
    uploadedParts.push({ partNumber, eTag });
  }

  async function flushOne(force) {
    const available = totalSize - uploadedSize;
    if (available === 0 || (!force && available < partSize)) return 0;
    const size = force ? Math.min(partSize, available) : partSize;
    const bytes = copyChunkRange(chunks, uploadedSize, size);
    await uploadPart(bytes);
    uploadedSize += size;
    return size;
  }

  async function abortMultipartUpload() {
    if (!uploadId) return;
    try {
      await startRequest(
        "DELETE",
        path,
        options,
        {},
        undefined,
        [["uploadId", uploadId]],
      );
    } catch {}
  }

  async function completeMultipartUpload() {
    const partsXml = uploadedParts
      .map(({ partNumber, eTag }) =>
        `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeXmlText(eTag)}</ETag></Part>`)
      .join("");
    const body = new TextEncoder().encode(
      `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`,
    );
    const response = await startRequest(
      "POST",
      path,
      options,
      { "content-type": "application/xml" },
      body,
      [["uploadId", uploadId]],
    );
    if (!response.ok) throw await s3ErrorFromResponse(response, path);
    const responseText = await response.text();
    if (responseText.includes("<Error>")) {
      const code = xmlElementText(responseText, "Code") || "UnknownError";
      const error = new Error(xmlElementText(responseText, "Message") || "S3 multipart upload failed");
      error.code = code;
      error.body = responseText;
      throw error;
    }
  }

  async function finish() {
    if (uploadId == null && totalSize < partSize) {
      const bytes = copyChunkRange(chunks, 0, totalSize);
      await writeImpl(path, bytes, options);
      return totalSize;
    }
    try {
      await ensureMultipartUpload();
      while (uploadedSize < totalSize) await flushOne(true);
      await completeMultipartUpload();
      return totalSize;
    } catch (error) {
      await abortMultipartUpload();
      throw error;
    }
  }

  return {
    write(data) {
      if (ended) throw new TypeError("Cannot write to an ended S3 writer");
      const bytes = writerChunkToBytes(data);
      if (bytes && typeof bytes.then === "function") {
        operation = operation.then(() => bytes).then(appendBytes);
        return operation;
      }
      return appendBytes(bytes);
    },
    flush() {
      if (ended) return Promise.resolve(0);
      operation = operation.then(() => flushOne(false));
      return operation;
    },
    end(data) {
      if (ended) return operation;
      if (data !== undefined) this.write(data);
      ended = true;
      operation = operation.then(finish);
      return operation;
    },
  };
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
    return presignURL(this.#path, resolveOptions(this.#options, callOptions));
  }

  write(data, callOptions = {}) {
    return writeImpl(this.#path, data, resolveOptions(this.#options, callOptions));
  }

  writer(callOptions = {}) {
    return createS3Writer(this.#path, this.#options, callOptions);
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

  async formData() {
    return (await this.#get()).formData();
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

  list(listOptions, callOptions = {}) {
    return listImpl(listOptions, resolveOptions(this.#options, callOptions));
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

  static list(listOptions, options = {}) {
    return new S3Client(options).list(listOptions);
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

const defaultS3Client = new S3Client({});
const defaultS3Methods = new Map();

export const s3 = new Proxy(defaultS3Client, {
  get(target, property) {
    const value = Reflect.get(target, property, target);
    if (typeof value !== "function") return value;
    if (!defaultS3Methods.has(property)) {
      defaultS3Methods.set(property, value.bind(target));
    }
    return defaultS3Methods.get(property);
  },
});

export function s3File(path, options = {}) {
  return new S3Client(options).file(path);
}
