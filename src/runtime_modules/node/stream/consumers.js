async function chunksFrom(stream) {
  const chunks = [];
  if (stream == null) return chunks;
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

function bytesFrom(chunk) {
  if (chunk == null) return new Uint8Array(0);
  if (typeof chunk === "string") return new TextEncoder().encode(chunk);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return new TextEncoder().encode(String(chunk));
}

async function collectBytes(stream) {
  const chunks = (await chunksFrom(stream)).map(bytesFrom);
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
  return (await collectBytes(stream)).buffer;
}

export async function buffer(stream) {
  const bytes = await collectBytes(stream);
  return globalThis.Buffer?.from ? globalThis.Buffer.from(bytes) : bytes;
}

export async function text(stream) {
  return new TextDecoder().decode(await collectBytes(stream));
}

export async function json(stream) {
  return JSON.parse(await text(stream));
}

export async function blob(stream) {
  const BlobCtor = globalThis.Blob ?? SimpleBlob;
  return new BlobCtor([await collectBytes(stream)]);
}

export default { arrayBuffer, blob, buffer, json, text };
