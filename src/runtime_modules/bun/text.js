export function stripANSI(value) {
  return cottontail.stripANSINative(String(value));
}

export function escapeHTML(value, attribute = false) {
  const text = String(value);
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function isCombiningCodePoint(codePoint) {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    codePoint === 0x05bf ||
    (codePoint >= 0x05c1 && codePoint <= 0x05c2) ||
    (codePoint >= 0x05c4 && codePoint <= 0x05c5) ||
    codePoint === 0x05c7 ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    codePoint === 0x0670 ||
    (codePoint >= 0x06d6 && codePoint <= 0x06dc) ||
    (codePoint >= 0x06df && codePoint <= 0x06e4) ||
    (codePoint >= 0x06e7 && codePoint <= 0x06e8) ||
    (codePoint >= 0x06ea && codePoint <= 0x06ed) ||
    codePoint === 0x0711 ||
    (codePoint >= 0x0730 && codePoint <= 0x074a) ||
    (codePoint >= 0x07a6 && codePoint <= 0x07b0) ||
    (codePoint >= 0x07eb && codePoint <= 0x07f3) ||
    codePoint === 0x07fd ||
    (codePoint >= 0x0816 && codePoint <= 0x0819) ||
    (codePoint >= 0x081b && codePoint <= 0x0823) ||
    (codePoint >= 0x0825 && codePoint <= 0x0827) ||
    (codePoint >= 0x0829 && codePoint <= 0x082d) ||
    (codePoint >= 0x0859 && codePoint <= 0x085b) ||
    (codePoint >= 0x0898 && codePoint <= 0x089f) ||
    (codePoint >= 0x08ca && codePoint <= 0x0902) ||
    codePoint === 0x093c ||
    codePoint === 0x093f ||
    (codePoint >= 0x0941 && codePoint <= 0x0948) ||
    codePoint === 0x094d ||
    (codePoint >= 0x0951 && codePoint <= 0x0957) ||
    (codePoint >= 0x0962 && codePoint <= 0x0963) ||
    codePoint === 0x09bc ||
    (codePoint >= 0x09c1 && codePoint <= 0x09c4) ||
    codePoint === 0x09cd ||
    codePoint === 0x0bcd ||
    (codePoint >= 0x0c3e && codePoint <= 0x0c40) ||
    (codePoint >= 0x0c46 && codePoint <= 0x0c48) ||
    (codePoint >= 0x0c4a && codePoint <= 0x0c4d) ||
    (codePoint >= 0x0d41 && codePoint <= 0x0d44) ||
    codePoint === 0x0d4d ||
    codePoint === 0x0e31 ||
    (codePoint >= 0x0e34 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    codePoint === 0x0eb1 ||
    (codePoint >= 0x0eb4 && codePoint <= 0x0ebc) ||
    (codePoint >= 0x0ec8 && codePoint <= 0x0ecd) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isZeroWidthCodePoint(codePoint) {
  return (
    codePoint === 0x00ad ||
    codePoint === 0x034f ||
    codePoint === 0x061c ||
    (codePoint >= 0x0600 && codePoint <= 0x0605) ||
    codePoint === 0x06dd ||
    codePoint === 0x070f ||
    codePoint === 0x08e2 ||
    (codePoint >= 0x180b && codePoint <= 0x180f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x206f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
    isCombiningCodePoint(codePoint)
  );
}

function isFullwidthCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

function isRegionalIndicator(codePoint) {
  return codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

function isEmojiModifier(codePoint) {
  return codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isEmojiCodePoint(codePoint) {
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    codePoint === 0x231a ||
    codePoint === 0x231b ||
    codePoint === 0x2328 ||
    codePoint === 0x23cf
  );
}

function isEmojiVariationBase(codePoint) {
  return (
    codePoint === 0x00a9 ||
    codePoint === 0x00ae ||
    codePoint === 0x203c ||
    codePoint === 0x2049 ||
    codePoint === 0x2122 ||
    codePoint === 0x2139 ||
    (codePoint >= 0x2194 && codePoint <= 0x21aa) ||
    (codePoint >= 0x231a && codePoint <= 0x231b) ||
    codePoint === 0x2328 ||
    codePoint === 0x23cf ||
    (codePoint >= 0x23e9 && codePoint <= 0x23f3) ||
    (codePoint >= 0x23f8 && codePoint <= 0x23fa) ||
    codePoint === 0x24c2 ||
    (codePoint >= 0x25aa && codePoint <= 0x25ab) ||
    codePoint === 0x25b6 ||
    codePoint === 0x25c0 ||
    (codePoint >= 0x25fb && codePoint <= 0x25fe) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2934 && codePoint <= 0x2935) ||
    (codePoint >= 0x2b05 && codePoint <= 0x2b55) ||
    codePoint === 0x3030 ||
    codePoint === 0x303d ||
    codePoint === 0x3297 ||
    codePoint === 0x3299
  );
}

function isAmbiguousWideCodePoint(codePoint) {
  return codePoint === 0x00b1 || codePoint === 0x201c || codePoint === 0x2605 || codePoint === 0x26e3;
}

function codePointLength(codePoint) {
  return codePoint > 0xffff ? 2 : 1;
}

function skipAnsiSequence(text, index) {
  if (text.charCodeAt(index) !== 0x1b) return index;
  const next = text.charCodeAt(index + 1);
  if (next === 0x5b) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return cursor + 1;
      cursor += 1;
    }
    return text.length;
  }
  if (next === 0x5d) {
    let cursor = index + 2;
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor);
      if (code === 0x07) return cursor + 1;
      if (code === 0x1b && text.charCodeAt(cursor + 1) === 0x5c) return cursor + 2;
      cursor += 1;
    }
    return text.length;
  }
  return index + 1;
}

