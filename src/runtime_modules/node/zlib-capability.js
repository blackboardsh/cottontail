import { createLazyFunction as makeLazyFunction, createLazyObject } from "../bun/lazy-runtime.js";

const state = globalThis[Symbol.for("cottontail.capabilityFacade.compression.nodeZlib")] ??= {
  namespace: undefined,
  exports: Object.create(null),
};
const load = () => state.namespace ??= globalThis[Symbol.for("cottontail.capabilityRequire")]("node:zlib");
const lazyFunction = name => state.exports[name] ??= makeLazyFunction(load, name);
const createLazyFunction = (_load, name) => lazyFunction(name);
const lazyObject = name => state.exports[name] ??= createLazyObject(() => ({ [name]: load()[name] }), name);

export const BrotliCompress = lazyFunction("BrotliCompress");
export const BrotliDecompress = lazyFunction("BrotliDecompress");
export const Deflate = lazyFunction("Deflate");
export const DeflateRaw = lazyFunction("DeflateRaw");
export const Gunzip = lazyFunction("Gunzip");
export const Gzip = lazyFunction("Gzip");
export const Inflate = lazyFunction("Inflate");
export const InflateRaw = lazyFunction("InflateRaw");
export const Unzip = lazyFunction("Unzip");
export const ZstdCompress = lazyFunction("ZstdCompress");
export const ZstdDecompress = lazyFunction("ZstdDecompress");

export const crc32 = lazyFunction("crc32");
export const createBrotliCompress = createLazyFunction(load, "createBrotliCompress");
export const createBrotliDecompress = createLazyFunction(load, "createBrotliDecompress");
export const createDeflate = createLazyFunction(load, "createDeflate");
export const createDeflateRaw = createLazyFunction(load, "createDeflateRaw");
export const createGunzip = createLazyFunction(load, "createGunzip");
export const createGzip = createLazyFunction(load, "createGzip");
export const createInflate = createLazyFunction(load, "createInflate");
export const createInflateRaw = createLazyFunction(load, "createInflateRaw");
export const createUnzip = createLazyFunction(load, "createUnzip");
export const createZstdCompress = createLazyFunction(load, "createZstdCompress");
export const createZstdDecompress = createLazyFunction(load, "createZstdDecompress");
export const deflate = createLazyFunction(load, "deflate");
export const deflateRaw = createLazyFunction(load, "deflateRaw");
export const deflateRawSync = createLazyFunction(load, "deflateRawSync");
export const deflateSync = createLazyFunction(load, "deflateSync");
export const gunzip = createLazyFunction(load, "gunzip");
export const gunzipSync = createLazyFunction(load, "gunzipSync");
export const gzip = createLazyFunction(load, "gzip");
export const gzipSync = createLazyFunction(load, "gzipSync");
export const inflate = createLazyFunction(load, "inflate");
export const inflateRaw = createLazyFunction(load, "inflateRaw");
export const inflateRawSync = createLazyFunction(load, "inflateRawSync");
export const inflateSync = createLazyFunction(load, "inflateSync");
export const unzip = createLazyFunction(load, "unzip");
export const unzipSync = createLazyFunction(load, "unzipSync");
export const brotliCompress = createLazyFunction(load, "brotliCompress");
export const brotliCompressSync = createLazyFunction(load, "brotliCompressSync");
export const brotliDecompress = createLazyFunction(load, "brotliDecompress");
export const brotliDecompressSync = createLazyFunction(load, "brotliDecompressSync");
export const zstdCompress = createLazyFunction(load, "zstdCompress");
export const zstdCompressSync = createLazyFunction(load, "zstdCompressSync");
export const zstdDecompress = createLazyFunction(load, "zstdDecompress");
export const zstdDecompressSync = createLazyFunction(load, "zstdDecompressSync");

export const codes = lazyObject("codes");
export const constants = lazyObject("constants");

const defaultExport = state.module ??= {
  BrotliCompress, BrotliDecompress, Deflate, DeflateRaw, Gunzip, Gzip, Inflate,
  InflateRaw, Unzip, ZstdCompress, ZstdDecompress, codes, constants, crc32,
  brotliCompress, brotliCompressSync, brotliDecompress, brotliDecompressSync,
  createBrotliCompress, createBrotliDecompress, createDeflate, createDeflateRaw,
  createGunzip, createGzip, createInflate, createInflateRaw, createUnzip,
  createZstdCompress, createZstdDecompress, deflate, deflateRaw, deflateRawSync,
  deflateSync, gunzip, gunzipSync, gzip, gzipSync, inflate, inflateRaw,
  inflateRawSync, inflateSync, unzip, unzipSync, zstdCompress, zstdCompressSync,
  zstdDecompress, zstdDecompressSync,
};
export default defaultExport;
