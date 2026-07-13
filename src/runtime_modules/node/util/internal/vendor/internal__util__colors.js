// Vendored verbatim from Node.js v24.11.1 built-in module "internal/util/colors"
// (extracted via process.binding('natives')). Do not hand-edit; see
// ../loader.js for the loader and ../../../util.js for the entry point.
export const id = "internal/util/colors";
export default function factory(module, exports, require, internalBinding, primordials) {
'use strict';

let internalTTy;
function lazyInternalTTY() {
  internalTTy ??= require('internal/tty');
  return internalTTy;
}

module.exports = {
  blue: '',
  green: '',
  white: '',
  red: '',
  gray: '',
  clear: '',
  reset: '',
  hasColors: false,
  shouldColorize(stream) {
    if (process.env.FORCE_COLOR !== undefined) {
      return lazyInternalTTY().getColorDepth() > 2;
    }
    return stream?.isTTY && (
      typeof stream.getColorDepth === 'function' ?
        stream.getColorDepth() > 2 : true);
  },
  refresh() {
    if (module.exports.shouldColorize(process.stderr)) {
      module.exports.blue = '\u001b[34m';
      module.exports.green = '\u001b[32m';
      module.exports.white = '\u001b[39m';
      module.exports.yellow = '\u001b[33m';
      module.exports.red = '\u001b[31m';
      module.exports.gray = '\u001b[90m';
      module.exports.clear = '\u001bc';
      module.exports.reset = '\u001b[0m';
      module.exports.hasColors = true;
    } else {
      module.exports.blue = '';
      module.exports.green = '';
      module.exports.white = '';
      module.exports.yellow = '';
      module.exports.red = '';
      module.exports.gray = '';
      module.exports.clear = '';
      module.exports.reset = '';
      module.exports.hasColors = false;
    }
  },
};

module.exports.refresh();

}
