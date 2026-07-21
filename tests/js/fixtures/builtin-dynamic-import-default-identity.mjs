process.default = 1;
process.hello = 2;

const processModule = await import("node:process");
if (processModule.default !== process) throw new Error("node:process default export lost process identity");
if (processModule.default.default !== 1) throw new Error("user-assigned process.default was not preserved");
if (processModule.hello !== 2) throw new Error("node:process named exports did not reflect the runtime object");
if (processModule.default.hello !== 2) throw new Error("node:process default export lost user properties");

delete process.default;
delete process.hello;
console.log("builtin dynamic import identity passed");
