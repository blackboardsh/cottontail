import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertStrippedReleaseBinary,
  elfExportSymbolsFromVersionScript,
  inspectReleaseBinary,
  listExportedSymbols,
  peExportSymbolsFromModuleDefinition,
  restrictElfDynamicExports,
  restrictPortableExecutableExports,
} from './release-binary-contract.js';

function machoFixture(localSymbols) {
  const buffer = Buffer.alloc(32 + 24 + 80);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(2, 16);
  buffer.writeUInt32LE(104, 20);

  let offset = 32;
  buffer.writeUInt32LE(0x2, offset);
  buffer.writeUInt32LE(24, offset + 4);
  buffer.writeUInt32LE(localSymbols + 5, offset + 12);
  buffer.writeUInt32LE(localSymbols === 0 ? 64 : 8192, offset + 20);

  offset += 24;
  buffer.writeUInt32LE(0xb, offset);
  buffer.writeUInt32LE(80, offset + 4);
  buffer.writeUInt32LE(localSymbols, offset + 12);
  buffer.writeUInt32LE(2, offset + 20);
  buffer.writeUInt32LE(3, offset + 28);
  return buffer;
}

function elfFixture(withStaticSymbols) {
  const buffer = Buffer.alloc(128);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  buffer.writeBigUInt64LE(64n, 40);
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(1, 60);
  buffer.writeUInt32LE(withStaticSymbols ? 2 : 3, 68);
  buffer.writeBigUInt64LE(withStaticSymbols ? 4096n : 32n, 96);
  return buffer;
}

function peFixture(symbols) {
  const buffer = Buffer.alloc(256);
  buffer.set([0x4d, 0x5a], 0);
  buffer.writeUInt32LE(128, 0x3c);
  buffer.writeUInt32LE(0x00004550, 128);
  buffer.writeUInt32LE(symbols === 0 ? 0 : 192, 140);
  buffer.writeUInt32LE(symbols, 144);
  return buffer;
}

function machoExportFixture() {
  const buffer = Buffer.alloc(256);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(2, 16);
  buffer.writeUInt32LE(104, 20);

  let offset = 32;
  buffer.writeUInt32LE(0x2, offset);
  buffer.writeUInt32LE(24, offset + 4);
  buffer.writeUInt32LE(136, offset + 8);
  buffer.writeUInt32LE(2, offset + 12);
  buffer.writeUInt32LE(168, offset + 16);
  buffer.writeUInt32LE(32, offset + 20);

  offset += 24;
  buffer.writeUInt32LE(0xb, offset);
  buffer.writeUInt32LE(80, offset + 4);
  buffer.writeUInt32LE(0, offset + 16);
  buffer.writeUInt32LE(1, offset + 20);

  buffer.writeUInt32LE(1, 136);
  buffer.writeUInt32LE(11, 152);
  buffer.write('\0_exported\0_unused\0', 168);
  return buffer;
}

function elfExportFixture({
  binding = 1,
  other = 0,
} = {}) {
  const buffer = Buffer.alloc(336);
  buffer.set([0x7f, 0x45, 0x4c, 0x46, 2, 1], 0);
  buffer.writeBigUInt64LE(64n, 40);
  buffer.writeUInt16LE(64, 58);
  buffer.writeUInt16LE(3, 60);

  const dynamicSymbols = 128;
  buffer.writeUInt32LE(11, dynamicSymbols + 4);
  buffer.writeBigUInt64LE(256n, dynamicSymbols + 24);
  buffer.writeBigUInt64LE(48n, dynamicSymbols + 32);
  buffer.writeUInt32LE(2, dynamicSymbols + 40);
  buffer.writeBigUInt64LE(24n, dynamicSymbols + 56);

  const dynamicStrings = 192;
  buffer.writeUInt32LE(3, dynamicStrings + 4);
  buffer.writeBigUInt64LE(304n, dynamicStrings + 24);
  buffer.writeBigUInt64LE(32n, dynamicStrings + 32);

  buffer.writeUInt32LE(1, 280);
  buffer[284] = (binding << 4) | 2;
  buffer[285] = other;
  buffer.writeUInt16LE(1, 286);
  buffer.write('\0exported\0', 304);
  return buffer;
}

