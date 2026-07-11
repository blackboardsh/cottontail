import Module, { _resolveFilename } from "../node/module.js";

export const jscInternals = {
  isLatin1String(value) {
    return /^[\x00-\xff]*$/.test(String(value));
  },
  isUTF16String(value) {
    return !this.isLatin1String(value);
  },
};

function internalUnavailable(name) {
  return () => {
    throw new Error(`bun:internal-for-testing ${name} is unavailable in Cottontail`);
  };
}

export const cssInternals = new Proxy({}, {
  get(_target, property) {
    return internalUnavailable(`cssInternals.${String(property)}`);
  },
});

export const shellInternals = {
  builtinDisabled() {
    return false;
  },
  lex: internalUnavailable("shellInternals.lex"),
  parse: internalUnavailable("shellInternals.parse"),
};

export const patchInternals = {
  apply: internalUnavailable("patchInternals.apply"),
  makeDiff: internalUnavailable("patchInternals.makeDiff"),
  parse: internalUnavailable("patchInternals.parse"),
};

export const iniInternals = {
  parse(source) {
    const result = {};
    for (const line of String(source).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(";") || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
    return result;
  },
};

export function decodeURIComponentSIMD(value) {
  try {
    return decodeURIComponent(String(value));
  } catch {
    return String(value).replace(/%[0-9A-Fa-f]{0,2}/g, "\ufffd");
  }
}

export function hasNonReifiedStatic() {
  return false;
}

export function isModuleResolveFilenameSlowPathEnabled() {
  return Module._resolveFilename !== _resolveFilename;
}

export function highlightJavaScript(source) {
  return String(source);
}

export function setSocketOptions() {
  return undefined;
}

export function createSocketPair() {
  throw new Error("bun:internal-for-testing createSocketPair is unavailable in Cottontail");
}

export function canonicalizeIP(value) {
  return String(value).toLowerCase();
}

export default {
  canonicalizeIP,
  createSocketPair,
  cssInternals,
  decodeURIComponentSIMD,
  hasNonReifiedStatic,
  highlightJavaScript,
  iniInternals,
  isModuleResolveFilenameSlowPathEnabled,
  jscInternals,
  patchInternals,
  setSocketOptions,
  shellInternals,
};
