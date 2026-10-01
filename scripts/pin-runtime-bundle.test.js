import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pinRuntimeBundle } from './pin-runtime-bundle.js';

test('runtime snapshots retain adjacent bytecode and DLLs independently of later builds', t => {
  const root = mkdtempSync(join(tmpdir(), 'cottontail-pin-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const state = join(root, 'state');
  mkdirSync(join(source, 'cottontail-core'), { recursive: true });
  mkdirSync(join(source, 'cottontail-stdlib', 'hashing'), { recursive: true });
  const binary = join(source, 'cottontail.exe');
  const bytecode = join(source, 'cottontail-core', 'host-bootstrap.jsc');
  const library = join(source, 'cottontail-stdlib', 'hashing', 'hashing.dll');
  writeFileSync(binary, 'executable');
  writeFileSync(bytecode, 'bytecode-one');
  writeFileSync(library, 'native-one');
  const first = pinRuntimeBundle(binary, state);
  assert.equal(readFileSync(join(dirname(first.pinnedPath), 'cottontail-core', 'host-bootstrap.jsc'), 'utf8'), 'bytecode-one');
  assert.equal(pinRuntimeBundle(binary, state).pinnedPath, first.pinnedPath);
  writeFileSync(library, 'native-two');
  const second = pinRuntimeBundle(binary, state);
  assert.equal(first.sourceHash, second.sourceHash);
  assert.notEqual(first.pinnedPath, second.pinnedPath);
  assert.equal(readFileSync(join(dirname(first.pinnedPath), 'cottontail-stdlib', 'hashing', 'hashing.dll'), 'utf8'), 'native-one');
  assert.equal(readFileSync(join(dirname(second.pinnedPath), 'cottontail-stdlib', 'hashing', 'hashing.dll'), 'utf8'), 'native-two');
  writeFileSync(join(dirname(second.pinnedPath), 'cottontail-core', 'host-bootstrap.jsc'), 'corrupt');
  assert.throws(() => pinRuntimeBundle(binary, state), /bundle hash mismatch/);
});

test('standalone legacy executables do not require runtime companions', t => {
  const root = mkdtempSync(join(tmpdir(), 'cottontail-pin-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const binary = join(root, 'cottontail');
  writeFileSync(binary, 'legacy');
  const pinned = pinRuntimeBundle(binary, join(root, 'state'));
  assert.equal(readFileSync(pinned.pinnedPath, 'utf8'), 'legacy');
});
