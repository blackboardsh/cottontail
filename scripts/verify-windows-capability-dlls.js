#!/usr/bin/env node
// Verifies every packaged Windows capability DLL starts through the MSVC CRT.
//
// A DLL whose root module is Zig gets std.start's own _DllMainCRTStartup unless
// the root declares one. That entry point skips the CRT's per-module DLL
// initialization, so atexit() and other CRT module state is left
// uninitialized: static OpenSSL's first atexit() corrupted the heap and
// crashed every Bun.CryptoHasher. The CRT's DLL startup always imports the
// onexit-table initializers below; Zig's entry point never does.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_CRT_STARTUP_IMPORTS = ['_initialize_onexit_table', '_execute_onexit_table'];

export function peImports(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (view.getUint32(pe, true) !== 0x4550) throw new Error('not a PE image');
  const sectionCount = view.getUint16(pe + 6, true);
  const optionalHeaderSize = view.getUint16(pe + 20, true);
  const optional = pe + 24;
  if (view.getUint16(optional, true) !== 0x20b) throw new Error('expected a PE32+ image');
  const importRva = view.getUint32(optional + 112 + 8, true);
  const sections = [];
  for (let index = 0, header = optional + optionalHeaderSize; index < sectionCount; index++, header += 40) {
    sections.push({
      rva: view.getUint32(header + 12, true),
      size: Math.max(view.getUint32(header + 8, true), view.getUint32(header + 16, true)),
      raw: view.getUint32(header + 20, true),
    });
  }
  const offset = (rva) => {
    const section = sections.find(s => rva >= s.rva && rva < s.rva + s.size);
    if (!section) throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
    return rva - section.rva + section.raw;
  };
  const cString = (at) => {
    let end = at;
    while (bytes[end] !== 0) end++;
    return Buffer.from(bytes.subarray(at, end)).toString('latin1');
  };
  const imports = new Map();
  if (importRva === 0) return imports;
  for (let descriptor = offset(importRva); ; descriptor += 20) {
    const lookupRva = view.getUint32(descriptor, true) || view.getUint32(descriptor + 16, true);
    const nameRva = view.getUint32(descriptor + 12, true);
    if (lookupRva === 0 && nameRva === 0) break;
    const names = [];
    for (let thunk = offset(lookupRva); ; thunk += 8) {
      const entry = view.getBigUint64(thunk, true);
      if (entry === 0n) break;
      if (!(entry & 0x8000000000000000n)) names.push(cString(offset(Number(entry & 0x7fffffffn)) + 2));
    }
    imports.set(cString(offset(nameRva)).toLowerCase(), names);
  }
  return imports;
}

function* dllsUnder(directory) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) yield* dllsUnder(path);
    else if (name.toLowerCase().endsWith('.dll')) yield path;
  }
}

export function verifyCapabilityDlls(stdlibDirectory) {
  const failures = [];
  let checked = 0;
  for (const path of dllsUnder(stdlibDirectory)) {
    checked++;
    const imported = new Set([...peImports(readFileSync(path)).values()].flat());
    const missing = REQUIRED_CRT_STARTUP_IMPORTS.filter(name => !imported.has(name));
    if (missing.length) failures.push(`${relative(stdlibDirectory, path)}: missing ${missing.join(', ')}`);
  }
  return { checked, failures };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const stdlib = resolve(process.argv[2] || join(root, 'zig-out/bin/cottontail-stdlib'));
  const { checked, failures } = verifyCapabilityDlls(stdlib);
  if (checked === 0) {
    console.error(`No capability DLLs found under ${stdlib}`);
    process.exit(1);
  }
  if (failures.length) {
    console.error('Capability DLLs that do not start through the MSVC CRT (declare `pub const _DllMainCRTStartup = {};` in the Zig root):');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`✓ ${checked} capability DLLs start through the MSVC CRT`);
}
