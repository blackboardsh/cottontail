async function chunksFrom(stream) {
  const chunks = [];
  if (stream == null) {
    throw nodeTypeError("The stream argument must be an iterable or readable stream", "ERR_INVALID_ARG_TYPE");
  }
  if (stream.locked === true && typeof stream.getReader === "function") {
    throw nodeTypeError("Invalid state: ReadableStream is locked", "ERR_INVALID_STATE");
  }
  if (typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) chunks.push(chunk);
    return chunks;
  }
  if (typeof stream[Symbol.iterator] === "function") {
    for (const chunk of stream) chunks.push(chunk);
    return chunks;
  }
  return await new Promise((resolve, reject) => {
    stream.on?.("data", (chunk) => chunks.push(chunk));
    stream.once?.("end", () => resolve(chunks));
    stream.once?.("finish", () => resolve(chunks));
    stream.once?.("error", reject);
  });
}

function nodeTypeError(message, code) {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function bytesFrom(chunk) {
  if (chunk == null) return new Uint8Array(0);
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new TextEncoder().encode(String(chunk));
}

class SimpleBlob {
  constructor(parts = [], options = {}) {
    this.type = String(options.type ?? "");
    this._bytes = parts.reduce((acc, part) => {
      const bytes = bytesFrom(part);
      const out = new Uint8Array(acc.byteLength + bytes.byteLength);
      out.set(acc, 0);
      out.set(bytes, acc.byteLength);
      return out;
    }, new Uint8Array(0));
    this.size = this._bytes.byteLength;
  }
  async arrayBuffer() { return this._bytes.slice().buffer; }
  async text() { return new TextDecoder().decode(this._bytes); }
}

export async function arrayBuffer(stream) {
  return await (await blob(stream)).arrayBuffer();
}

export async function buffer(stream) {
  const bytes = new Uint8Array(await arrayBuffer(stream));
  return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes;
}

export async function text(stream) {
  const decoder = new TextDecoder();
  let result = "";
  for (const chunk of await chunksFrom(stream)) {
    if (typeof chunk === "string") {
      result += chunk;
    } else if (chunk instanceof ArrayBuffer || ArrayBuffer.isView(chunk)) {
      result += decoder.decode(bytesFrom(chunk), { stream: true });
    } else {
      throw nodeTypeError(
        'The "input" argument must be an instance of SharedArrayBuffer, ArrayBuffer or ArrayBufferView',
        "ERR_INVALID_ARG_TYPE",
      );
    }
  }
  result += decoder.decode();
  return result;
}

export async function json(stream) {
  return JSON.parse(await text(stream));
}

export async function blob(stream) {
  const BlobCtor = globalThis.Blob ?? SimpleBlob;
  return new BlobCtor(await chunksFrom(stream));
}

export default { arrayBuffer, blob, buffer, json, text };
