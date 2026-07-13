// node:readline built on the vendored Node.js sources in
// ./util/internal/vendor (readline, readline/promises, internal/readline/*).
// See ./util/internal/loader.js for how the vendored modules are executed.
import { internalRequire } from "./util/internal/loader.js";

const readline = internalRequire("readline");
const readlineUtils = internalRequire("internal/readline/utils");
const inspectInternals = internalRequire("internal/util/inspect");

// Node computes string width with ICU; the vendored JS fallback handles
// per-codepoint widths but not ZWJ emoji clusters. Layer grapheme
// segmentation on top so composed emoji count as a single wide cell.
let graphemeSegmenter;
function getStringWidth(input, removeControlChars = true) {
  if (typeof Intl?.Segmenter !== "function") {
    return inspectInternals.getStringWidth(input, removeControlChars);
  }
  let text = String(input);
  if (removeControlChars) text = inspectInternals.stripVTControlCharacters(text);
  text = text.normalize("NFC");
  graphemeSegmenter ??= new Intl.Segmenter();
  let width = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    let segmentWidth = 0;
    for (const character of segment) {
      segmentWidth = Math.max(segmentWidth, inspectInternals.getStringWidth(character, false));
    }
    width += segmentWidth;
  }
  return width;
}

// Bun exposes a few internals for its own test-suite through this symbol.
readline[Symbol.for("__BUN_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED__")] = {
  CSI: readlineUtils.CSI,
  utils: {
    getStringWidth,
    stripVTControlCharacters: inspectInternals.stripVTControlCharacters,
  },
};

export const Interface = readline.Interface;
export const createInterface = readline.createInterface;
export const clearLine = readline.clearLine;
export const clearScreenDown = readline.clearScreenDown;
export const cursorTo = readline.cursorTo;
export const moveCursor = readline.moveCursor;
export const emitKeypressEvents = readline.emitKeypressEvents;
export const promises = readline.promises;

export default readline;
