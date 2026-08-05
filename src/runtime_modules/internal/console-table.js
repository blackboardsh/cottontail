const ansiPattern = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;:]*[A-Za-z]|[\x9b][0-9;:]*[A-Za-z]/g;

function codePointWidth(codePoint) {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0483 && codePoint <= 0x0489) ||
    (codePoint >= 0x0591 && codePoint <= 0x05bd) ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    codePoint === 0xfeff
  ) return 0;
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) return 2;
  return 1;
}

function stringWidth(text) {
  const stripped = String(text).replace(ansiPattern, "");
  let width = 0;
  for (const character of stripped) width += codePointWidth(character.codePointAt(0));
  return width;
}

const BOLD_OPEN = "\x1b[0m\x1b[1m";
const COLOR_CLOSE = "\x1b[0m";
const NUMBER_OPEN = "\x1b[0m\x1b[33m";

const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isPlainObjectLike(value) {
  if (value === null || typeof value !== "object") return false;
  if (value instanceof RegExp || value instanceof Map || value instanceof Set) return false;
  return true;
}

function isStrictPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatNestedValue(value, colors, seen) {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
    case "bigint": {
      const text = String(value);
      return colors ? `${NUMBER_OPEN}${text}${COLOR_CLOSE}` : text;
    }
    case "boolean":
    case "undefined":
      return String(value);
    case "symbol":
      return String(value);
    case "function":
      return "[Function]";
  }
  if (value === null) return "null";
  if (seen.has(value)) return "[Circular]";
  if (value instanceof RegExp) return String(value);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      return `[ ${value.map((item) => formatNestedValue(item, colors, seen)).join(", ")} ]`;
    }
    if (value instanceof Map) {
      if (value.size === 0) return "Map(0) {}";
      const items = [];
      for (const [key, item] of value) {
        items.push(`${formatNestedValue(key, colors, seen)}: ${formatNestedValue(item, colors, seen)}`);
      }
      return `Map(${value.size}) { ${items.join(", ")} }`;
    }
    if (value instanceof Set) {
      if (value.size === 0) return "Set(0) {}";
      const items = [];
      for (const item of value) items.push(formatNestedValue(item, colors, seen));
      return `Set(${value.size}) { ${items.join(", ")} }`;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const entries = keys.map((key) => {
      const printedKey = identifierPattern.test(key) ? key : JSON.stringify(key);
      return `${printedKey}: ${formatNestedValue(value[key], colors, seen)}`;
    });
    return `{ ${entries.join(", ")} }`;
  } finally {
    seen.delete(value);
  }
}

function formatCellValue(value, colors) {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint": {
      const text = String(value);
      return colors ? `${NUMBER_OPEN}${text}${COLOR_CLOSE}` : text;
    }
    case "boolean":
      return String(value);
    case "undefined":
      return "";
    case "symbol":
    case "function":
      return "";
  }
  if (value === null) return "null";
  if (value instanceof RegExp) return "";
  return formatNestedValue(value, colors, new Set());
}

function padEndVisible(text, width) {
  const padding = width - stringWidth(text);
  return padding > 0 ? text + " ".repeat(padding) : text;
}

function padStartVisible(text, width) {
  const padding = width - stringWidth(text);
  return padding > 0 ? " ".repeat(padding) + text : text;
}

// Renders `value` the way Bun's console.table / Bun.inspect.table do.
// Returns the rendered table including a trailing newline, or "" when the
// input cannot be tabulated (null, undefined, or a primitive).
export function renderTable(value, properties = undefined, options = undefined) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" && typeof value !== "function") return "";
  const colors = Boolean(options && options.colors);
  const hasProperties = Array.isArray(properties);

  const isMap = value instanceof Map;
  let rows;
  if (isMap) {
    rows = [];
    let index = 0;
    for (const [key, item] of value) rows.push({ label: String(index++), key, value: item });
  } else if (Array.isArray(value)) {
    rows = value.map((item, index) => ({ label: String(index), value: item }));
  } else if (value instanceof Set) {
    rows = [];
    let index = 0;
    for (const item of value) rows.push({ label: String(index++), value: item });
  } else if (typeof value === "function") {
    rows = Object.keys(value).map((key) => ({ label: key, value: value[key] }));
  } else if (!isStrictPlainObject(value) && typeof value[Symbol.iterator] === "function") {
    rows = Array.from(value).map((item, index) => ({ label: String(index), value: item }));
  } else {
    rows = Object.keys(value).map((key) => ({ label: key, value: value[key] }));
  }

  let columns;
  if (hasProperties) {
    columns = properties.map((property) => String(property));
  } else if (isMap) {
    columns = ["Key", "Values"];
  } else {
    columns = [];
    let needsValues = false;
    for (const row of rows) {
      const item = row.value;
      if (isPlainObjectLike(item)) {
        for (const key of Object.keys(item)) {
          if (!columns.includes(key)) columns.push(key);
        }
      } else {
        needsValues = true;
      }
    }
    if (needsValues) columns.push("Values");
  }

  const cellFor = (row, column) => {
    if (isMap && !hasProperties) return column === "Key" ? row.key : row.value;
    const item = row.value;
    if (!hasProperties && column === "Values") {
      return isPlainObjectLike(item) ? undefined : item;
    }
    if (item !== null && (typeof item === "object" || typeof item === "function")) return item[column];
    return undefined;
  };

  const headerCells = ["", ...columns];
  const bodyRows = rows.map((row) => [
    row.label,
    ...columns.map((column) => formatCellValue(cellFor(row, column), colors)),
  ]);
  const widths = headerCells.map((header, columnIndex) =>
    Math.max(1, stringWidth(header), ...bodyRows.map((row) => stringWidth(row[columnIndex]))),
  );

  const border = (left, middle, right) =>
    `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;
  const headerLine = `│${headerCells
    .map((header, columnIndex) => {
      const padded = padEndVisible(header, widths[columnIndex]);
      return ` ${colors ? `${BOLD_OPEN}${padded}${COLOR_CLOSE}` : padded} `;
    })
    .join("│")}│`;
  const bodyLines = bodyRows.map((row) =>
    `│${row
      .map((cell, columnIndex) =>
        columnIndex === 0
          ? ` ${padStartVisible(cell, widths[columnIndex])} `
          : ` ${padEndVisible(cell, widths[columnIndex])} `,
      )
      .join("│")}│`,
  );

  return [
    border("┌", "┬", "┐"),
    headerLine,
    border("├", "┼", "┤"),
    ...bodyLines,
    border("└", "┴", "┘"),
  ].join("\n") + "\n";
}

export default renderTable;
