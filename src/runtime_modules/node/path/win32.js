import { win32 } from "../path.js";

export const _makeLong = win32._makeLong;
export const basename = win32.basename;
export const delimiter = win32.delimiter;
export const dirname = win32.dirname;
export const extname = win32.extname;
export const format = win32.format;
export const isAbsolute = win32.isAbsolute;
export const join = win32.join;
export const matchesGlob = win32.matchesGlob;
export const normalize = win32.normalize;
export const parse = win32.parse;
export const posix = win32.posix;
export const relative = win32.relative;
export const resolve = win32.resolve;
export const sep = win32.sep;
export const toNamespacedPath = win32.toNamespacedPath;
export { win32 };

export default win32;
