import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [name, sourcePath, outputPath] = process.argv.slice(2);
if (!name || !sourcePath || !outputPath) throw new Error("usage: build-stdlib-capability.js NAME SOURCE OUTPUT");

const encoder = new TextEncoder();
const stableFilename = resolve(`${name}-capability.js`);
const filename = encoder.encode(stableFilename);
const sourceText = readFileSync(sourcePath, "utf8");
const source = encoder.encode(sourceText);
const generatedBytecode = cottontail.generateCapabilityBytecode(sourceText, stableFilename);
const bytecode = new Uint8Array(generatedBytecode);
const headerSize = 8 + 4 + 8 + 8;
const container = new Uint8Array(headerSize + filename.length + source.length + bytecode.length);
container.set(encoder.encode("CTCAPB01"), 0);
const view = new DataView(container.buffer);
view.setUint32(8, filename.length, true);
view.setBigUint64(12, BigInt(source.length), true);
view.setBigUint64(20, BigInt(bytecode.length), true);
container.set(filename, headerSize);
container.set(source, headerSize + filename.length);
container.set(bytecode, headerSize + filename.length + source.length);
writeFileSync(outputPath, container);
