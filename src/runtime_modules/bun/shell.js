export function createBunShellFacade(dependencies) {
  const {
    asBuffer,
    bytesFromBody,
    concatManyBuffers,
    cottontail,
    ctRemapStackString,
    currentProcessEnv,
    isBunFileLike,
    loadEmbeddedRuntimeModule,
    nodeCpSync,
    nodePathBasename,
    nodePathJoin,
    nodePathResolve,
    parseBunShellSource,
    pathJoin,
    randomUUID,
    shellEscape,
    spawn,
    tmpRoot,
    validateNoNullByte,
    which,
  } = dependencies;

  function binaryOutputView(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }

  function shellInterpolationText(value) {
    if (isBunFileLike(value) && value.name != null) value = value.name;
    if (value != null && typeof value === "object" &&
      (typeof value.toString !== "function" || value.toString === Object.prototype.toString)) {
      throw new TypeError("Invalid JS object used in shell, you might need to call `.toString()` on it");
    }
    const text = String(value);
    validateNoNullByte(text, "shell argument");
    return text;
  }

  function quotePosixShellValue(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
  }

  function isShellObjectReference(value) {
    if (value == null || typeof value !== "object" || isBunFileLike(value)) return false;
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
    return (typeof Blob === "function" && value instanceof Blob)
      || (typeof Response === "function" && value instanceof Response)
      || (typeof ReadableStream === "function" && value instanceof ReadableStream);
  }

  function appendShellInterpolation(out, value, state) {
    if (Array.isArray(value)) {
      let first = true;
      const appendArrayValue = item => {
        if (Array.isArray(item)) {
          for (const nested of item) appendArrayValue(nested);
          return;
        }
        if (!first) out += " ";
        first = false;
        out = appendShellInterpolation(out, item, state);
      };
      for (const item of value) appendArrayValue(item);
      return out;
    }

    if (isShellObjectReference(value)) {
      if (state.quote === '"') throw new Error("JS object reference not allowed in double quotes");
      throw new Error('expected a command or assignment but got: "JSObjRef"');
    }

    if (value && typeof value === "object" &&
      Object.prototype.hasOwnProperty.call(value, "raw")) {
      const raw = String(value.raw);
      validateNoNullByte(raw, "shell argument");
      scanShellQuoteState(state, raw);
      return out + raw;
    }

    let text = shellInterpolationText(value);
    if (state.escaped) {
      out = out.slice(0, -1);
      text = `\\${text}`;
      state.escaped = false;
    }

    if (state.quote === "'") {
      return out + text.replace(/'/g, `'\\''`);
    }
    if (state.quote === '"') {
      return out + text.replace(/[$`"\\]/g, "\\$&");
    }
    if (out.endsWith("$")) {
      return out.slice(0, -1) + quotePosixShellValue(`$${text}`);
    }
    return out + quotePosixShellValue(text);
  }

  function scanShellQuoteState(state, source) {
    for (const char of String(source)) {
      if (state.quote === "'") {
        if (char === "'") state.quote = null;
        continue;
      }
      if (state.escaped) {
        state.escaped = false;
        continue;
      }
      if (char === "\\") {
        state.escaped = true;
        continue;
      }
      if (state.quote === '"') {
        if (char === '"') state.quote = null;
        continue;
      }
      if (char === "'" || char === '"') state.quote = char;
    }
  }

  function trailingRedirect(part, operator) {
    let end = part.length;
    while (end > 0 && /\s/.test(part[end - 1])) end -= 1;
    if (part[end - 1] !== operator || part[end - 2] === operator) return null;
    let start = end - 1;
    if (/[012]/.test(part[start - 1] ?? "")) start -= 1;
    return { fd: start < end - 1 ? Number(part[start]) : operator === "<" ? 0 : 1, start, end };
  }

  function validateWindowsShellObjectRedirects(node, outputTargets) {
    if (cottontail.platform() !== "win32" || outputTargets.size === 0) return;
    const visit = value => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value == null || typeof value !== "object") return;

      const redirects = Array.isArray(value.redirects) ? value.redirects : [];
      const objectRedirects = redirects
        .map((redirect, index) => ({ redirect, index }))
        .filter(({ redirect }) => {
          if (outputTargets.has(redirect.target?.raw)) return true;
          const literalTarget = redirect.target?.parts
            ?.map(part => typeof part?.text === "string" ? part.text : "")
            .join("");
          return literalTarget !== undefined && outputTargets.has(literalTarget);
        });
      if (value.type === "subshell" && objectRedirects.length > 0) {
        throw new Error("Subshells with redirections are currently not supported. Please open a GitHub issue.");
      }
      if (objectRedirects.length > 0 && redirects.length > 1) {
        const { index } = objectRedirects[0];
        if (index === redirects.length - 1 && redirects[index - 1]?.operator === ">&2") {
          throw new Error("Redirection with no file");
        }
        throw new Error('expected a command or assignment but got: "Redirect"');
      }

      for (const child of Object.values(value)) visit(child);
    };
    visit(node);
  }

  function interpolateShellCommand(strings, values) {
    const parts = Array.isArray(strings?.raw) ? strings.raw : strings;
    let out = "";
    let outputBuffer = undefined;
    let outputFd = 1;
    const outputTargets = new Map();
    let inputBody = undefined;
    const state = { quote: null, escaped: false };
    // Bun drives the loop off `strings.raw`, so a template-strings stand-in that
    // only carries `raw` (no indexed `length`) still runs its command.
    for (let index = 0; index < parts.length; index += 1) {
      let part = parts[index];
      const terminalTarget = index < values.length &&
        parts.slice(index + 1).every((item) => String(item).trim() === "");
      const outputRedirect = index < values.length ? trailingRedirect(part, ">") : null;
      if (outputRedirect && binaryOutputView(values[index])) {
        const target = `__cottontail_output_${index}_${outputTargets.size}__`;
        out += part;
        scanShellQuoteState(state, part);
        if (state.quote === '"') {
          throw new SyntaxError("JS object reference not allowed in double quotes");
        }
        out += quotePosixShellValue(target);
        outputTargets.set(target, values[index]);
        continue;
      }
      if (outputRedirect && values[index] != null && typeof values[index] === "object") {
        const value = values[index];
        if (!isBunFileLike(value) && (value instanceof Blob || value instanceof Response)) {
          throw new TypeError("Shell output redirection requires a writable Buffer or TypedArray");
        }
      }
      const inputRedirect = terminalTarget ? trailingRedirect(part, "<") : null;
      if (inputRedirect && values[index] != null && typeof values[index] === "object") {
        part = part.slice(0, inputRedirect.start) + part.slice(inputRedirect.end);
        out += part;
        inputBody = values[index];
        continue;
      }
      out += part;
      scanShellQuoteState(state, part);
      if (index < values.length) {
        out = appendShellInterpolation(out, values[index], state);
      }
    }
    const command = out.trimEnd();
    const parsed = parseBunShellSource(command);
    validateWindowsShellObjectRedirects(parsed, outputTargets);
    return { command, outputBuffer, outputFd, outputTargets, inputBody };
  }

  const largeShellInterpolationCache = new WeakMap();
  const largeShellInterpolationThreshold = 256 * 1024;
  const shellTransientAllocationBudget = 32 * 1024 * 1024;
  let shellTransientAllocationBytes = 0;
  let shellTransientCollectionQueued = false;

  function accountShellTransientAllocation(byteLength) {
    shellTransientAllocationBytes += Number(byteLength) || 0;
    if (shellTransientAllocationBytes < shellTransientAllocationBudget) return;
    shellTransientAllocationBytes = 0;
    if (shellTransientCollectionQueued) return;
    shellTransientCollectionQueued = true;
    queueMicrotask(() => {
      shellTransientCollectionQueued = false;
      cottontail.gc?.();
    });
  }

  function largeRawInterpolationSignature(strings, values) {
    if ((typeof strings !== "object" && typeof strings !== "function") || strings === null) return null;
    const signature = [];
    let length = 0;
    for (const value of values) {
      if (value == null || typeof value !== "object" ||
          !Object.prototype.hasOwnProperty.call(value, "raw")) return null;
      const raw = String(value.raw);
      signature.push(raw);
      length += raw.length;
    }
    return length >= largeShellInterpolationThreshold ? signature : null;
  }

  function sameShellInterpolationSignature(left, right) {
    if (left?.length !== right?.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }

  function shellInterpolationError(error) {
    return {
      name: String(error?.name ?? "Error"),
      message: String(error?.message ?? error),
      position: error?.position,
      code: error?.code,
    };
  }

  function throwShellInterpolationError(cached) {
    const error = cached.name === "SyntaxError"
      ? new SyntaxError(cached.message)
      : new Error(cached.message);
    error.name = cached.name;
    if (cached.position !== undefined) error.position = cached.position;
    if (cached.code !== undefined) error.code = cached.code;
    throw error;
  }

  const shellDefaults = {
    cwd: undefined,
    env: undefined,
    throws: true,
    quiet: false,
  };

  const internalShellOutput = Symbol("Cottontail.internalShellOutput");

  function shellOutputBuffer(value, copy) {
    const output = asBuffer(value);
    if (!globalThis.Buffer?.from) return output;
    if (copy) return Buffer.from(output);
    if (Buffer.isBuffer?.(output)) return output;
    return Buffer.from(output.buffer, output.byteOffset, output.byteLength);
  }

  class ShellOutput {
    constructor(result = {}, ownership = undefined) {
      const stdout = asBuffer(result.stdout ?? "");
      const stderr = asBuffer(result.stderr ?? "");
      const copy = ownership !== internalShellOutput;
      this.stdout = shellOutputBuffer(stdout, copy);
      this.stderr = shellOutputBuffer(stderr, copy);
      this.exitCode = Number(result.exitCode ?? result.status ?? 0);
      this.status = this.exitCode;
      this.success = this.exitCode === 0;
    }
    text(encoding = "utf-8") {
      return this.stdout.toString(encoding);
    }
    json() {
      return JSON.parse(this.text());
    }
    bytes() {
      return asBuffer(this.stdout);
    }
    arrayBuffer() {
      const bytes = this.bytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    blob() {
      let bytes = this.bytes();
      if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 10) bytes = bytes.subarray(0, bytes.byteLength - 1);
      return new Blob([bytes]);
    }
  }

  class ShellError extends Error {
    constructor() {
      super("");
      this.info = undefined;
      this.exitCode = undefined;
      this.stdout = undefined;
      this.stderr = undefined;
    }
    initialize(result, code = result?.exitCode) {
      const output = result instanceof ShellOutput ? result : new ShellOutput(result);
      this.message = `Failed with exit code ${code}`;
      this.name = "ShellError";
      this.exitCode = Number(code);
      this.stdout = output.stdout;
      this.stderr = output.stderr;
      Object.defineProperty(this, "info", {
        value: { exitCode: this.exitCode, stdout: this.stdout, stderr: this.stderr },
        writable: true,
        enumerable: false,
        configurable: true,
      });
      if (typeof this.stack === "string") {
        const remappedStack = ctRemapStackString(this.stack);
        const firstFrame = remappedStack.indexOf("\n");
        this.stack = `ShellError: ${this.message}${firstFrame < 0 ? "" : remappedStack.slice(firstFrame)}`;
      }
      return this;
    }
    text(encoding = "utf-8") {
      return this.stdout.toString(encoding);
    }
    json() {
      return JSON.parse(this.text());
    }
    bytes() {
      return asBuffer(this.stdout);
    }
    arrayBuffer() {
      const bytes = this.bytes();
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
    blob() {
      let bytes = this.bytes();
      if (bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 10) bytes = bytes.subarray(0, bytes.byteLength - 1);
      return new Blob([bytes]);
    }
  }

  class ShellExpression {}

  function shellEnv(options) {
    if (options.env == null) return undefined;
    return { ...currentProcessEnv(), ...options.env };
  }

  function splitShellWords(command) {
    const words = [];
    let current = "";
    let quote = "";
    let escaped = false;
    for (const char of String(command)) {
      if (escaped) {
        current += char;
        escaped = false;
      } else if (char === "\\" && !quote) {
        escaped = true;
      } else if (quote) {
        if (char === quote) quote = "";
        else current += char;
      } else if (char === "\"" || char === "'") {
        quote = char;
      } else if (/\s/.test(char)) {
        if (current) {
          words.push(current);
          current = "";
        }
      } else {
        current += char;
      }
    }
    if (escaped) current += "\\";
    if (current) words.push(current);
    return words;
  }

  function shellBasename(path) {
    let text = String(path);
    if (/^[\\/]+$/.test(text)) return "/";
    text = text.replace(/[\\/]+$/g, "");
    const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    return index >= 0 ? text.slice(index + 1) : text;
  }

  function shellDirname(path) {
    let text = String(path);
    if (!text) return ".";
    if (/^[\\/]+$/.test(text)) return "/";
    text = text.replace(/[\\/]+$/g, "");
    const index = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
    if (index < 0) return ".";
    const directory = text.slice(0, index).replace(/[\\/]+$/g, "");
    return directory || "/";
  }

  function shellPath(path, cwd = undefined) {
    const text = String(path);
    if (/^(?:[A-Za-z]:)?[\\/]/.test(text)) return text;
    return cwd ? pathJoin(String(cwd), text) : text;
  }

  function shellStat(path, cwd = undefined) {
    try {
      return cottontail.statSync(shellPath(path, cwd), true);
    } catch {
      return null;
    }
  }

  function runShellMv(words, options = {}) {
    if (words.length < 3) return { exitCode: 1, stdout: "", stderr: "mv: missing file operand\n" };
    const cwd = options.cwd;
    const sources = words.slice(1, -1);
    const destination = words[words.length - 1];
    const destinationStat = shellStat(destination, cwd);
    const destinationMustBeDirectory = sources.length > 1 || /[\\/]$/.test(destination);
    if (destinationMustBeDirectory && !destinationStat?.isDirectory) {
      const reason = destinationStat ? "Not a directory" : "No such file or directory";
      return { exitCode: destinationStat ? 20 : 1, stdout: "", stderr: `mv: ${destination}: ${reason}\n` };
    }

    for (const source of sources) {
      const sourceStat = shellStat(source, cwd);
      if (!sourceStat) return { exitCode: 1, stdout: "", stderr: `mv: ${source}: No such file or directory\n` };
      if (sourceStat.isDirectory && destinationStat && !destinationStat.isDirectory) {
        return { exitCode: 20, stdout: "", stderr: `mv: ${destination}: Not a directory\n` };
      }
      const target = destinationStat?.isDirectory ? pathJoin(destination, shellBasename(source)) : destination;
      try {
        cottontail.renameSync(shellPath(source, cwd), shellPath(target, cwd));
      } catch (error) {
        const message = String(error?.message || error || "rename failed");
        const notDir = message.includes("Not a directory") || message.includes("ENOTDIR");
        return { exitCode: notDir ? 20 : 1, stdout: "", stderr: `mv: ${target}: ${notDir ? "Not a directory" : message}\n` };
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  function parseShellCpArguments(words) {
    const options = { recursive: false, verbose: false };
    let index = 1;
    while (index < words.length) {
      const argument = words[index];
      if (argument === "--") {
        index += 1;
        break;
      }
      if (!argument.startsWith("-") || argument === "-") break;
      for (const flag of argument.slice(1)) {
        if (flag === "R" || flag === "r") options.recursive = true;
        else if (flag === "v") options.verbose = true;
        else if (flag === "n") continue;
        else if ("fHiLPp".includes(flag)) {
          return { error: `cp: unsupported option, please open a GitHub issue -- -${flag}\n` };
        } else {
          return { error: `cp: illegal option -- ${argument.slice(argument.indexOf(flag))}\n` };
        }
      }
      index += 1;
    }
    return { options, operands: words.slice(index) };
  }

  function shellCpErrorMessage(error, path) {
    const text = String(error?.message || error || "copy failed");
    if (error?.code === "ENOENT" || /no such file|filenotfound/i.test(text)) return `${path}: No such file or directory`;
    if (error?.code === "ENOTDIR" || /not a directory/i.test(text)) return `${path}: Not a directory`;
    if (error?.code === "EACCES" || /permission denied/i.test(text)) return `${path}: Permission denied`;
    return `${path}: ${text.replace(/^.*?:\s*/, "")}`;
  }

  function runShellCp(words, options = {}) {
    const usage = "usage: cp [-R [-H | -L | -P]] [-fi | -n] [-aclpsvXx] source_file target_file\n" +
      "       cp [-R [-H | -L | -P]] [-fi | -n] [-aclpsvXx] source_file ... target_directory\n";
    const parsed = parseShellCpArguments(words);
    if (parsed.error) return { exitCode: 1, stdout: "", stderr: parsed.error };
    if (parsed.operands.length < 2) return { exitCode: 1, stdout: "", stderr: usage };

    const cwd = String(options.cwd || cottontail.cwd());
    const sources = parsed.operands.slice(0, -1);
    const targetOperand = parsed.operands[parsed.operands.length - 1];
    const targetAbsolute = nodePathResolve(cwd, targetOperand);
    const targetStat = shellStat(targetOperand, cwd);
    const targetHasTrailingSeparator = /[\\/]$/.test(targetOperand);
    const stdout = [];
    const stderr = [];

    for (const sourceOperand of sources) {
      const sourceAbsolute = nodePathResolve(cwd, sourceOperand);
      const sourceStat = shellStat(sourceOperand, cwd);
      if (!sourceStat) {
        stderr.push(`cp: ${sourceOperand}: No such file or directory\n`);
        continue;
      }
      if (sourceStat.isDirectory && !parsed.options.recursive) {
        stderr.push(`cp: ${sourceOperand} is a directory (not copied)\n`);
        continue;
      }
      if (!sourceStat.isDirectory && sourceAbsolute === targetAbsolute) {
        stderr.push(`cp: ${sourceOperand} and ${sourceOperand} are identical (not copied)\n`);
        continue;
      }

      let destinationAbsolute = targetAbsolute;
      const targetIsDirectory = Boolean(targetStat?.isDirectory) || (!targetStat && targetHasTrailingSeparator);
      if (!sourceStat.isDirectory && !targetIsDirectory && parsed.operands.length === 2) {
        // source_file -> target_file
      } else if (parsed.options.recursive) {
        if (targetStat) destinationAbsolute = nodePathJoin(targetAbsolute, nodePathBasename(sourceAbsolute));
        else if (parsed.operands.length !== 2) {
          stderr.push(`cp: directory ${targetOperand} does not exist\n`);
          continue;
        }
      } else {
        if (!targetStat?.isDirectory) {
          stderr.push(`cp: ${targetOperand} is not a directory\n`);
          continue;
        }
        destinationAbsolute = nodePathJoin(targetAbsolute, nodePathBasename(sourceAbsolute));
      }

      if (sourceAbsolute === destinationAbsolute) {
        stderr.push(`cp: ${sourceOperand} and ${sourceOperand} are identical (not copied)\n`);
        continue;
      }

      try {
        nodeCpSync(sourceAbsolute, destinationAbsolute, {
          recursive: parsed.options.recursive,
          force: true,
          errorOnExist: false,
          filter(source, destination) {
            if (parsed.options.verbose) stdout.push(`${source} -> ${destination}\n`);
            return true;
          },
        });
      } catch (error) {
        stderr.push(`cp: ${shellCpErrorMessage(error, sourceOperand)}\n`);
      }
    }

    return {
      exitCode: stderr.length === 0 ? 0 : 1,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
    };
  }

  function runShellSeq(words) {
    const usage = "usage: seq [-w] [-f format] [-s string] [-t string] [first [incr]] last\n";
    let separator = "\n";
    let terminator = "";
    let index = 1;

    while (index < words.length) {
      const argument = words[index];
      if (argument === "-s" || argument === "--separator") {
        if (index + 1 >= words.length) {
          return { exitCode: 1, stdout: "", stderr: "seq: option requires an argument -- s\n" };
        }
        separator = words[index + 1];
        index += 2;
        continue;
      }
      if (argument.startsWith("-s")) {
        separator = argument.slice(2);
        index += 1;
        continue;
      }
      if (argument === "-t" || argument === "--terminator") {
        if (index + 1 >= words.length) {
          return { exitCode: 1, stdout: "", stderr: "seq: option requires an argument -- t\n" };
        }
        terminator = words[index + 1];
        index += 2;
        continue;
      }
      if (argument.startsWith("-t")) {
        terminator = argument.slice(2);
        index += 1;
        continue;
      }
      if (argument === "-w" || argument === "--fixed-width") {
        index += 1;
        continue;
      }
      break;
    }

    const numericArguments = words.slice(index);
    if (numericArguments.length === 0) return { exitCode: 1, stdout: "", stderr: usage };
    const values = numericArguments.slice(0, 3).map((argument) => Math.fround(Number(argument)));
    if (values.some((value) => !Number.isFinite(value))) {
      return { exitCode: 1, stdout: "", stderr: "seq: invalid argument\n" };
    }

    let start = 1;
    let increment = 1;
    let end = values[0];
    if (values.length === 1) {
      if (start > end) increment = -1;
    } else if (values.length === 2) {
      [start, end] = values;
      if (start < end) increment = 1;
      if (start > end) increment = -1;
    } else {
      [start, increment, end] = values;
      if (increment === 0) return { exitCode: 1, stdout: "", stderr: "seq: zero increment\n" };
      if (start > end && increment > 0) {
        return { exitCode: 1, stdout: "", stderr: "seq: needs negative decrement\n" };
      }
      if (start < end && increment < 0) {
        return { exitCode: 1, stdout: "", stderr: "seq: needs positive increment\n" };
      }
    }

    let stdout = "";
    for (let current = start; increment > 0 ? current <= end : current >= end; current = Math.fround(current + increment)) {
      stdout += `${current}${separator}`;
    }
    return { exitCode: 0, stdout: stdout + terminator, stderr: "" };
  }

  function normalizeShellStderr(command, stderr) {
    let text = String(stderr ?? "");
    if (String(command).includes("mv ")) {
      text = text.replace(/^mv: rename .*? to ([^:]+): Not a directory$/gm, "mv: $1: Not a directory");
      text = text.replace(/^mv: ([^:]+) is not a directory$/gm, "mv: $1: No such file or directory");
    } else {
      text = text.replace(/^.*?: ([^\n]+): Not a directory$/gm, "bun: Not a directory: $1");
    }
    if (/\bbasename\s*(?:[|;&]|$)/.test(String(command))) {
      text = text.replace(
        /^usage: basename string \[suffix\]\n\s*basename \[-a\] \[-s suffix\] string \[\.\.\.\]\n$/,
        "usage: basename string\n",
      );
    }
    return text;
  }

  function assignmentOnlyPipelineStage(value) {
    const assignment = String(value).trim();
    if (!assignment) return false;
    return /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\\]*(?:\\.[^"\\]*)*"|'[^']*'|\\.|[^\s|])*(?:\s+|$))+$/.test(assignment);
  }

  function normalizeAssignmentPipelines(command) {
    const source = String(command);
    const parts = [];
    let start = 0;
    let quote = "";
    let escaped = false;
    let parentheses = 0;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === "\"" || char === "'") {
        quote = char;
        continue;
      }
      if (char === "(") parentheses += 1;
      else if (char === ")" && parentheses > 0) parentheses -= 1;
      else if (char === "|" && parentheses === 0 && source[index - 1] !== "|" && source[index + 1] !== "|") {
        parts.push(source.slice(start, index), "|");
        start = index + 1;
      }
    }
    if (parts.length === 0) return source;
    parts.push(source.slice(start));
    for (let index = 0; index < parts.length; index += 2) {
      if (assignmentOnlyPipelineStage(parts[index])) parts[index] = `${parts[index].trimEnd()} cat `;
    }
    return parts.join("");
  }

  function normalizeCombinedAppendRedirect(command) {
    const source = String(command);
    let output = "";
    let quote = "";
    let escaped = false;
    let index = 0;

    while (index < source.length) {
      const char = source[index];
      if (escaped) {
        output += char;
        escaped = false;
        index += 1;
        continue;
      }
      if (char === "\\") {
        output += char;
        escaped = true;
        index += 1;
        continue;
      }
      if (quote) {
        output += char;
        if (char === quote) quote = "";
        index += 1;
        continue;
      }
      if (char === "\"" || char === "'") {
        output += char;
        quote = char;
        index += 1;
        continue;
      }
      if (!source.startsWith("&>>", index)) {
        output += char;
        index += 1;
        continue;
      }

      output += ">>";
      index += 3;
      while (index < source.length && /\s/.test(source[index])) output += source[index++];

      const targetStart = index;
      let targetQuote = "";
      let targetEscaped = false;
      let substitutionDepth = 0;
      while (index < source.length) {
        const targetChar = source[index];
        if (targetEscaped) {
          targetEscaped = false;
          index += 1;
          continue;
        }
        if (targetChar === "\\") {
          targetEscaped = true;
          index += 1;
          continue;
        }
        if (targetQuote) {
          if (targetChar === targetQuote) targetQuote = "";
          index += 1;
          continue;
        }
        if (targetChar === "\"" || targetChar === "'") {
          targetQuote = targetChar;
          index += 1;
          continue;
        }
        if (targetChar === "(" && source[index - 1] === "$") substitutionDepth += 1;
        else if (targetChar === ")" && substitutionDepth > 0) substitutionDepth -= 1;
        else if (substitutionDepth === 0 && (/\s/.test(targetChar) || /[;&|<>]/.test(targetChar))) break;
        index += 1;
      }
      output += source.slice(targetStart, index);
      if (index > targetStart) output += " 2>&1";
    }

    return output;
  }

  function writeOutputBuffer(buffer, data) {
    const view = binaryOutputView(buffer);
    if (!view) return;
    const bytes = asBuffer(data);
    view.set(bytes.subarray(0, view.byteLength));
  }

  function fillOutputBuffer(buffer, pattern) {
    const view = binaryOutputView(buffer);
    if (!view) return;
    const bytes = asBuffer(pattern);
    if (bytes.byteLength === 0) return;
    for (let offset = 0; offset < view.byteLength; offset += bytes.byteLength) {
      view.set(bytes.subarray(0, Math.min(bytes.byteLength, view.byteLength - offset)), offset);
    }
  }

  function decodeEchoEscapes(value) {
    const input = String(value);
    let output = "";
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (char !== "\\" || index + 1 >= input.length) {
        output += char;
        continue;
      }

      const escape = input[++index];
      const simple = {
        "\\": "\\",
        a: "\x07",
        b: "\b",
        e: "\x1b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
        v: "\v",
      }[escape];
      if (simple != null) {
        output += simple;
        continue;
      }
      if (escape === "c") return { output, terminated: true };
      if (escape === "0") {
        let digits = "";
        while (digits.length < 3 && /[0-7]/.test(input[index + 1] ?? "")) digits += input[++index];
        output += String.fromCharCode(Number.parseInt(digits || "0", 8));
        continue;
      }
      if (escape === "x") {
        let digits = "";
        while (digits.length < 2 && /[0-9a-fA-F]/.test(input[index + 1] ?? "")) digits += input[++index];
        if (digits) output += String.fromCharCode(Number.parseInt(digits, 16));
        else output += "\\x";
        continue;
      }
      output += `\\${escape}`;
    }
    return { output, terminated: false };
  }

  function runShellBuiltin(command, options = {}) {
    if (/[|&;<>()$`>]/.test(String(command))) return null;
    const words = splitShellWords(command);
    if (words[0] === "yes" && options.outputBuffer != null) {
      const text = words.length > 1 ? words.slice(1).join(" ") : "y";
      fillOutputBuffer(options.outputBuffer, `${text}\n`);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (words[0] === "echo") {
      let index = 1;
      let newline = true;
      let interpretEscapes = false;
      while (/^-[nEe]+$/.test(words[index] ?? "")) {
        for (const flag of words[index].slice(1)) {
          if (flag === "n") newline = false;
          else interpretEscapes = flag === "e";
        }
        index += 1;
      }
      let stdout = words.slice(index).join(" ");
      if (interpretEscapes) {
        const decoded = decodeEchoEscapes(stdout);
        stdout = decoded.output;
        if (decoded.terminated) newline = false;
      }
      return {
        exitCode: 0,
        stdout: `${stdout}${newline ? "\n" : ""}`,
        stderr: "",
      };
    }
    if (words[0] === "basename") {
      if (words.length === 1) return { exitCode: 1, stdout: "", stderr: "usage: basename string\n" };
      return {
        exitCode: 0,
        stdout: `${words.slice(1).map(shellBasename).join("\n")}\n`,
        stderr: "",
      };
    }
    if (words[0] === "dirname") {
      if (words.length === 1) return { exitCode: 1, stdout: "", stderr: "usage: dirname string\n" };
      return {
        exitCode: 0,
        stdout: `${words.slice(1).map(shellDirname).join("\n")}\n`,
        stderr: "",
      };
    }
    if (words[0] === "exit") {
      if (words.length === 1) return { exitCode: 0, stdout: "", stderr: "" };
      if (words.length > 2) return { exitCode: 1, stdout: "", stderr: "exit: too many arguments\n" };
      if (!/^\+?\d+$/.test(words[1])) {
        return { exitCode: 1, stdout: "", stderr: "exit: numeric argument required\n" };
      }
      const value = BigInt(words[1]);
      if (value > 18446744073709551615n) {
        return { exitCode: 1, stdout: "", stderr: "exit: numeric argument required\n" };
      }
      return { exitCode: Number(value % 256n), stdout: "", stderr: "" };
    }
    if (words[0] === "seq") return runShellSeq(words);
    if (words[0] === "mv") return runShellMv(words, options);
    if (words[0] === "cp") return runShellCp(words, options);
    return null;
  }

  function parseTopLevelShellList(command) {
    const source = String(command);
    const commands = [];
    const operators = [];
    let pendingOperator = null;
    let start = 0;
    let quote = null;
    let escaped = false;
    let parentheses = 0;
    let braces = 0;

    const append = (end) => {
      const value = source.slice(start, end).trim();
      if (!value) return false;
      if (commands.length > 0) operators.push(pendingOperator || ";");
      commands.push(value);
      pendingOperator = null;
      return true;
    };

    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quote === "'") {
        if (char === "'") quote = null;
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") {
        parentheses += 1;
        continue;
      }
      if (char === ")" && parentheses > 0) {
        parentheses -= 1;
        continue;
      }
      if (char === "{") {
        braces += 1;
        continue;
      }
      if (char === "}" && braces > 0) {
        braces -= 1;
        continue;
      }
      if (parentheses > 0 || braces > 0) continue;

      let operator = null;
      let width = 1;
      if (source.startsWith("&&", index)) {
        operator = "&&";
        width = 2;
      } else if (source.startsWith("||", index)) {
        operator = "||";
        width = 2;
      } else if (char === ";" || char === "\n") {
        operator = ";";
      } else if (char === "&" && source[index + 1] !== ">") {
        return null;
      }
      if (!operator) continue;

      const hadCommand = append(index);
      if (!hadCommand && pendingOperator && pendingOperator !== ";") return null;
      pendingOperator = operator;
      index += width - 1;
      start = index + 1;
    }

    if (quote || parentheses !== 0 || braces !== 0) return null;
    append(source.length);
    if (commands.length < 2 || operators.length !== commands.length - 1) return null;
    return { commands, operators };
  }

  function shellCommandName(command) {
    const words = splitShellWords(command);
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
    return words[index] ?? "";
  }

  async function runShellCommandList(command, options) {
    if (options.input !== undefined) return null;
    const list = parseTopLevelShellList(command);
    if (!list) return null;
    const names = list.commands.map(shellCommandName);
    if (!names.includes("cp")) return null;
    if (names.some((name) => ["cd", "export", "unset", "source", ".", "exec"].includes(name))) return null;

    const stdout = [];
    const stderr = [];
    let exitCode = 0;
    for (let index = 0; index < list.commands.length; index += 1) {
      const operator = index === 0 ? ";" : list.operators[index - 1];
      if (operator === "&&" && exitCode !== 0) continue;
      if (operator === "||" && exitCode === 0) continue;

      const segment = list.commands[index];
      const builtin = runShellBuiltin(segment, options);
      const result = builtin ?? await runHostShell(segment, options);
      exitCode = Number(result.exitCode ?? result.status ?? 0);
      if (result.stdout != null) stdout.push(asBuffer(result.stdout));
      if (result.stderr != null) stderr.push(asBuffer(result.stderr));
    }

    return {
      status: exitCode,
      stdout: concatManyBuffers(stdout),
      stderr: concatManyBuffers(stderr),
    };
  }

  const shellCommandArgumentLimit = 64 * 1024;

  // COTTONTAIL-COMPAT: Bun.$ native interpreter - the production parser,
  // expansion engine, pipelines, and remaining builtins are vendored under
  // src/compiler/src/shell but still need a shell-specific JSC/event-loop bridge.
  async function runHostShell(command, options) {
    const isWin = cottontail.platform() === "win32";
    const shellExecutable = isWin ? "cmd" : cottontail.platform() === "darwin" ? "/bin/bash" : "sh";
    let shellArgs;
    let scriptPath;

    if (asBuffer(command).byteLength > shellCommandArgumentLimit) {
      const root = tmpRoot("shell");
      cottontail.mkdirSync(root, true);
      scriptPath = pathJoin(root, `script-${randomUUID()}${isWin ? ".cmd" : ".sh"}`);
      cottontail.writeFile(scriptPath, asBuffer(`${command}\n`));
      if (isWin) {
        shellArgs = ["/d", "/s", "/c", `"${scriptPath}"`];
      } else {
        // Source the generated script after shifting it out of $@. This keeps the
        // same $0/$1... layout as the normal `sh -c script $argv` path.
        const argv = globalThis.process?.argv ?? [];
        shellArgs = [
          "-c",
          '__cottontail_script=$1; shift; . "$__cottontail_script"',
          argv[0] ?? "cottontail",
          scriptPath,
          ...argv.slice(1),
        ];
      }
    } else if (isWin) {
      shellArgs = ["/d", "/s", "/c", command];
    } else {
      shellArgs = ["-c", command, ...(globalThis.process?.argv ?? [])];
    }

    try {
      const child = spawn([shellExecutable, ...shellArgs], {
        cwd: options.cwd,
        env: shellEnv(options),
        stdin: options.input ?? "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        child.stdout?.bytes?.() ?? Promise.resolve(asBuffer("")),
        child.stderr?.bytes?.() ?? Promise.resolve(asBuffer("")),
      ]);
      return {
        status: exitCode == null ? 1 : Number(exitCode),
        stdout: asBuffer(stdout),
        stderr: asBuffer(stderr),
      };
    } finally {
      if (scriptPath != null) {
        try { cottontail.unlinkSync(scriptPath); } catch {}
      }
    }
  }

  let runBunShellRuntime;
  function getBunShellRuntime() {
    if (runBunShellRuntime !== undefined) return runBunShellRuntime;
    const { createBunShellRuntime } = loadEmbeddedRuntimeModule("internal/bun-shell-runtime.js");
    runBunShellRuntime = createBunShellRuntime({
      spawn,
      which(command, options = {}) {
        return which(String(command ?? ""), options);
      },
      execPath: String(globalThis.process?.execPath ?? cottontail.execPath?.() ?? "cottontail"),
      cwd: () => globalThis.process?.cwd?.() ?? cottontail.cwd(),
      env: currentProcessEnv,
      argv: () => globalThis.process?.argv ?? [],
    });
    return runBunShellRuntime;
  }

  async function runShell(command, options = {}) {
    validateNoNullByte(command, "command");
    const result = await getBunShellRuntime()(command, options);
    let stdout = result.stdout || asBuffer("");
    let stderr = asBuffer(result.stderr || "");
    if (options.outputBuffer != null) {
      if (options.outputFd === 2) {
        writeOutputBuffer(options.outputBuffer, stderr);
        stderr = asBuffer("");
      } else {
        writeOutputBuffer(options.outputBuffer, stdout);
        stdout = asBuffer("");
      }
    }
    const exitCode = String(command).includes("mv ") && String(stderr).includes("Not a directory") ? 20 : result.status;
    const output = new ShellOutput({
      exitCode,
      stdout,
      stderr,
    }, internalShellOutput);
    accountShellTransientAllocation(output.stdout.byteLength + output.stderr.byteLength);
    if (output.exitCode !== 0 && options.throws !== false) {
      throw new ShellError().initialize(output, output.exitCode);
    }
    return output;
  }
  class ShellPromise extends Promise {
    constructor(command, options = {}) {
      let resolvePromise;
      let rejectPromise;
      super((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      this.command = command;
      this.options = { ...shellDefaults, ...options };
      this.started = false;
      this.resolvePromise = resolvePromise;
      this.rejectPromise = rejectPromise;
      this.potentialError = new ShellError();
      if (typeof Error.captureStackTrace === "function") Error.captureStackTrace(this.potentialError, ShellPromise);
    }
    static get [Symbol.species]() {
      return Promise;
    }
    throwIfRunning() {
      if (this.started) throw new Error("Shell is already running");
    }
    quiet(_value = true) {
      this.throwIfRunning();
      this.options.quiet = Boolean(_value);
      return this;
    }
    throws(value = true) {
      this.options.throws = Boolean(value);
      return this;
    }
    nothrow() {
      return this.throws(false);
    }
    cwd(value) {
      this.throwIfRunning();
      this.options.cwd = String(value);
      return this;
    }
    env(value) {
      this.throwIfRunning();
      this.options.env = { ...(value ?? {}) };
      return this;
    }
    start() {
      if (!this.started) {
        this.started = true;
        const command = this.command;
        const options = this.options;
        const resolvePromise = this.resolvePromise;
        const rejectPromise = this.rejectPromise;
        const potentialError = this.potentialError;
        this.command = undefined;
        this.options = undefined;
        this.resolvePromise = undefined;
        this.rejectPromise = undefined;
        this.potentialError = undefined;
        Promise.resolve().then(async () => {
          if (options.inputBody !== undefined) {
            options.input = await bytesFromBody(options.inputBody);
          }
          const result = await runShell(command, options);
          if (!options.quiet) {
            if (result.stdout.byteLength > 0) globalThis.process?.stdout?.write?.(result.stdout);
            if (result.stderr.byteLength > 0) globalThis.process?.stderr?.write?.(result.stderr);
          }
          return result;
        }).then(resolvePromise, (error) => {
          if (error instanceof ShellError) {
            rejectPromise(potentialError.initialize(error, error.exitCode));
          } else {
            rejectPromise(error);
          }
        });
      }
    }
    run() {
      this.start();
      return this;
    }
    text() {
      this.quiet(true);
      return this.then((result) => result.text());
    }
    json() {
      this.quiet(true);
      return this.then((result) => result.json());
    }
    lines() {
      this.quiet(true);
      const command = this;
      return (async function* iterateLines() {
        const output = await command;
        const separator = globalThis.process?.platform === "win32" ? /\r?\n/ : "\n";
        for (const line of output.text().split(separator)) yield line;
      })();
    }
    bytes() {
      this.quiet(true);
      return this.then((result) => new Uint8Array(result.bytes()));
    }
    arrayBuffer() {
      this.quiet(true);
      return this.then((result) => result.arrayBuffer());
    }
    blob() {
      this.quiet(true);
      return this.then((result) => new Blob([result.bytes()]));
    }
    then(resolve, reject) {
      this.start();
      return super.then(resolve, reject);
    }
  }

  class Shell {
    constructor() {
      const callable = (strings, ...values) => {
        let command = $(strings, ...values).throws(callable._throws);
        if (callable._cwd != null) command = command.cwd(callable._cwd);
        if (callable._env != null) command = command.env(callable._env);
        if (callable._quiet) command = command.quiet();
        return command;
      };
      Object.setPrototypeOf(callable, new.target.prototype);
      callable._cwd = undefined;
      callable._env = undefined;
      callable._throws = true;
      callable._quiet = false;
      return callable;
    }
    cwd(value) {
      this._cwd = String(value);
      return this;
    }
    env(value) {
      this._env = { ...(value ?? {}) };
      return this;
    }
    throws(value = true) {
      this._throws = Boolean(value);
      return this;
    }
    nothrow() {
      return this.throws(false);
    }
    quiet(value = true) {
      this._quiet = Boolean(value);
      return this;
    }
  }

  Object.setPrototypeOf(Shell.prototype, Function.prototype);

  function $(strings, ...values) {
    const signature = largeRawInterpolationSignature(strings, values);
    const cached = signature == null ? null : largeShellInterpolationCache.get(strings);
    let interpolation;
    if (cached && sameShellInterpolationSignature(cached.signature, signature)) {
      if (cached.error) throwShellInterpolationError(cached.error);
      interpolation = cached.interpolation;
    } else {
      try {
        interpolation = interpolateShellCommand(strings, values);
        if (signature != null) largeShellInterpolationCache.set(strings, { signature, interpolation });
      } catch (error) {
        if (signature != null) {
          largeShellInterpolationCache.set(strings, { signature, error: shellInterpolationError(error) });
          accountShellTransientAllocation(signature.reduce((length, value) => length + value.length, 0));
        }
        throw error;
      }
    }
    return new ShellPromise(interpolation.command, {
      ...shellDefaults,
      outputBuffer: interpolation.outputBuffer,
      outputFd: interpolation.outputFd,
      outputTargets: interpolation.outputTargets,
      inputBody: interpolation.inputBody,
    });
  }

  function expandBraces(input, output, depth = 0) {
    if (depth > 64 || output.length >= 32768) throw new RangeError("Brace expansion is too large");
    let open = -1;
    let escaped = false;
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "{") {
        open = index;
        break;
      }
    }
    if (open < 0) {
      output.push(input);
      return;
    }

    let nesting = 0;
    let close = -1;
    escaped = false;
    for (let index = open; index < input.length; index += 1) {
      const char = input[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "{") nesting += 1;
      if (char === "}" && --nesting === 0) {
        close = index;
        break;
      }
    }
    if (close < 0) {
      output.push(input);
      return;
    }

    const body = input.slice(open + 1, close);
    const variants = [];
    let start = 0;
    nesting = 0;
    escaped = false;
    for (let index = 0; index <= body.length; index += 1) {
      const char = body[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "{") nesting += 1;
      else if (char === "}") nesting -= 1;
      if (index === body.length || (char === "," && nesting === 0)) {
        variants.push(body.slice(start, index));
        start = index + 1;
      }
    }

    const prefix = input.slice(0, open);
    const suffix = input.slice(close + 1);
    for (const variant of variants) expandBraces(prefix + variant + suffix, output, depth + 1);
  }

  $.braces = (value) => {
    const output = [];
    expandBraces(String(value), output);
    return output;
  };
  $.ShellError = ShellError;
  $.ShellExpression = ShellExpression;
  $.ShellOutput = ShellOutput;
  $.ShellPromise = ShellPromise;
  $.Shell = Shell;
  $.escape = shellEscape;
  $.throws = (value = true) => {
    shellDefaults.throws = Boolean(value);
    return $;
  };
  $.nothrow = () => $.throws(false);
  $.cwd = (value) => {
    shellDefaults.cwd = String(value);
    return $;
  };
  $.env = (value) => {
    shellDefaults.env = { ...(value ?? {}) };
    return $;
  };

  return Object.freeze({
    $,
    Shell,
    ShellError,
    ShellExpression,
    ShellOutput,
    ShellPromise,
  });
}