function consumeEmojiSequence(text, index) {
  let cursor = index + codePointLength(text.codePointAt(index));
  for (;;) {
    let next = text.codePointAt(cursor);
    while (next === 0xfe0f || next === 0xfe0e || isEmojiModifier(next) || (next >= 0xe0000 && next <= 0xe007f)) {
      cursor += codePointLength(next);
      next = text.codePointAt(cursor);
    }
    if (next !== 0x200d) return cursor;
    const afterJoiner = text.codePointAt(cursor + 1);
    if (afterJoiner == null) return cursor + 1;
    cursor += 1 + codePointLength(afterJoiner);
  }
}

const STRING_WIDTH_NATIVE_MIN_LENGTH = 16;

export function stringWidth(value, options = undefined) {
  const text = String(value ?? "");
  const countAnsiEscapeCodes = options?.countAnsiEscapeCodes === true;
  const ambiguousIsNarrow = options?.ambiguousIsNarrow !== false;
  if (text.length >= STRING_WIDTH_NATIVE_MIN_LENGTH) {
    const nativeWidth = cottontail.stringWidthNative(text, countAnsiEscapeCodes, ambiguousIsNarrow);
    if (nativeWidth >= 0) return nativeWidth;
  }

  let width = 0;
  for (let index = 0; index < text.length;) {
    const ansiEnd = countAnsiEscapeCodes ? index : skipAnsiSequence(text, index);
    if (ansiEnd !== index) {
      index = ansiEnd;
      continue;
    }

    const codePoint = text.codePointAt(index);
    const length = codePointLength(codePoint);
    const next = text.codePointAt(index + length);
    const afterNext = text.codePointAt(index + length + codePointLength(next ?? 0));

    if (codePoint === 0x1b || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || isZeroWidthCodePoint(codePoint)) {
      index += length;
      continue;
    }

    if ((codePoint >= 0x30 && codePoint <= 0x39) || codePoint === 0x23 || codePoint === 0x2a) {
      if ((next === 0xfe0f && afterNext === 0x20e3) || next === 0x20e3) {
        width += 2;
        index += length + (next === 0xfe0f ? 2 : 1);
        continue;
      }
    }

    if (isRegionalIndicator(codePoint)) {
      let count = 0;
      while (isRegionalIndicator(text.codePointAt(index))) {
        count += 1;
        index += 2;
      }
      width += Math.floor(count / 2) * 2 + (count % 2);
      continue;
    }

    if (next === 0xfe0e && isEmojiVariationBase(codePoint)) {
      width += isFullwidthCodePoint(codePoint) ? 2 : 1;
      index += length + 1;
      continue;
    }

    if (isEmojiCodePoint(codePoint)) {
      width += 2;
      index = consumeEmojiSequence(text, index);
      continue;
    }

    if (next === 0xfe0f && isEmojiVariationBase(codePoint)) {
      width += 2;
      index += length + 1;
      continue;
    }

    width += isFullwidthCodePoint(codePoint) || (!ambiguousIsNarrow && isAmbiguousWideCodePoint(codePoint)) ? 2 : 1;
    index += length;
  }
  return width;
}

