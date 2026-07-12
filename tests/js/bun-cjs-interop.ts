import * as commonjsPackage from "./fixtures/cjs-interop/commonjs/value.cjs";
import * as modulePackage from "./fixtures/cjs-interop/module/value.cjs";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(commonjsPackage.default === 42, "CommonJS package default should honor __esModule");
assert(commonjsPackage.__esModule === undefined, "CommonJS package should hide __esModule");
assert(
  modulePackage.default.default === 42 && modulePackage.default.__esModule === true,
  "module package should preserve the complete CommonJS value as default",
);
assert(modulePackage.__esModule === true, "module package should expose __esModule");

console.log("bun cjs interop passed");
