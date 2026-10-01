import { fullGC } from 'bun:jsc';

function cottontailJitProbe(value) {
  if (value.fail) throw value.reference;
  return { sum: value.a + value.b, reference: value.reference, root: Math.sqrt(value.a * value.a) };
}
const reference = { alive: true };
for (let index = 0; index < 100000; index++) {
  const value = cottontailJitProbe({ a: index, b: 7, reference, fail: false });
  if (value.sum !== index + 7 || value.reference !== reference || value.root !== index)
    throw new Error('JIT arithmetic or live reference failed');
  if (index % 10000 === 0) fullGC();
}
const changed = cottontailJitProbe({ a: '20', b: 7, reference, fail: false, extra: true });
if (changed.sum !== '207') throw new Error('JIT type transition failed');
let caught = false;
try { cottontailJitProbe({ a: 1, b: 2, reference, fail: true }); }
catch (error) { caught = error === reference; }
if (!caught) throw new Error('JIT exception failed');

const wasm = new Uint8Array([0,97,115,109,1,0,0,0,1,5,1,96,0,1,127,3,2,1,0,7,7,1,3,97,110,115,0,0,10,6,1,4,0,65,42,11]);
const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm));
for (let index = 0; index < 10000; index++) {
  if (instance.exports.ans() !== 42) throw new Error('WebAssembly execution failed');
}
console.log('Cottontail JIT, GC, deoptimization, exceptions, and WebAssembly passed');