export function wrapAnsi(value, columns = 80, options = {}) {
  const input = String(value);
  const columnNumber = Number(columns);
  if (!Number.isFinite(columnNumber) || columnNumber <= 0 || input.length === 0) return input;
  const widthLimit = Math.max(1, Math.floor(columnNumber));
  const hard = options?.hard === true;
  const wordWrap = options?.wordWrap !== false;
  const trim = options?.trim !== false;
  const ambiguousIsNarrow = options?.ambiguousIsNarrow !== false;

  let output = "";
  let rowWidth = 0;
  let simpleForeground = null;
  let simpleBackground = null;
  let activeHyperlink = null;
  let rowForeground = null;
  let rowBackground = null;
  let rowHyperlink = null;
  let trailingAnsi = "";

  const trackSgr = (text) => {
    for (const match of text.matchAll(/\x1b\[([0-9;]*)m/g)) {
      const codes = (match[1] || "0").split(";").map(Number);
      for (const code of codes) {
        if (code === 0) {
          simpleForeground = null;
          simpleBackground = null;
        } else if (code === 39) simpleForeground = null;
        else if (code === 49) simpleBackground = null;
        else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) simpleForeground = code;
        else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) simpleBackground = code;
      }
    }
    for (const match of text.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)) {
      activeHyperlink = match[1] ? `\x1b]8;;${match[1]}\x07` : null;
    }
  };
  const append = (text) => {
    for (const unit of units(text)) {
      output += unit;
      trackSgr(unit);
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      rowWidth += unitWidth;
      if (unitWidth > 0) {
        rowForeground = simpleForeground;
        rowBackground = simpleBackground;
        rowHyperlink = activeHyperlink;
        trailingAnsi = "";
      } else {
        trailingAnsi += unit;
      }
    }
  };
  const units = (text) => {
    const result = [];
    for (let index = 0; index < text.length;) {
      const ansiEnd = skipAnsiSequence(text, index);
      if (ansiEnd !== index) {
        result.push(text.slice(index, ansiEnd));
        index = ansiEnd;
        continue;
      }
      const codePoint = text.codePointAt(index);
      const length = codePointLength(codePoint);
      result.push(text.slice(index, index + length));
      index += length;
    }
    return result;
  };
  const trimUnits = (text, leading, trailing) => {
    const list = units(text);
    if (leading) {
      let sawContent = false;
      for (let index = 0; index < list.length; index += 1) {
        const unit = list[index];
        if (stringWidth(unit, { ambiguousIsNarrow }) === 0) continue;
        if (!sawContent && /^[ \t]$/.test(unit)) {
          list[index] = "";
          continue;
        }
        sawContent = true;
      }
    }
    if (trailing) {
      let sawContent = false;
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const unit = list[index];
        if (stringWidth(unit, { ambiguousIsNarrow }) === 0) continue;
        if (!sawContent && /^[ \t]$/.test(unit)) {
          list[index] = "";
          continue;
        }
        sawContent = true;
      }
    }
    return list.join("");
  };
  const trimCurrentRowEnd = () => {
    const rowStart = output.lastIndexOf("\n") + 1;
    output = output.slice(0, rowStart) + trimUnits(output.slice(rowStart), false, true);
  };
  const breakLine = () => {
    if (trim) trimCurrentRowEnd();
    const preserveTrailingState = !wordWrap && trailingAnsi.length > 0;
    const breakForeground = preserveTrailingState ? rowForeground : simpleForeground;
    const breakBackground = preserveTrailingState ? rowBackground : simpleBackground;
    const breakHyperlink = preserveTrailingState ? rowHyperlink : activeHyperlink;
    const closeLink = activeHyperlink ? "\x1b]8;;\x07" : "";
    const closeForeground = simpleForeground == null ? "" : "\x1b[39m";
    const closeBackground = simpleBackground == null ? "" : "\x1b[49m";
    const reopenBackground = breakBackground == null ? "" : `\x1b[${breakBackground}m`;
    const reopenForeground = breakForeground == null ? "" : `\x1b[${breakForeground}m`;
    const reopenLink = breakHyperlink ?? "";
    const repeatTrailing = preserveTrailingState && (breakForeground !== simpleForeground || breakBackground !== simpleBackground || breakHyperlink !== activeHyperlink)
      ? trailingAnsi
      : "";
    output += `${closeLink}${closeForeground}${closeBackground}\n${reopenBackground}${reopenForeground}${reopenLink}${repeatTrailing}`;
    rowWidth = 0;
    rowForeground = simpleForeground;
    rowBackground = simpleBackground;
    rowHyperlink = activeHyperlink;
    trailingAnsi = repeatTrailing;
  };
  const appendHard = (word) => {
    for (const unit of units(word)) {
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      if (unitWidth > 0 && rowWidth > 0 && rowWidth + unitWidth > widthLimit) breakLine();
      append(unit);
    }
  };
  const appendCharacterWrapped = (line) => {
    const source = trim ? trimUnits(line, true, true) : line;
    for (const unit of units(source)) {
      const unitWidth = stringWidth(unit, { ambiguousIsNarrow });
      if (unitWidth > 0 && rowWidth > 0 && rowWidth + unitWidth > widthLimit) breakLine();
      if (trim && rowWidth === 0 && /^[ \t]$/.test(unit)) continue;
      append(unit);
    }
    if (trim) trimCurrentRowEnd();
  };
  const appendLine = (line) => {
    const source = trim ? trimUnits(line, true, true) : line;
    if (stringWidth(source, { ambiguousIsNarrow }) <= widthLimit) {
      append(source);
      return;
    }
    const pieces = source.split(/([ \t]+)/);
    let pendingSpace = "";
    for (const piece of pieces) {
      if (!piece) continue;
      if (/^[ \t]+$/.test(piece)) {
        pendingSpace += piece;
        continue;
      }
      const wordWidth = stringWidth(piece, { ambiguousIsNarrow });
      const space = pendingSpace;
      const spaceWidth = stringWidth(space, { ambiguousIsNarrow });
      pendingSpace = "";

      if (rowWidth > 0 && rowWidth + spaceWidth + wordWidth > widthLimit) {
        if (hard && wordWidth > widthLimit && !/\x1b/.test(piece)) {
          if (space && rowWidth + spaceWidth <= widthLimit) append(space);
          appendHard(piece);
          continue;
        }
        if (!trim && space && rowWidth + spaceWidth <= widthLimit) {
          append(space);
          breakLine();
        } else {
          breakLine();
          if (!trim && space) {
            appendHard(space);
            if (rowWidth > 0 && rowWidth + wordWidth > widthLimit) breakLine();
          }
        }
      } else if (space) {
        append(space);
      }

      if (hard && wordWidth > widthLimit - rowWidth) appendHard(piece);
      else append(piece);
    }
    if (!trim && pendingSpace) appendHard(pendingSpace);
  };

  const lines = input.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) breakLine();
    if (wordWrap) appendLine(lines[index]);
    else appendCharacterWrapped(lines[index]);
  }
  return output;
}
