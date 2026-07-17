// Bun filters against suite and test names joined by spaces during collection.
// node:test filters against its display path ("suite > test"), so adapt the
// CLI expression before node:test captures argv while retaining Bun's matcher
// for suite lifecycle decisions in the bun:test adapter.

const argv = globalThis.process?.argv;
let filterSource = null;
let restoreFilterArgument = null;

function nodeCompatibleFilterSource(source) {
  let output = "";
  let inCharacterClass = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      const escaped = source[index + 1];
      if (!inCharacterClass && escaped === "s") output += "(?:\\s| > )";
      else if (!inCharacterClass && escaped === " ") output += "(?: | > )";
      else output += character + escaped;
      index += 1;
      continue;
    }
    if (character === "[" && !inCharacterClass) inCharacterClass = true;
    else if (character === "]" && inCharacterClass) inCharacterClass = false;
    output += character === " " && !inCharacterClass ? "(?: | > )" : character;
  }

  return output;
}

if (Array.isArray(argv)) {
  for (let index = 2; index < argv.length; index += 1) {
    const argument = String(argv[index]);
    if (argument === "-t" || argument === "--test-name-pattern") {
      if (index + 1 >= argv.length) break;
      filterSource = String(argv[index + 1]);
      const original = argv[index + 1];
      argv[index + 1] = nodeCompatibleFilterSource(filterSource);
      restoreFilterArgument = () => { argv[index + 1] = original; };
      break;
    }
    if (argument.startsWith("--test-name-pattern=")) {
      filterSource = argument.slice("--test-name-pattern=".length);
      const original = argv[index];
      argv[index] = `--test-name-pattern=${nodeCompatibleFilterSource(filterSource)}`;
      restoreFilterArgument = () => { argv[index] = original; };
      break;
    }
    if (argument.startsWith("-t=")) {
      filterSource = argument.slice("-t=".length);
      const original = argv[index];
      argv[index] = `-t=${nodeCompatibleFilterSource(filterSource)}`;
      restoreFilterArgument = () => { argv[index] = original; };
      break;
    }
  }
}

const filterPattern = filterSource == null ? null : new RegExp(filterSource);

export function restoreBunTestFilterArgument() {
  restoreFilterArgument?.();
  restoreFilterArgument = null;
}

export function bunTestFilterIsActive() {
  return filterPattern !== null;
}

export function bunTestNameMatches(suiteNames, testName) {
  if (!filterPattern) return true;
  filterPattern.lastIndex = 0;
  return filterPattern.test([...suiteNames, testName].filter(Boolean).join(" "));
}

export function installBunTestFilterReporter(filteredCount) {
  if (!filterPattern || typeof globalThis.console?.error !== "function") return;
  const consoleError = globalThis.console.error;
  globalThis.console.error = function bunTestFilterReporter(...args) {
    if (typeof args[0] === "string" && args[0].includes("Ran ") && !args[0].includes("filtered out")) {
      const count = Math.max(0, Number(filteredCount()) || 0);
      if (count > 0) {
        args[0] = args[0].replace(/\n (\d+) fail(?=\n|$)/, `\n ${count} filtered out\n $1 fail`);
      }
    }
    return Reflect.apply(consoleError, this, args);
  };
}
