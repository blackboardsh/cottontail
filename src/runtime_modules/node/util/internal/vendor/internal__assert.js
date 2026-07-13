// Vendored verbatim from Node.js v24.11.1 built-in module "internal/assert"
// (extracted via process.binding('natives')). Do not hand-edit; see
// ../loader.js for the loader and ../../../util.js for the entry point.
export const id = "internal/assert";
export default function factory(module, exports, require, internalBinding, primordials) {
'use strict';

let error;
function lazyError() {
  return error ??= require('internal/errors').codes.ERR_INTERNAL_ASSERTION;
}

function assert(value, message) {
  if (!value) {
    const ERR_INTERNAL_ASSERTION = lazyError();
    throw new ERR_INTERNAL_ASSERTION(message);
  }
}

function fail(message) {
  const ERR_INTERNAL_ASSERTION = lazyError();
  throw new ERR_INTERNAL_ASSERTION(message);
}

assert.fail = fail;

module.exports = assert;

}
