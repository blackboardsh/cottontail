export const jscValueSerializationFormatVersion = 1;

function encodeBytes(bytes) {
  return Array.from(bytes);
}

function bytesFromArray(values) {
  return new Uint8Array(values);
}

const typedArrayTypes = new Set([
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "DataView",
]);
const storageBunFileBrand = Symbol.for("cottontail.bunJSCStorageBunFile");
const structuredCloneHook = Symbol.for("cottontail.structuredClone");

function isBunFile(value) {
  return value?.[storageBunFileBrand] === true ||
    (typeof value?.exists === "function" && typeof value?.writer === "function");
}

function isBlockList(value) {
  return value?.constructor?.name === "BlockList" &&
    typeof value?.addAddress === "function" &&
    typeof value?.check === "function" &&
    typeof value?.[structuredCloneHook] === "function";
}

function bunFileBytes(value) {
  if (value?._bytes instanceof Uint8Array) return value._bytes.slice();
  if (typeof value?._getBytes === "function") return value._getBytes();
  let bytes = new Uint8Array(Math.max(0, Number(value?.size) || 0));
  if (typeof value?._bunFilePath === "string") {
    try { bytes = new Uint8Array(globalThis.cottontail.readFileBuffer(value._bunFilePath)); } catch {}
  }
  return bytes;
}

function storageBunFile(encoded) {
  const bytes = bytesFromArray(encoded.bytes);
  const type = String(encoded.mime ?? "");
  const blob = {};
  Object.defineProperties(blob, {
    [storageBunFileBrand]: { value: true },
    [Symbol.toStringTag]: { value: "Blob" },
    _bytes: { value: bytes },
    name: { value: String(encoded.name ?? "") },
    type: { value: type },
    size: { value: bytes.byteLength },
    lastModified: { value: Number(encoded.lastModified ?? 0) },
    arrayBuffer: { value: async () => bytes.slice().buffer },
    bytes: { value: async () => bytes.slice() },
    text: { value: async () => new TextDecoder().decode(bytes) },
    slice: { value: (...args) => new globalThis.Blob([bytes], { type }).slice(...args) },
    stream: { value: () => new globalThis.Blob([bytes], { type }).stream() },
  });
  return blob;
}

function viewTypeName(value) {
  if (globalThis.Buffer?.isBuffer?.(value)) return "Buffer";
  const name = value?.constructor?.name;
  return typedArrayTypes.has(name) ? name : "Uint8Array";
}

function encodeValue(value, state) {
  if (value === undefined) return { type: "undefined" };
  if (value === null) return { type: "null" };
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { type: "number", value: "NaN" };
    if (value === Infinity) return { type: "number", value: "Infinity" };
    if (value === -Infinity) return { type: "number", value: "-Infinity" };
    if (Object.is(value, -0)) return { type: "number", value: "-0" };
    return { type: "number", value };
  }
  if (typeof value === "boolean" || typeof value === "string") return { type: typeof value, value };
  if (typeof value === "bigint") return { type: "bigint", value: value.toString() };
  if (typeof value === "symbol" || typeof value === "function") throw new Error("Unserializable value");

  const existingId = state.ids.get(value);
  if (existingId != null) return { type: "Ref", id: existingId };
  const id = state.nextId++;
  state.ids.set(value, id);

  if (value instanceof Date) return { type: "Date", id, value: value.toISOString() };
  if (value instanceof RegExp) return { type: "RegExp", id, source: value.source, flags: value.flags };
  if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", id, bytes: encodeBytes(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return {
      type: viewTypeName(value),
      id,
      bytes: encodeBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (value instanceof Map) {
    return { type: "Map", id, value: [...value].map(([key, item]) => [encodeValue(key, state), encodeValue(item, state)]) };
  }
  if (value instanceof Set) return { type: "Set", id, value: [...value].map((item) => encodeValue(item, state)) };
  if (Array.isArray(value)) return { type: "Array", id, value: value.map((item) => encodeValue(item, state)) };
  if (value instanceof Error) return { type: "Error", id, name: value.name, message: value.message, stack: value.stack };
  if (state.forStorage && isBlockList(value)) return { type: "Object", id, value: [] };
  if (isBunFile(value)) {
    const bytes = bunFileBytes(value);
    return {
      type: state.forStorage ? "StorageBunFile" : "File",
      id,
      bytes: encodeBytes(bytes),
      mime: String(value.type ?? ""),
      name: String(value.name ?? ""),
      lastModified: Number(value.lastModified ?? 0),
    };
  }
  if (typeof globalThis.Blob === "function" && value instanceof globalThis.Blob) {
    const bytes = value._bytes instanceof Uint8Array
      ? value._bytes
      : typeof value._getBytes === "function" ? value._getBytes() : new Uint8Array(0);
    if (typeof globalThis.File === "function" && value instanceof globalThis.File) {
      return {
        type: "File",
        id,
        bytes: encodeBytes(bytes),
        mime: String(value.type ?? ""),
        name: String(value.name ?? ""),
        lastModified: Number(value.lastModified ?? 0),
      };
    }
    return { type: "Blob", id, bytes: encodeBytes(bytes), mime: String(value.type ?? "") };
  }
  return { type: "Object", id, value: Object.entries(value).map(([key, item]) => [key, encodeValue(item, state)]) };
}

