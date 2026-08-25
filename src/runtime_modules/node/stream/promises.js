import { promises } from "../stream.js";
import { setCoreBuiltinModules as __setBuiltinModules } from "../../internal/builtin-module-registry.js";

export const finished = promises.finished;
export const pipeline = promises.pipeline;

__setBuiltinModules({
  "stream/promises": promises,
  "node:stream/promises": promises,
});

export default promises;
