import { promises } from "../stream.js";
import { __setBuiltinModules } from "../module.js";

export const finished = promises.finished;
export const pipeline = promises.pipeline;

__setBuiltinModules({
  "stream/promises": promises,
  "node:stream/promises": promises,
});

export default promises;
