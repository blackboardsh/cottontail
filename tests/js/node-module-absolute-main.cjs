const { join } = require("node:path");

const dependency = join(__dirname, "fixtures", "worker-source-port-dependency.cjs");
const loaded = require(dependency);

if (loaded.loaded !== "cjs-dependency") {
  throw new Error(`absolute CommonJS require mismatch: ${JSON.stringify(loaded)}`);
}

console.log("node module absolute main passed");
