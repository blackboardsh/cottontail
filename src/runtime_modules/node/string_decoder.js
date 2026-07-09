function bytesFrom(input) {
  if (input == null) return new Uint8Array(0);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input === "string") return new TextEncoder().encode(input);
  return new Uint8Array(0);
}

function incompleteUtf8Bytes(bytes) {
  const length = bytes.byteLength;
  if (length === 0) return 0;
  let start = length - 1;
  while (start >= 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
  if (start < 0) return Math.min(length, 3);
  const first = bytes[start];
  let expected = 1;
  if ((first & 0xe0) === 0xc0) expected = 2;
  else if ((first & 0xf0) === 0xe0) expected = 3;
  else if ((first & 0xf8) === 0xf0) expected = 4;
  const available = length - start;
  return available < expected ? available : 0;
}

export class StringDecoder {
  constructor(encoding = "utf8") {
    this.encoding = String(encoding || "utf8").toLowerCase();
    this.lastNeed = 0;
    this.lastTotal = 0;
    this.lastChar = new Uint8Array(4);
    this._pending = new Uint8Array(0);
    this._decoder = new TextDecoder(this.encoding === "utf8" || this.encoding === "utf-8" ? "utf-8" : this.encoding);
  }

  write(input) {
    const current = bytesFrom(input);
    const combined = new Uint8Array(this._pending.byteLength + current.byteLength);
    combined.set(this._pending, 0);
    combined.set(current, this._pending.byteLength);

    const pending = this.encoding === "utf8" || this.encoding === "utf-8" ? incompleteUtf8Bytes(combined) : 0;
    const complete = pending ? combined.subarray(0, combined.byteLength - pending) : combined;
    this._pending = pending ? combined.slice(combined.byteLength - pending) : new Uint8Array(0);
    this.lastNeed = pending;
    this.lastTotal = pending;
    this.lastChar.set(new Uint8Array(4));
    this.lastChar.set(this._pending.subarray(0, 4));
    return complete.byteLength === 0 ? "" : this._decoder.decode(complete, { stream: true });
  }

  end(input = undefined) {
    const text = input == null ? "" : this.write(input);
    const rest = this._pending.byteLength === 0 ? "" : this._decoder.decode(this._pending);
    this._pending = new Uint8Array(0);
    this.lastNeed = 0;
    return text + rest;
  }
}

export default { StringDecoder };
