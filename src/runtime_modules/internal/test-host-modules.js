import nodeAssert, * as nodeAssertNamespace from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { Readable } from "node:stream";

const hostModules = cottontail.__cottontailTestHostModules ??= {
  AsyncLocalStorage,
  Readable,
  fs,
  nodeAssert,
  nodeAssertNamespace,
};

export default hostModules;
