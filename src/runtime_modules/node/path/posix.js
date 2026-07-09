import { posix } from "../path.js";

export const _makeLong = posix._makeLong;
export const basename = posix.basename;
export const delimiter = posix.delimiter;
export const dirname = posix.dirname;
export const extname = posix.extname;
export const format = posix.format;
export const isAbsolute = posix.isAbsolute;
export const join = posix.join;
export const matchesGlob = posix.matchesGlob;
export const normalize = posix.normalize;
export const parse = posix.parse;
export const relative = posix.relative;
export const resolve = posix.resolve;
export const sep = posix.sep;
export const toNamespacedPath = posix.toNamespacedPath;
export { posix };
export const win32 = posix.win32;

export default posix;
