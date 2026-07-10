import { resolve } from "./path.js";
import { Buffer } from "./buffer.js";
import { parse as parseQuery, stringify as stringifyQuery } from "./querystring.js";
import { toASCII, toUnicode } from "./punycode.js";

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

function normalizePatternComponent(name, value) {
  if (value == null) return "*";
  const text = String(value);
  if (name === "protocol") return text.replace(/:$/, "");
  if (name === "search") return text.replace(/^\?/, "");
  if (name === "hash") return text.replace(/^#/, "");
  return text;
}

function escapePatternLiteral(value) {
  return value.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function componentGroupPattern(component, modifier) {
  if (component === "pathname") {
    if (modifier === "*" || modifier === "+") return modifier === "+" ? ".+" : ".*";
    return "[^/]+";
  }
  if (component === "hostname") return "[^.]+";
  return "[^]*";
}

function compilePatternComponent(component, pattern) {
  const text = normalizePatternComponent(component, pattern);
  if (text === "*") {
    return {
      pattern: text,
      match(value) {
        return { "0": value };
      },
    };
  }

  const names = [];
  let source = "^";
  let anonymous = 0;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (char === "*") {
      names.push(String(anonymous++));
      source += `(${componentGroupPattern(component, "*")})`;
      index += 1;
      continue;
    }
    if (char === ":") {
      const match = text.slice(index + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (match) {
        const name = match[1];
        index += 1 + name.length;
        let group = componentGroupPattern(component, "");
        if (text[index] === "(") {
          let depth = 1;
          let end = index + 1;
          while (end < text.length && depth > 0) {
            if (text[end] === "(") depth += 1;
            else if (text[end] === ")") depth -= 1;
            end += 1;
          }
          if (depth === 0) {
            group = text.slice(index + 1, end - 1);
            index = end;
          }
        }
        const modifier = text[index] === "*" || text[index] === "+" || text[index] === "?" ? text[index++] : "";
        if (modifier === "*" || modifier === "+") group = componentGroupPattern(component, modifier);
        names.push(name);
        source += `(${group})${modifier === "?" ? "?" : ""}`;
        continue;
      }
    }
    source += escapePatternLiteral(char);
    index += 1;
  }
  source += "$";

  const regex = new RegExp(source, component === "protocol" || component === "hostname" ? "i" : "");
  return {
    pattern: text,
    match(value) {
      const match = regex.exec(value);
      if (!match) return null;
      const groups = {};
      for (let index = 0; index < names.length; index += 1) {
        groups[names[index]] = match[index + 1] ?? "";
      }
      return groups;
    },
  };
}

function urlPatternInputToURL(input, baseURL = undefined) {
  if (typeof input === "string") return new URL(input, baseURL);
  const base = input?.baseURL ?? baseURL ?? `${normalizePatternComponent("protocol", input?.protocol ?? "http")}://${input?.hostname ?? "example.test"}`;
  const url = new URL(input?.pathname ?? "/", base);
  if (input?.protocol != null) url.protocol = `${normalizePatternComponent("protocol", input.protocol)}:`;
  if (input?.username != null) url.username = String(input.username);
  if (input?.password != null) url.password = String(input.password);
  if (input?.hostname != null) url.hostname = String(input.hostname);
  if (input?.port != null) url.port = String(input.port);
  if (input?.search != null) url.search = String(input.search);
  if (input?.hash != null) url.hash = String(input.hash);
  return url;
}

function urlPatternValues(url) {
  return {
    protocol: url.protocol.replace(/:$/, ""),
    username: url.username,
    password: url.password,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search.replace(/^\?/, ""),
    hash: url.hash.replace(/^#/, ""),
  };
}

export const URLPattern = globalThis.URLPattern ?? class URLPattern {
  constructor(input = {}, baseURL = undefined) {
    const pattern = typeof input === "string" ? urlPatternInputToURL(input, baseURL) : input;
    this.protocol = normalizePatternComponent("protocol", pattern.protocol);
    this.username = normalizePatternComponent("username", pattern.username);
    this.password = normalizePatternComponent("password", pattern.password);
    this.hostname = normalizePatternComponent("hostname", pattern.hostname);
    this.port = normalizePatternComponent("port", pattern.port);
    this.pathname = normalizePatternComponent("pathname", pattern.pathname);
    this.search = normalizePatternComponent("search", pattern.search);
    this.hash = normalizePatternComponent("hash", pattern.hash);
    this._compiled = {
      protocol: compilePatternComponent("protocol", this.protocol),
      username: compilePatternComponent("username", this.username),
      password: compilePatternComponent("password", this.password),
      hostname: compilePatternComponent("hostname", this.hostname),
      port: compilePatternComponent("port", this.port),
      pathname: compilePatternComponent("pathname", this.pathname),
      search: compilePatternComponent("search", this.search),
      hash: compilePatternComponent("hash", this.hash),
    };
  }

  test(input = {}, baseURL = undefined) {
    return this.exec(input, baseURL) !== null;
  }

  exec(input = {}, baseURL = undefined) {
    const url = urlPatternInputToURL(input, baseURL);
    const values = urlPatternValues(url);
    const matches = {};
    for (const component of ["protocol", "username", "password", "hostname", "port", "pathname", "search", "hash"]) {
      const groups = this._compiled[component].match(values[component]);
      if (groups == null) return null;
      matches[component] = groups;
    }
    return {
      inputs: [input],
      protocol: { input: values.protocol, groups: matches.protocol },
      username: { input: values.username, groups: matches.username },
      password: { input: values.password, groups: matches.password },
      hostname: { input: values.hostname, groups: matches.hostname },
      port: { input: values.port, groups: matches.port },
      pathname: { input: values.pathname, groups: matches.pathname },
      search: { input: values.search, groups: matches.search },
      hash: { input: values.hash, groups: matches.hash },
    };
  }
};

export class Url {
  constructor() {
    this.protocol = null;
    this.slashes = null;
    this.auth = null;
    this.host = null;
    this.port = null;
    this.hostname = null;
    this.hash = null;
    this.search = null;
    this.query = null;
    this.pathname = null;
    this.path = null;
    this.href = "";
  }

  parse(url, parseQueryString = false, slashesDenoteHost = false) {
    Object.assign(this, parse(url, parseQueryString, slashesDenoteHost));
    return this;
  }

  format() {
    return format(this);
  }

  resolve(relative) {
    return resolveUrl(this.href, relative);
  }

  resolveObject(relative) {
    return resolveObject(this.href, relative);
  }
}

export function pathToFileURL(path) {
  const absolute = resolve(String(path));
  return new URL(`file://${absolute.split("/").map(encodeURIComponent).join("/")}`);
}

export function fileURLToPath(url) {
  const href = typeof url === "string" ? url : String(url?.href ?? url);
  if (!href.startsWith("file://")) return href;
  return decodeURIComponent(href.slice("file://".length).split("?")[0].split("#")[0]);
}

export function fileURLToPathBuffer(url) {
  return Buffer.from(fileURLToPath(url));
}

export function domainToASCII(domain) {
  return toASCII(String(domain));
}

export function domainToUnicode(domain) {
  return toUnicode(String(domain));
}

export function parse(input, parseQueryString = false, slashesDenoteHost = false) {
  const text = String(input);
  const out = new Url();
  let parsed = null;
  try {
    parsed = new URL(text, slashesDenoteHost ? "resolve:///" : undefined);
  } catch {
    try { parsed = new URL(text, "resolve:///"); } catch {}
  }
  if (parsed) {
    const synthetic = parsed.protocol === "resolve:";
    out.protocol = synthetic ? null : parsed.protocol || null;
    out.slashes = synthetic ? (text.startsWith("//") ? true : null) : true;
    out.auth = parsed.username || parsed.password ? `${decodeURIComponent(parsed.username)}${parsed.password ? `:${decodeURIComponent(parsed.password)}` : ""}` : null;
    out.host = synthetic ? null : parsed.host || null;
    out.port = synthetic ? null : parsed.port || null;
    out.hostname = synthetic ? null : parsed.hostname || null;
    out.hash = parsed.hash || null;
    out.search = parsed.search || null;
    out.query = parseQueryString ? parseQuery(parsed.search.replace(/^\?/, "")) : parsed.search.replace(/^\?/, "") || null;
    out.pathname = parsed.pathname || null;
    out.path = `${out.pathname ?? ""}${out.search ?? ""}` || null;
    out.href = synthetic ? `${out.path ?? ""}${out.hash ?? ""}` : parsed.href;
    return out;
  }
  out.href = text;
  out.pathname = text;
  out.path = text;
  out.query = parseQueryString ? parseQuery("") : null;
  return out;
}

export function format(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  const protocol = input.protocol ?? "";
  const slashes = input.slashes || input.host || input.hostname ? "//" : "";
  const auth = input.auth ? `${encodeURIComponent(input.auth).replace(/%3A/i, ":")}@` : "";
  const host = input.host ?? (input.hostname ? `${input.hostname}${input.port ? `:${input.port}` : ""}` : "");
  let pathname = input.pathname ?? "";
  let search = input.search;
  if (search == null && input.query != null) {
    search = typeof input.query === "string" ? input.query : stringifyQuery(input.query);
    if (search && !search.startsWith("?")) search = `?${search}`;
  }
  const hash = input.hash ? (String(input.hash).startsWith("#") ? input.hash : `#${input.hash}`) : "";
  return `${protocol}${slashes}${auth}${host}${pathname}${search ?? ""}${hash}`;
}

function normalizeUrlPathname(pathname) {
  const leading = String(pathname).startsWith("/");
  const trailing = String(pathname).endsWith("/");
  const parts = [];
  for (const part of String(pathname).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const normalized = `${leading ? "/" : ""}${parts.join("/")}`;
  return `${normalized || (leading ? "/" : "")}${trailing && parts.length > 0 ? "/" : ""}`;
}

function authorityFromHref(href) {
  const match = String(href).match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/);
  if (!match) return {};
  let authority = match[1];
  let auth = undefined;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    auth = decodeURIComponent(authority.slice(0, at));
    authority = authority.slice(at + 1);
  }
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    const hostname = authority.slice(1, end);
    const port = authority[end + 1] === ":" ? authority.slice(end + 2) : "";
    return { auth, hostname, port };
  }
  const colon = authority.lastIndexOf(":");
  if (colon > -1 && authority.indexOf(":") === colon) {
    return { auth, hostname: authority.slice(0, colon), port: authority.slice(colon + 1) };
  }
  return { auth, hostname: authority, port: "" };
}

export function resolveUrl(from, to) {
  const resolved = new URL(String(to), String(from));
  resolved.pathname = normalizeUrlPathname(resolved.pathname);
  return resolved.href;
}

export { resolveUrl as resolve };

export function resolveObject(from, to) {
  return parse(resolveUrl(typeof from === "string" ? from : format(from), typeof to === "string" ? to : format(to)));
}

export function urlToHttpOptions(url) {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const authority = authorityFromHref(parsed.href ?? String(url));
  const options = {
    protocol: parsed.protocol,
    hostname: authority.hostname || parsed.hostname,
    hash: parsed.hash,
    search: parsed.search,
    pathname: parsed.pathname,
    path: `${parsed.pathname || ""}${parsed.search || ""}`,
    href: parsed.href,
  };
  const port = authority.port || parsed.port;
  if (port) options.port = Number(port);
  const auth = authority.auth ?? (parsed.username || parsed.password ? `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}` : undefined);
  if (auth != null) options.auth = auth;
  return options;
}

export default {
  URL,
  URLPattern,
  URLSearchParams,
  Url,
  domainToASCII,
  domainToUnicode,
  fileURLToPath,
  fileURLToPathBuffer,
  format,
  parse,
  pathToFileURL,
  resolve: resolveUrl,
  resolveObject,
  urlToHttpOptions,
};