function remember(refs, encoded, value) {
  if (encoded?.id != null) refs.set(encoded.id, value);
  return value;
}

function decodeTypedArray(encoded, constructor) {
  return new constructor(bytesFromArray(encoded.bytes).buffer);
}

function decodeValue(encoded, refs = new Map()) {
  switch (encoded?.type) {
    case "Ref": {
      if (!refs.has(encoded.id)) throw new Error("Invalid serialized Cottontail v8 reference");
      return refs.get(encoded.id);
    }
    case "undefined": return undefined;
    case "null": return null;
    case "boolean":
    case "string": return encoded.value;
    case "number": {
      if (encoded.value === "NaN") return NaN;
      if (encoded.value === "Infinity") return Infinity;
      if (encoded.value === "-Infinity") return -Infinity;
      if (encoded.value === "-0") return -0;
      return Number(encoded.value);
    }
    case "bigint": return BigInt(encoded.value);
    case "Date": return remember(refs, encoded, new Date(encoded.value));
    case "RegExp": return remember(refs, encoded, new RegExp(encoded.source, encoded.flags));
    case "ArrayBuffer": return remember(refs, encoded, bytesFromArray(encoded.bytes).buffer);
    case "Uint8Array": return remember(refs, encoded, bytesFromArray(encoded.bytes));
    case "Buffer": {
      const bytes = bytesFromArray(encoded.bytes);
      const value = typeof globalThis.Buffer?.from === "function" ? globalThis.Buffer.from(bytes) : bytes;
      return remember(refs, encoded, value);
    }
    case "Int8Array": return remember(refs, encoded, decodeTypedArray(encoded, Int8Array));
    case "Uint8ClampedArray": return remember(refs, encoded, decodeTypedArray(encoded, Uint8ClampedArray));
    case "Int16Array": return remember(refs, encoded, decodeTypedArray(encoded, Int16Array));
    case "Uint16Array": return remember(refs, encoded, decodeTypedArray(encoded, Uint16Array));
    case "Int32Array": return remember(refs, encoded, decodeTypedArray(encoded, Int32Array));
    case "Uint32Array": return remember(refs, encoded, decodeTypedArray(encoded, Uint32Array));
    case "Float32Array": return remember(refs, encoded, decodeTypedArray(encoded, Float32Array));
    case "Float64Array": return remember(refs, encoded, decodeTypedArray(encoded, Float64Array));
    case "BigInt64Array": return remember(refs, encoded, decodeTypedArray(encoded, BigInt64Array));
    case "BigUint64Array": return remember(refs, encoded, decodeTypedArray(encoded, BigUint64Array));
    case "DataView": return remember(refs, encoded, new DataView(bytesFromArray(encoded.bytes).buffer));
    case "Map": {
      const map = remember(refs, encoded, new Map());
      for (const [key, value] of encoded.value) map.set(decodeValue(key, refs), decodeValue(value, refs));
      return map;
    }
    case "Set": {
      const set = remember(refs, encoded, new Set());
      for (const value of encoded.value) set.add(decodeValue(value, refs));
      return set;
    }
    case "Array": {
      const array = remember(refs, encoded, []);
      for (let index = 0; index < encoded.value.length; index += 1) array[index] = decodeValue(encoded.value[index], refs);
      return array;
    }
    case "Error": {
      const error = new Error(encoded.message);
      error.name = encoded.name;
      error.stack = encoded.stack;
      return remember(refs, encoded, error);
    }
    case "Blob":
      return remember(refs, encoded, new globalThis.Blob([bytesFromArray(encoded.bytes)], { type: encoded.mime ?? "" }));
    case "File":
      return remember(refs, encoded, new globalThis.File([bytesFromArray(encoded.bytes)], encoded.name ?? "", {
        type: encoded.mime ?? "",
        lastModified: Number(encoded.lastModified ?? 0),
      }));
    case "StorageBunFile":
      return remember(refs, encoded, storageBunFile(encoded));
    case "Object": {
      const object = remember(refs, encoded, {});
      for (const [key, value] of encoded.value) object[key] = decodeValue(value, refs);
      return object;
    }
    default: throw new Error("Invalid serialized Cottontail v8 payload");
  }
}

function payloadText(payload) {
  if (typeof payload === "string") return payload;
  if (payload instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(payload));
  if (ArrayBuffer.isView(payload)) {
    return new TextDecoder().decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  }
  return String(payload);
}

export function serializeJscValue(value, options = undefined) {
  const state = {
    ids: new WeakMap(),
    nextId: 1,
    forStorage: options?.forStorage === true,
  };
  const payload = JSON.stringify({
    cottontailV8: jscValueSerializationFormatVersion,
    value: encodeValue(value, state),
  });
  return new TextEncoder().encode(payload);
}

export function deserializeJscValue(payload) {
  const parsed = JSON.parse(payloadText(payload));
  if (parsed.cottontailV8 !== jscValueSerializationFormatVersion) {
    throw new Error("Unsupported Cottontail v8 serialization format");
  }
  return decodeValue(parsed.value);
}
