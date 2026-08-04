import { promises } from "../timers.js";
import { __setBuiltinModules } from "../module.js";

export const setTimeout = promises.setTimeout;
export const setImmediate = promises.setImmediate;
export const setInterval = promises.setInterval;
export const scheduler = promises.scheduler;

__setBuiltinModules({
  "timers/promises": promises,
  "node:timers/promises": promises,
});

export default promises;
