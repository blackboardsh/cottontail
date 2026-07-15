(async () => {
console.log(require.extensions === require("module")._extensions, Object.keys(require.extensions)); require.extensions[".js"] = require.extensions[".ts"]; console.log(require("./compat/upstream/bun/v1.3.10/test/js/node/module/extensions-fixture/e.js"));
})().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
