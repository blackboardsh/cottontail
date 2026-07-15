(async () => {

const buffer = require("node:buffer");
const d = Object.getOwnPropertyDescriptor(buffer, "kMaxLength");
console.log(JSON.stringify(d));
console.log("isFrozen:", Object.isFrozen(buffer), "isSealed:", Object.isSealed(buffer), buffer[Symbol.toStringTag]);
try { "use strict"; buffer.kMaxLength = 64; console.log("assign ok, now:", buffer.kMaxLength); } catch (e) { console.log("assign threw:", e.message); }

})().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
