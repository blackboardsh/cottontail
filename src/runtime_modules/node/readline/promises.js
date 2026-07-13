// node:readline/promises built on the vendored Node.js sources; see
// ../util/internal/loader.js.
import { internalRequire } from "../util/internal/loader.js";

const promisesModule = internalRequire("readline/promises");

export const Interface = promisesModule.Interface;
export const Readline = promisesModule.Readline;
export const createInterface = promisesModule.createInterface;

export default promisesModule;
