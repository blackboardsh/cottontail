export function asBuffer(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (globalThis.Buffer?.from) return globalThis.Buffer.from(value ?? "");
  return new TextEncoder().encode(String(value ?? ""));
}

export function concatBuffers(left, right) {
  const lhs = asBuffer(left);
  const rhs = asBuffer(right);
  if (globalThis.Buffer?.concat) return globalThis.Buffer.concat([lhs, rhs]);
  const out = new Uint8Array(lhs.length + rhs.length);
  out.set(lhs, 0);
  out.set(rhs, lhs.length);
  return out;
}

export function concatManyBuffers(chunks) {
  if (chunks.length === 1) return asBuffer(chunks[0]);
  if (globalThis.Buffer?.concat) return globalThis.Buffer.concat(chunks.map(asBuffer));
  let length = 0;
  for (const chunk of chunks) length += asBuffer(chunk).length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const bytes = asBuffer(chunk);
    out.set(bytes, offset);
    offset += bytes.length;
  }
  return out;
}
