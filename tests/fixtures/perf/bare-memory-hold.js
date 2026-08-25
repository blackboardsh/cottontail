const gate = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(gate, 0, 0, 60_000);
