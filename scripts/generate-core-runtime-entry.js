#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [name, modulePath, outputPath] = process.argv.slice(2);
if (!name || !modulePath || !outputPath) {
  throw new Error("usage: generate-core-runtime-entry.js NAME MODULE OUTPUT");
}

writeFileSync(outputPath, `
import * as module from ${JSON.stringify(resolve(modulePath))};
globalThis.__cottontailCapabilityResult = {
  modules: { ${JSON.stringify(`node:${name}`)}: module },
};
`);
