(async () => {

const fs=require("fs"); const fsp=require("fs/promises");
const g=globalThis.__cottontailBuiltinModules;
console.log("g fs/promises === fsp:", g.get("fs/promises")===fsp);
console.log("g fs === fs:", g.get("fs")===fs);
console.log("g fs/promises === fs.promises:", g.get("fs/promises")===fs.promises);
console.log("fsp has own default:", Object.hasOwn(fsp,"default"), "fs own default:", Object.hasOwn(fs,"default"));

})().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
