const platformValue = cottontail.platform();
const archValue = cottontail.arch();
const pathSep = platformValue === 'win32' ? '\\' : '/';

function isSeparator(char) {
  return char === '/' || char === '\\';
}

function trimLeadingSeparators(value) {
  let index = 0;

  while (index < value.length && isSeparator(value[index])) {
    index += 1;
  }

  return value.slice(index);
}

function trimTrailingSeparators(value) {
  let end = value.length;

  while (end > 0 && isSeparator(value[end - 1])) {
    end -= 1;
  }

  return value.slice(0, end);
}

function normalizePath(value) {
  if (value.length === 0) {
    return value;
  }

  let result = '';
  let previousWasSeparator = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (isSeparator(char)) {
      if (!previousWasSeparator) {
        result += pathSep;
        previousWasSeparator = true;
      }
    } else {
      result += char;
      previousWasSeparator = false;
    }
  }

  return result;
}

function mergeEnv(extraEnv) {
  if (extraEnv === undefined) {
    return cottontail.env();
  }

  return {
    ...cottontail.env(),
    ...extraEnv,
  };
}

export const fs = {
  existsSync(filePath) {
    return cottontail.existsSync(filePath);
  },

  mkdirSync(dirPath, options = {}) {
    cottontail.mkdirSync(dirPath, !!options.recursive);
  },

  readFileSync(filePath, encoding = 'utf8') {
    if (encoding !== 'utf8' && encoding !== 'utf-8') {
      throw new Error(`Unsupported encoding: ${encoding}`);
    }

    return cottontail.readFile(filePath);
  },

  rmSync(targetPath, options = {}) {
    cottontail.rmSync(targetPath, !!options.recursive, !!options.force);
  },

  unlinkSync(targetPath) {
    cottontail.unlinkSync(targetPath);
  },

  writeFileSync(filePath, contents) {
    cottontail.writeFile(filePath, contents);
  },

  chmodSync(filePath, mode) {
    cottontail.chmodSync(filePath, mode);
  },
};

export const path = {
  sep: pathSep,

  join(...parts) {
    const filtered = parts
      .map((part) => String(part))
      .filter((part) => part.length > 0);

    if (filtered.length === 0) {
      return '';
    }

    let result = filtered[0];
    for (let index = 1; index < filtered.length; index += 1) {
      const part = trimLeadingSeparators(filtered[index]);

      if (result === '' || isSeparator(result[result.length - 1])) {
        result += part;
      } else {
        result += pathSep + part;
      }
    }

    return normalizePath(result);
  },

  dirname(filePath) {
    const normalized = normalizePath(filePath);
    const trimmed = trimTrailingSeparators(normalized);
    const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));

    if (lastSlash < 0) {
      return '.';
    }

    if (lastSlash === 0) {
      return trimmed[0];
    }

    return trimmed.slice(0, lastSlash);
  },
};

export const os = {
  arch() {
    return archValue;
  },

  platform() {
    return platformValue;
  },
};

export const proc = {
  argv: cottontail.args,

  cwd() {
    return cottontail.cwd();
  },

  env(name) {
    if (name === undefined) {
      return cottontail.env();
    }

    return cottontail.env(name);
  },

  exit(code = 0) {
    cottontail.exit(code);
  },

  spawnSync(file, args = [], options = {}) {
    return cottontail.spawnSync(file, args, {
      cwd: options.cwd,
      env: mergeEnv(options.env),
      stdio: options.stdio ?? 'pipe',
    });
  },
};

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function binaryName(baseName) {
  return platformValue === 'win32' ? `${baseName}.exe` : baseName;
}

export function fail(message) {
  console.error(message);
  proc.exit(1);
}

export function runChecked(file, args = [], options = {}) {
  const result = proc.spawnSync(file, args, {
    ...options,
    stdio: options.stdio ?? 'inherit',
  });

  if (result.status !== 0) {
    proc.exit(result.status);
  }

  return result;
}
