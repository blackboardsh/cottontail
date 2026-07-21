export function parseDotenvInto(source, fileVars, lookupEnv) {
  const lookup = name => {
    if (name in lookupEnv) return lookupEnv[name];
    if (name in fileVars) return fileVars[name];
    return undefined;
  };
  const expand = text => {
    let output = "";
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === "\\" && text[index + 1] === "$") {
        output += "$";
        index += 1;
        continue;
      }
      if (char !== "$") {
        output += char;
        continue;
      }
      if (text[index + 1] === "{") {
        const close = text.indexOf("}", index + 2);
        if (close === -1) {
          output += char;
          continue;
        }
        const body = text.slice(index + 2, close);
        const dash = body.indexOf(":-");
        const name = dash === -1 ? body : body.slice(0, dash);
        const fallback = dash === -1 ? "" : body.slice(dash + 2);
        const value = lookup(name);
        output += value === undefined || value === "" ? (dash === -1 ? (value ?? "") : fallback) : value;
        index = close;
        continue;
      }
      let end = index + 1;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
      if (end === index + 1) {
        output += char;
        continue;
      }
      const value = lookup(text.slice(index + 1, end));
      output += value ?? "";
      index = end - 1;
    }
    return output;
  };
  const unescapeQuoted = text => {
    let output = "";
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === "\\" && text[index + 1] === "n") {
        output += "\n";
        index += 1;
        continue;
      }
      if (char === "\r") {
        output += "\n";
        continue;
      }
      output += char;
    }
    return output;
  };

  let index = 0;
  const length = source.length;
  while (index < length) {
    while (index < length && (source[index] === "\n" || source[index] === "\r" || source[index] === " " || source[index] === "\t")) index += 1;
    if (index >= length) break;
    if (source[index] === "#") {
      while (index < length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    let keyEnd = index;
    while (keyEnd < length && source[keyEnd] !== "=" && source[keyEnd] !== ":" && source[keyEnd] !== "\n" && source[keyEnd] !== "\r") keyEnd += 1;
    if (keyEnd >= length || source[keyEnd] === "\n" || source[keyEnd] === "\r") {
      index = keyEnd;
      continue;
    }
    let key = source.slice(index, keyEnd).trim();
    if (/^export\s+\S/.test(key)) key = key.replace(/^export\s+/, "");
    index = keyEnd + 1;
    if (!/^[A-Za-z0-9_]+$/.test(key)) {
      while (index < length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      continue;
    }
    while (index < length && (source[index] === " " || source[index] === "\t")) index += 1;
    const quote = source[index];
    if (quote === '"' || quote === "'" || quote === "`") {
      let end = index + 1;
      while (end < length && source[end] !== quote) end += 1;
      const raw = source.slice(index + 1, end);
      index = end < length ? end + 1 : end;
      while (index < length && source[index] !== "\n" && source[index] !== "\r") index += 1;
      if (quote === "'") fileVars[key] = raw.replace(/\r/g, "\n");
      else fileVars[key] = expand(unescapeQuoted(raw));
      continue;
    }
    let end = index;
    while (end < length && source[end] !== "\n" && source[end] !== "\r") end += 1;
    let raw = source.slice(index, end);
    index = end;
    const comment = raw.indexOf("#");
    if (comment !== -1) raw = raw.slice(0, comment);
    fileVars[key] = expand(raw.trim());
  }
}

export function installDotenvLoader(processObject = globalThis.process) {
  globalThis.__cottontailLoadDotenv = function __cottontailLoadDotenv() {
    if (globalThis.__cottontailDotenvLoaded) return;
    globalThis.__cottontailDotenvLoaded = true;
    try {
      const env = processObject.env;
      const isTest = !!globalThis.__cottontailBunTestHeaderPrinted;
      if (isTest && env.NODE_ENV === undefined) env.NODE_ENV = "test";
      const original = { ...env };

      try {
        const bunfig = String(cottontail.readFile("bunfig.toml"));
        if (/^\s*env\s*=\s*false\s*$/m.test(bunfig)) return;
        const envSection = bunfig.split(/^\s*\[/m).find(section => section.startsWith("env]"));
        if (envSection && /^\s*file\s*=\s*false\s*$/m.test(envSection)) return;
      } catch {}

      const files = [];
      let explicit = false;
      const execArgv = processObject.execArgv || [];
      for (let argIndex = 0; argIndex < execArgv.length; argIndex++) {
        const arg = String(execArgv[argIndex]);
        if (arg === "--no-env-file") {
          explicit = true;
          continue;
        }
        let value = null;
        if (arg === "--env-file" || arg === "--env-file-if-exists") value = execArgv[argIndex + 1] != null ? String(execArgv[++argIndex]) : "";
        else if (arg.startsWith("--env-file=")) value = arg.slice("--env-file=".length);
        else if (arg.startsWith("--env-file-if-exists=")) value = arg.slice("--env-file-if-exists=".length);
        if (value === null) continue;
        explicit = true;
        const cleaned = value.replace(/^['"]+|['"]+$/g, "");
        if (cleaned === "") continue;
        for (const part of cleaned.split(",")) {
          if (part) files.push(part);
        }
      }
      if (!explicit) {
        const nodeEnv = env.NODE_ENV;
        const suffix = nodeEnv === "production" ? "production" : nodeEnv === "test" ? "test" : "development";
        files.push(".env", `.env.${suffix}`);
        if (suffix !== "test") files.push(".env.local");
        files.push(`.env.${suffix}.local`);
      }

      const fileVars = Object.create(null);
      for (const file of files) {
        let source;
        try {
          const stats = cottontail.statSync?.(file);
          if (stats && typeof stats.isFile === "function" && !stats.isFile()) continue;
          source = cottontail.readFile(String(file));
        } catch {
          continue;
        }
        try {
          parseDotenvInto(String(source), fileVars, original);
        } catch {}
      }
      for (const key of Object.keys(fileVars)) {
        if (!(key in original)) env[key] = fileVars[key];
      }
    } catch {}
  };
}