function peExportFixture(names = ['exported']) {
  const buffer = Buffer.alloc(1024);
  buffer.set([0x4d, 0x5a], 0);
  buffer.writeUInt32LE(128, 0x3c);
  buffer.writeUInt32LE(0x00004550, 128);

  const coffOffset = 132;
  buffer.writeUInt16LE(1, coffOffset + 2);
  buffer.writeUInt16LE(240, coffOffset + 16);

  const optionalOffset = 152;
  buffer.writeUInt16LE(0x20b, optionalOffset);
  buffer.writeUInt32LE(0x1000, optionalOffset + 112);
  buffer.writeUInt32LE(96, optionalOffset + 116);

  const sectionOffset = optionalOffset + 240;
  buffer.writeUInt32LE(512, sectionOffset + 8);
  buffer.writeUInt32LE(0x1000, sectionOffset + 12);
  buffer.writeUInt32LE(512, sectionOffset + 16);
  buffer.writeUInt32LE(512, sectionOffset + 20);

  const exportDirectory = 512;
  buffer.writeUInt32LE(names.length, exportDirectory + 20);
  buffer.writeUInt32LE(names.length, exportDirectory + 24);
  buffer.writeUInt32LE(0x1030, exportDirectory + 32);
  buffer.writeUInt32LE(0x1050, exportDirectory + 36);
  let nameRva = 0x1080;
  let nameOffset = 640;
  for (let index = 0; index < names.length; index += 1) {
    buffer.writeUInt32LE(nameRva, 560 + index * 4);
    buffer.writeUInt16LE(index, 592 + index * 2);
    buffer.write(`${names[index]}\0`, nameOffset);
    nameRva += Buffer.byteLength(names[index]) + 1;
    nameOffset += Buffer.byteLength(names[index]) + 1;
  }
  return buffer;
}

test('accepts stripped Mach-O, ELF, and PE release binaries', () => {
  assert.equal(assertStrippedReleaseBinary(machoFixture(0)).format, 'mach-o');
  assert.equal(assertStrippedReleaseBinary(elfFixture(false)).format, 'elf64');
  assert.equal(assertStrippedReleaseBinary(peFixture(0)).format, 'pe');
});

test('reports symbol metadata retained by unstripped binaries', () => {
  assert.deepEqual(inspectReleaseBinary(machoFixture(120_000)).localSymbols, 120_000);
  assert.throws(
    () => assertStrippedReleaseBinary(machoFixture(120_000)),
    /oversized symbol table/,
  );
  assert.throws(
    () => assertStrippedReleaseBinary(elfFixture(true)),
    /static symbol table/,
  );
  assert.throws(
    () => assertStrippedReleaseBinary(peFixture(8)),
    /contains 8 COFF symbols/,
  );
});

test('rejects malformed and unsupported release files', () => {
  assert.throws(
    () => inspectReleaseBinary(Buffer.from('not an executable')),
    /Unsupported release binary format/,
  );
  assert.throws(
    () => inspectReleaseBinary(machoFixture(0).subarray(0, 40)),
    /out of range/,
  );
});

test('lists exported symbols from Mach-O, ELF, and PE binaries', () => {
  assert.deepEqual(listExportedSymbols(machoExportFixture()), ['_exported']);
  assert.deepEqual(listExportedSymbols(elfExportFixture()), ['exported']);
  assert.deepEqual(listExportedSymbols(elfExportFixture({ other: 3 })), ['exported']);
  assert.deepEqual(listExportedSymbols(elfExportFixture({ binding: 10 })), ['exported']);
  assert.deepEqual(listExportedSymbols(elfExportFixture({ other: 1 })), []);
  assert.deepEqual(listExportedSymbols(elfExportFixture({ other: 2 })), []);
  assert.deepEqual(listExportedSymbols(peExportFixture()), ['exported']);
});

