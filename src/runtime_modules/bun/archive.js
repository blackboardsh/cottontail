import { guessMimeType, pathDirname, write } from "./file-io.js";
import { asBuffer, concatManyBuffers } from "./web-buffer-utils.js";

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
function tmpRoot(kind) {
  const env = cottontail.env();
  return pathJoin(String(env.COTTONTAIL_TMP_DIR || env.TMPDIR || env.TEMP || env.TMP || "/tmp"), "cottontail", kind);
}
function bytesFromData(value) {
  return typeof value === "string" ? new TextEncoder().encode(value) : asBuffer(value);
}
function arrayBufferFromBytes(value) {
  const bytes = asBuffer(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function tarString(bytes, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.slice(offset, end));
}

function tarOctal(bytes, offset, length) {
  const raw = tarString(bytes, offset, length).trim();
  return raw ? parseInt(raw, 8) || 0 : 0;
}

function tarOctalField(value, length) {
  const text = Math.max(0, Number(value) || 0).toString(8).slice(-(length - 1));
  return `${text.padStart(length - 1, "0")}\0`;
}

function tarChecksumField(value) {
  return `${Math.max(0, Number(value) || 0).toString(8).slice(-6).padStart(6, "0")}\0 `;
}

function safeArchivePath(path) {
  const parts = [];
  for (const part of String(path).replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) throw new Error(`Unsafe archive path: ${path}`);
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const normalized = parts.join("/");
  if (!normalized) {
    throw new Error(`Unsafe archive path: ${path}`);
  }
  return normalized;
}

async function archiveEntryBytes(value) {
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return bytesFromData(value);
}

function snapshotArchiveEntryValue(value) {
  if (value instanceof Blob) return value;
  return new Uint8Array(bytesFromData(value));
}

async function tarBytesFromEntries(entries) {
  const encoder = new TextEncoder();
  const chunks = [];
  for (const [entryName, entryValue] of entries) {
    const name = safeArchivePath(entryName);
    const data = await archiveEntryBytes(entryValue);
    const header = new Uint8Array(512);
    const nameBytes = encoder.encode(name);
    if (nameBytes.byteLength > 100) throw new Error(`Archive path is too long: ${name}`);
    header.set(nameBytes, 0);
    header.set(encoder.encode(tarOctalField(0o644, 8)), 100);
    header.set(encoder.encode(tarOctalField(0, 8)), 108);
    header.set(encoder.encode(tarOctalField(0, 8)), 116);
    header.set(encoder.encode(tarOctalField(data.byteLength, 12)), 124);
    header.set(encoder.encode(tarOctalField(Math.floor(Date.now() / 1000), 12)), 136);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(encoder.encode(tarChecksumField(checksum)), 148);
    chunks.push(header, data);
    const padding = (512 - (data.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return concatManyBuffers(chunks);
}

class ArchiveFile {
  constructor(name, bytes, type = "file") {
    this.name = name;
    this.size = bytes.byteLength;
    this.type = type;
    this._bytes = bytes;
  }
  async arrayBuffer() {
    return arrayBufferFromBytes(this._bytes);
  }
  async text() {
    return new TextDecoder().decode(this._bytes);
  }
  async json() {
    return JSON.parse(await this.text());
  }
}

function isTarZeroBlock(bytes, offset) {
  for (let index = 0; index < 512; index += 1) {
    if (bytes[offset + index] !== 0) return false;
  }
  return true;
}

function archivePayloadBytes(bytes) {
  const data = asBuffer(bytes);
  if (data.byteLength >= 2 && data[0] === 0x1f && data[1] === 0x8b) return asBuffer(globalThis.Cottontail.compression.gunzipSync(data));
  return data;
}

function archiveGlobRegExp(pattern) {
  const text = String(pattern).replace(/\\/g, "/");
  if (text === "**") return /^.*$/;
  let source = "^";
  for (let index = 0; index < text.length;) {
    if (text.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (text.startsWith("**", index)) {
      source += ".*";
      index += 2;
      continue;
    }
    const char = text[index++];
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function archiveGlobFilter(glob = undefined) {
  if (glob === undefined) return () => true;
  const patterns = Array.isArray(glob) ? glob : [glob];
  if (patterns.some((pattern) => typeof pattern !== "string")) throw new TypeError("Archive glob patterns must be strings");
  const positive = patterns.filter((pattern) => !pattern.startsWith("!")).map(archiveGlobRegExp);
  const negative = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => archiveGlobRegExp(pattern.slice(1)));
  return (path) => {
    const included = positive.length === 0 || positive.some((pattern) => pattern.test(path));
    return included && !negative.some((pattern) => pattern.test(path));
  };
}

export class Archive {
  constructor(input, options = {}) {
    if (arguments.length === 0 || input == null) throw new TypeError("Bun.Archive requires input");
    if (typeof input !== "object" && typeof input !== "string") throw new TypeError("Bun.Archive input must be an object, Blob, ArrayBuffer, or Uint8Array");
    if (options?.compress === "gzip" && options.level != null) {
      const level = Number(options.level);
      if (!Number.isInteger(level) || level < 1 || level > 12) throw new RangeError("gzip level must be between 1 and 12");
    }
    this._blob = input instanceof Blob ? input : null;
    this._entries = input && typeof input === "object" && !ArrayBuffer.isView(input) && !(input instanceof ArrayBuffer) && !(input instanceof Blob)
      ? Object.entries(input).map(([name, value]) => [name, snapshotArchiveEntryValue(value)])
      : null;
    this._bytes = this._entries || this._blob ? null : new Uint8Array(bytesFromData(input));
    this._options = options ?? {};
    this._files = null;
  }
  static async write(destination, input, options = undefined) {
    if (arguments.length < 2) throw new TypeError("Bun.Archive.write requires a destination and input");
    const archive = input instanceof Archive ? input : new Archive(input, options ?? {});
    return write(destination, await archive.bytes(), { createPath: true });
  }
  async _ensureBytes() {
    if (this._bytes != null) return this._bytes;
    if (this._blob) {
      this._bytes = new Uint8Array(await this._blob.arrayBuffer());
      return this._bytes;
    }
    let bytes = await tarBytesFromEntries(this._entries ?? []);
    if (this._options.compress === "gzip") {
      bytes = globalThis.Cottontail.compression.gzipSync(bytes, { level: Math.max(1, Math.min(9, Number(this._options.level ?? 6))) });
    }
    this._bytes = bytes;
    return bytes;
  }
  _parseFiles() {
    if (this._files) return this._files;
    const files = new Map();
    const bytes = archivePayloadBytes(this._bytes);
    if (bytes.length > 0 && bytes.length % 512 !== 0) throw new Error("Invalid tar archive");
    for (let offset = 0; offset + 512 <= bytes.length;) {
      if (isTarZeroBlock(bytes, offset)) break;
      const name = tarString(bytes, offset, 100);
      const prefix = tarString(bytes, offset + 345, 155);
      const size = tarOctal(bytes, offset + 124, 12);
      const mtime = tarOctal(bytes, offset + 136, 12);
      const typeflag = String.fromCharCode(bytes[offset + 156] || 0);
      if (!name && size === 0) break;
      // POSIX writes "ustar\0"; GNU tar writes "ustar " in the same field.
      const magic = tarString(bytes, offset + 257, 6);
      if (magic && magic !== "ustar" && magic !== "ustar ") {
        throw new Error("Invalid tar archive");
      }
      let path;
      try {
        path = safeArchivePath(prefix ? `${prefix}/${name}` : name);
      } catch {
        offset += 512 + Math.ceil(size / 512) * 512;
        continue;
      }
      const dataOffset = offset + 512;
      if (dataOffset + size > bytes.length) throw new Error("Invalid tar archive");
      if (typeflag === "0" || typeflag === "\0" || typeflag === "") {
        const fileBytes = bytes.slice(dataOffset, dataOffset + size);
        const FileCtor = globalThis.File;
        files.set(path, typeof FileCtor === "function"
          ? new FileCtor([fileBytes], path, { lastModified: mtime > 0 ? mtime * 1000 : Date.now(), type: guessMimeType(path) })
          : new ArchiveFile(path, fileBytes));
      }
      offset = dataOffset + Math.ceil(size / 512) * 512;
    }
    this._files = files;
    return files;
  }
  async files(glob = undefined) {
    if (glob !== undefined && typeof glob !== "string" && !Array.isArray(glob)) throw new TypeError("Archive.files glob must be a string or array");
    await this._ensureBytes();
    const filter = archiveGlobFilter(glob);
    return new Map([...this._parseFiles()].filter(([path]) => filter(path)));
  }
  async extract(destination, options = undefined) {
    if (arguments.length === 0 || destination == null) throw new TypeError("Archive.extract requires a destination path");
    if (typeof destination !== "string") throw new TypeError("Archive.extract destination must be a string");
    const bytes = await this._ensureBytes();
    const dest = String(destination);
    cottontail.mkdirSync(dest, true);
    const extractWithParser = async () => {
      const files = await this.files(options?.glob);
      for (const [path, file] of files) {
        const outPath = pathJoin(dest, path);
        cottontail.mkdirSync(pathDirname(outPath), true);
        cottontail.writeFile(outPath, asBuffer(await file.arrayBuffer()));
      }
      return files.size;
    };
    if (options?.glob !== undefined) return extractWithParser();
    const archiveTmpRoot = tmpRoot("archive");
    cottontail.mkdirSync(archiveTmpRoot, true);
    const tarPath = pathJoin(archiveTmpRoot, `archive-${Date.now()}-${Math.floor(Math.random() * 1000000)}.tar`);
    cottontail.writeFile(tarPath, bytes);
    const result = cottontail.spawnSync("tar", ["-xf", tarPath, "-C", dest], { stdio: "pipe" });
    cottontail.unlinkSync(tarPath);
    if (result.status !== 0) {
      return extractWithParser();
    }
    try {
      return this._parseFiles().size;
    } catch {
      return 0;
    }
  }
  async bytes() {
    return new Uint8Array(await this._ensureBytes());
  }
  async blob() {
    return new Blob([await this.bytes()], { type: this._options.compress === "gzip" ? "application/gzip" : "application/x-tar" });
  }
}
