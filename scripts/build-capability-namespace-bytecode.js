import { readFileSync, writeFileSync } from "node:fs";

const [sourcePath, outputPath] = process.argv.slice(2);
if (!sourcePath || !outputPath) throw new Error("usage: build-capability-namespace-bytecode.js SOURCE OUTPUT");

const source = readFileSync(sourcePath, "utf8");
const bytecode = cottontail.generateCapabilityBytecode(source, "cottontail:capability-namespace");
writeFileSync(outputPath, new Uint8Array(bytecode));