test('restricts Linux exports by changing final ELF dynamic-symbol visibility', () => {
  const unwanted = elfExportFixture({ other: 0xa3 });
  const hidden = restrictElfDynamicExports(unwanted, []);
  assert.equal(hidden.hiddenSymbols, 1);
  assert.equal(hidden.exposedSymbols, 0);
  assert.equal(hidden.retainedSymbols, 0);
  assert.equal(unwanted[285], 0xa2);
  assert.deepEqual(listExportedSymbols(unwanted), []);

  const wanted = elfExportFixture({ other: 0xa2 });
  const exposed = restrictElfDynamicExports(wanted, ['exported']);
  assert.equal(exposed.hiddenSymbols, 0);
  assert.equal(exposed.exposedSymbols, 1);
  assert.equal(exposed.retainedSymbols, 0);
  assert.equal(wanted[285], 0xa0);
  assert.deepEqual(listExportedSymbols(wanted), ['exported']);

  const retained = restrictElfDynamicExports(wanted, new Set(['exported']));
  assert.equal(retained.hiddenSymbols, 0);
  assert.equal(retained.exposedSymbols, 0);
  assert.equal(retained.retainedSymbols, 1);
});

test('derives the Linux native-addon ABI from the linker version script', () => {
  assert.deepEqual(
    elfExportSymbolsFromVersionScript(`
      {
        global:
          napi_create_object;
          uv_queue_work;
        local:
          *;
      };
    `),
    ['napi_create_object', 'uv_queue_work'],
  );
  assert.throws(
    () => elfExportSymbolsFromVersionScript('{ local: *; };'),
    /does not contain any global symbols/,
  );

  const exports = elfExportSymbolsFromVersionScript(
    readFileSync(new URL('../src/compiler/src/symbols.dyn', import.meta.url)),
  );
  assert.ok(exports.length > 100);
  assert.ok(exports.length <= 1024);
  assert.equal(new Set(exports).size, exports.length);
  for (const required of [
    'napi_create_object',
    'napi_create_threadsafe_function',
    'node_module_register',
    'uv_dlopen',
    'uv_queue_work',
  ]) {
    assert.ok(exports.includes(required), `missing ${required}`);
  }
});

test('restricts Windows exports to the declared native-addon ABI', () => {
  const executable = peExportFixture(['allowed', 'hidden']);
  assert.deepEqual(listExportedSymbols(executable), ['allowed', 'hidden']);

  const restricted = restrictPortableExecutableExports(executable, ['allowed']);
  assert.equal(restricted.retainedSymbols, 1);
  assert.equal(restricted.hiddenSymbols, 1);
  assert.deepEqual(listExportedSymbols(executable), ['allowed']);
});

test('derives the Windows native-addon ABI from the module definition', () => {
  assert.deepEqual(
    peExportSymbolsFromModuleDefinition(`
      ; generated comments are ignored
      LIBRARY cottontail
      EXPORTS
        napi_create_object
        uv_queue_work ; trailing comment
    `),
    ['napi_create_object', 'uv_queue_work'],
  );
  assert.throws(
    () => peExportSymbolsFromModuleDefinition('LIBRARY cottontail'),
    /does not contain any exported symbols/,
  );
  assert.throws(
    () => peExportSymbolsFromModuleDefinition('EXPORTS\n  public=internal'),
    /Unsupported PE export entry/,
  );

  const exports = peExportSymbolsFromModuleDefinition(
    readFileSync(new URL('../src/compiler/src/symbols.def', import.meta.url)),
  );
  assert.ok(exports.length > 100);
  assert.ok(exports.length <= 1024);
  assert.equal(new Set(exports).size, exports.length);
  for (const required of [
    'napi_create_object',
    'napi_create_threadsafe_function',
    'node_module_register',
    'uv_dlopen',
    'uv_queue_work',
  ]) {
    assert.ok(exports.includes(required), `missing ${required}`);
  }
});
