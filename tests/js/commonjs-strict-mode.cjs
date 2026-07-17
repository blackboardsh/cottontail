"use strict";

const target = {};
Object.defineProperty(target, "readonly", {
  configurable: true,
  enumerable: true,
  value: 1,
  writable: false,
});

let assignmentError;
try {
  target.readonly = 2;
} catch (error) {
  assignmentError = error;
}

if (!(assignmentError instanceof TypeError)) {
  throw new Error("CommonJS explicit strict mode did not reject a readonly assignment");
}
if (target.readonly !== 1) {
  throw new Error("CommonJS readonly property changed after a failed assignment");
}

const dependency = import("./modules/dep.js");
if (!(dependency instanceof Promise)) {
  throw new Error("CommonJS dynamic import did not return a Promise");
}
dependency.then(namespace => {
  if (namespace.answer !== 42) {
    throw new Error(`CommonJS dynamic import resolved the wrong module value: ${namespace.answer}`);
  }
});
