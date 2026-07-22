// Port of Bun 1.3.10's Jest.formatLabel test.each naming semantics.

const identifierStartPattern = /^[$_\p{ID_Start}]$/u;
const identifierContinuePattern = /^[$\u200c\u200d\p{ID_Continue}]$/u;

function isIdentifierStart(character) {
  return identifierStartPattern.test(character);
}

function isIdentifierContinue(character) {
  return identifierContinuePattern.test(character);
}

function propertyAtPath(object, path) {
  let value = object;
  for (const key of path.split(".")) {
    if (value == null || !(key in Object(value))) return undefined;
    value = value[key];
  }
  return value;
}

function inspectLabelValue(value) {
  if (typeof globalThis.Bun?.inspect === "function") {
    return globalThis.Bun.inspect(value);
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function appendPositionalValue(output, token, value) {
  switch (token) {
    case "s":
      return output + (typeof value === "string" ? value : "%s");
    case "i":
      return output + (typeof value === "number" && Number.isInteger(value) ? String(value) : "%i");
    case "d":
      return output + (typeof value === "number" ? String(value) : "%d");
    case "f":
      return output + (typeof value === "number" ? String(value) : "%f");
    case "j":
    case "o":
      return output + JSON.stringify(value);
    case "p":
      return output + inspectLabelValue(value);
    default:
      return output;
  }
}

export function formatBunEachLabel(label, functionArguments, testIndex) {
  const source = String(label);
  const values = Array.from(functionArguments);
  let output = "";
  let index = 0;
  let argumentIndex = 0;

  while (index < source.length) {
    const character = source[index];

    if (character === "$" && index + 1 < source.length && values.length > 0 &&
        values[0] !== null && (typeof values[0] === "object" || typeof values[0] === "function")) {
      const variableStart = index + 1;
      let variableEnd = variableStart;

      if (isIdentifierStart(source[variableEnd])) {
        variableEnd += 1;
        while (variableEnd < source.length) {
          const next = source[variableEnd];
          if (next === ".") {
            if (variableEnd + 1 < source.length && isIdentifierContinue(source[variableEnd + 1])) {
              variableEnd += 1;
            } else {
              break;
            }
          } else if (isIdentifierContinue(next)) {
            variableEnd += 1;
          } else {
            break;
          }
        }

        const variablePath = source.slice(variableStart, variableEnd);
        const value = propertyAtPath(values[0], variablePath);
        if (value !== undefined && value !== null) {
          output += typeof value === "string" ? value : inspectLabelValue(value);
          index = variableEnd;
          continue;
        }
      } else {
        while (variableEnd < source.length && isIdentifierContinue(source[variableEnd]) && source[variableEnd] !== "$") {
          variableEnd += 1;
        }
      }

      // Bun 1.3.10 advances past the first delimiter after a missing path.
      output += `$${source.slice(variableStart, variableEnd)}`;
      index = variableEnd;
    } else if (character === "%" && index + 1 < source.length && argumentIndex < values.length) {
      const token = source[index + 1];
      if (token === "#") {
        output += String(testIndex);
        index += 1;
      } else if (token === "%") {
        output += "%";
        index += 1;
      } else if ("sidfjop".includes(token)) {
        output = appendPositionalValue(output, token, values[argumentIndex]);
        argumentIndex += 1;
        index += 1;
      } else {
        output += character;
      }
    } else {
      output += character;
    }

    index += 1;
  }

  return output;
}

export function validateBunEachTable(table) {
  if (!Array.isArray(table)) {
    throw new Error(`Expected array, got ${inspectLabelValue(table)}`);
  }
  return table;
}
