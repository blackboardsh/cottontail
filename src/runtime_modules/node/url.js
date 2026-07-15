import { resolve as pathResolve } from "./path.js";
import { Buffer } from "./buffer.js";
import { toASCII, toUnicode } from "./punycode.js";

// Import the vendor implementation directly: globalThis.URL is only assigned
// by bun/index.js after this module has already been evaluated, so grabbing
// the global here would capture the weaker ffi.js bootstrap shim instead.
import { URL, URLSearchParams } from "../vendor/whatwg-url.js";

export { URL, URLSearchParams };

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

// ---------------------------------------------------------------------------
// Legacy node:url implementation. This is a direct port of Bun's
// src/js/node/url.ts (itself derived from Node.js lib/url.js) so that
// url.parse/format/resolve/resolveObject match Bun's observable behavior,
// including WHATWG-based hostname validation (invalid IPv6 literals throw).
// ---------------------------------------------------------------------------

const CHAR_AT = 64; // @
const CHAR_COLON = 58; // :
const CHAR_BACKWARD_SLASH = 92; // \
const CHAR_FORWARD_SLASH = 47; // /
const CHAR_HASH = 35; // #
const CHAR_QUESTION_MARK = 63; // ?
const CHAR_LEFT_SQUARE_BRACKET = 91; // [
const CHAR_RIGHT_SQUARE_BRACKET = 93; // ]
const CHAR_NO_BREAK_SPACE = 160;
const CHAR_ZERO_WIDTH_NOBREAK_SPACE = 65279;

const protocolPattern = /^([a-z0-9.+-]+:)/i;
const portPattern = /:[0-9]*$/;
// Special case for a simple path URL
const simplePathPattern = /^(\/\/?(?!\/)[^?\s]*)(\?[^\s]*)?$/;
// RFC 2396: characters reserved for delimiting URLs. We actually just auto-escape these.
const delims = ["<", ">", '"', "`", " ", "\r", "\n", "\t"];
// RFC 2396: characters not allowed for various reasons.
const unwise = ["{", "}", "|", "\\", "^", "`"].concat(delims);
// Allowed by RFCs, but cause of XSS attacks. Always escape these.
const autoEscape = ["'"].concat(unwise);
// Characters that are never ever allowed in a hostname.
const nonHostChars = ["%", "/", "?", ";", "#"].concat(autoEscape);
const hostEndingChars = ["/", "?", "#"];
const hostnameMaxLen = 255;
// Protocols that can allow "unsafe" and "unwise" chars.
const unsafeProtocol = { __proto__: null, javascript: true, "javascript:": true };
// Protocols that never have a hostname.
const hostlessProtocol = { __proto__: null, javascript: true, "javascript:": true };
// Protocols that always contain a // bit.
const slashedProtocol = {
  __proto__: null,
  http: true,
  https: true,
  ftp: true,
  gopher: true,
  file: true,
  "http:": true,
  "https:": true,
  "ftp:": true,
  "gopher:": true,
  "file:": true,
};

function validateString(value, name) {
  if (typeof value !== "string") {
    const err = new TypeError(`The "${name}" argument must be of type string. Received ${value === null ? "null" : `type ${typeof value}`}`);
    err.code = "ERR_INVALID_ARG_TYPE";
    throw err;
  }
}

function invalidUrlError(input) {
  const err = new TypeError(`Invalid URL: ${input}`);
  err.code = "ERR_INVALID_URL";
  err.input = input;
  return err;
}

function invalidArgTypeError(name, expected, actual) {
  const err = new TypeError(`The "${name}" argument must be of type ${expected}. Received ${actual === null ? "null" : `type ${typeof actual}`}`);
  err.code = "ERR_INVALID_ARG_TYPE";
  return err;
}

function searchParamsToObject(queryText) {
  const out = { __proto__: null };
  for (const [key, value] of new URLSearchParams(queryText)) {
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

export function Url() {
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
  this.href = null;
}

Url.prototype.parse = function parse(url, parseQueryString, slashesDenoteHost) {
  validateString(url, "url");

  // Copy chrome, IE, opera backslash-handling behavior.
  // Back slashes before the query string get converted to forward slashes
  // See: https://code.google.com/p/chromium/issues/detail?id=25916
  let hasHash = false;
  let hasAt = false;
  let start = -1;
  let end = -1;
  let rest = "";
  let lastPos = 0;
  for (let i = 0, inWs = false, split = false; i < url.length; ++i) {
    const code = url.charCodeAt(i);

    // Find first and last non-whitespace characters for trimming
    const isWs = code < 33 || code === CHAR_NO_BREAK_SPACE || code === CHAR_ZERO_WIDTH_NOBREAK_SPACE;
    if (start === -1) {
      if (isWs) continue;
      lastPos = start = i;
    } else if (inWs) {
      if (!isWs) {
        end = -1;
        inWs = false;
      }
    } else if (isWs) {
      end = i;
      inWs = true;
    }

    // Only convert backslashes while we haven't seen a split character
    if (!split) {
      switch (code) {
        case CHAR_AT:
          hasAt = true;
          break;
        case CHAR_HASH:
          hasHash = true;
        // Fall through
        case CHAR_QUESTION_MARK:
          split = true;
          break;
        case CHAR_BACKWARD_SLASH:
          if (i - lastPos > 0) rest += url.slice(lastPos, i);
          rest += "/";
          lastPos = i + 1;
          break;
      }
    } else if (!hasHash && code === CHAR_HASH) {
      hasHash = true;
    }
  }

  // Check if string was non-empty (including strings with only whitespace)
  if (start !== -1) {
    if (lastPos === start) {
      // We didn't convert any backslashes
      if (end === -1) {
        if (start === 0) rest = url;
        else rest = url.slice(start);
      } else {
        rest = url.slice(start, end);
      }
    } else if (end === -1 && lastPos < url.length) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos);
    } else if (end !== -1 && lastPos < end) {
      // We converted some backslashes and have only part of the entire string
      rest += url.slice(lastPos, end);
    }
  }

  if (!slashesDenoteHost && !hasHash && !hasAt) {
    // Try fast path regexp
    const simplePath = simplePathPattern.exec(rest);
    if (simplePath) {
      this.path = rest;
      this.href = rest;
      this.pathname = simplePath[1];
      if (simplePath[2]) {
        this.search = simplePath[2];
        if (parseQueryString) {
          this.query = searchParamsToObject(this.search.slice(1));
        } else {
          this.query = this.search.slice(1);
        }
      } else if (parseQueryString) {
        this.search = null;
        this.query = Object.create(null);
      }
      return this;
    }
  }

  let proto = protocolPattern.exec(rest);
  let lowerProto;
  if (proto) {
    proto = proto[0];
    lowerProto = proto.toLowerCase();
    this.protocol = lowerProto;
    rest = rest.substring(proto.length);
  }

  // Figure out if it's got a host. user@server is *always* interpreted as a
  // hostname, and url resolution will treat //foo/bar as host=foo,path=bar
  // because that's how the browser resolves relative URLs.
  let slashes;
  if (slashesDenoteHost || proto || rest.match(/^\/\/[^@/]+@[^@/]+/)) {
    slashes = rest.substring(0, 2) === "//";
    if (slashes && !(proto && hostlessProtocol[proto])) {
      rest = rest.substring(2);
      this.slashes = true;
    }
  }

  if (!hostlessProtocol[proto] && (slashes || (proto && !slashedProtocol[proto]))) {
    // there's a hostname.
    // the first instance of /, ?, ;, or # ends the host.
    //
    // If there is an @ in the hostname, then non-host chars *are* allowed
    // to the left of the last @ sign, unless some host-ending character
    // comes *before* the @-sign.

    // find the first instance of any hostEndingChars
    let hostEnd = -1;
    for (let i = 0; i < hostEndingChars.length; i++) {
      const hec = rest.indexOf(hostEndingChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
        hostEnd = hec;
      }
    }

    // at this point, either we have an explicit point where the
    // auth portion cannot go past, or the last @ char is the decider.
    let atSign;
    if (hostEnd === -1) {
      // atSign can be anywhere.
      atSign = rest.lastIndexOf("@");
    } else {
      // atSign must be in auth portion.
      // http://a@b/c@d => host:b auth:a path:/c@d
      atSign = rest.lastIndexOf("@", hostEnd);
    }

    // Now we have a portion which is definitely the auth. Pull that off.
    if (atSign !== -1) {
      const auth = rest.slice(0, atSign);
      rest = rest.slice(atSign + 1);
      this.auth = decodeURIComponent(auth);
    }

    // the host is the remaining to the left of the first non-host char
    hostEnd = -1;
    for (let i = 0; i < nonHostChars.length; i++) {
      const hec = rest.indexOf(nonHostChars[i]);
      if (hec !== -1 && (hostEnd === -1 || hec < hostEnd)) {
        hostEnd = hec;
      }
    }
    // if we still have not hit it, then the entire thing is a host.
    if (hostEnd === -1) {
      hostEnd = rest.length;
    }

    this.host = rest.slice(0, hostEnd);
    rest = rest.slice(hostEnd);

    // pull out port.
    this.parseHost();

    // We've indicated that there is a hostname, so even if it's empty, it
    // has to be present.
    if (typeof this.hostname !== "string") {
      this.hostname = "";
    }
    const hostname = this.hostname;

    // if hostname begins with [ and ends with ] assume that it's an IPv6
    // address.
    const ipv6Hostname = isIpv6Hostname(this.hostname);

    // validate a little.
    if (!ipv6Hostname) {
      rest = getHostname(this, rest, hostname, url);
    }

    if (this.hostname.length > hostnameMaxLen) {
      this.hostname = "";
    } else {
      // hostnames are always lower case.
      this.hostname = this.hostname.toLowerCase();
    }

    // IDNA Support: Returns a punycoded representation of "domain".
    // Also validates the hostname (Bun delegates this to the WHATWG URL
    // host parser, which rejects e.g. malformed IPv6 literals).
    if (this.hostname) {
      try {
        this.hostname = new URL(`http://${this.hostname}`).hostname;
      } catch {
        throw invalidUrlError(url);
      }
    }

    const p = this.port ? `:${this.port}` : "";
    const h = this.hostname || "";
    this.host = h + p;

    // strip [ and ] from the hostname; the host field still retains them
    if (ipv6Hostname) {
      this.hostname = this.hostname.slice(1, -1);
      if (rest[0] !== "/") {
        rest = `/${rest}`;
      }
    }
  }

  // now rest is set to the post-host stuff. chop off any delim chars.
  if (!unsafeProtocol[lowerProto]) {
    // First, make 100% sure that any "autoEscape" chars get escaped, even if
    // encodeURIComponent doesn't think they need to be.
    for (let i = 0, l = autoEscape.length; i < l; i++) {
      const ae = autoEscape[i];
      if (rest.indexOf(ae) === -1) {
        continue;
      }
      let esc = encodeURIComponent(ae);
      if (esc === ae) {
        esc = escape(ae);
      }
      rest = rest.split(ae).join(esc);
    }
  }

  // chop off from the tail first.
  const hash = rest.indexOf("#");
  if (hash !== -1) {
    // got a fragment string.
    this.hash = rest.substring(hash);
    rest = rest.slice(0, hash);
  }
  const qm = rest.indexOf("?");
  if (qm !== -1) {
    this.search = rest.substring(qm);
    this.query = rest.substring(qm + 1);
    if (parseQueryString) {
      this.query = searchParamsToObject(this.query);
    }
    rest = rest.slice(0, qm);
  } else if (parseQueryString) {
    // no query string, but parseQueryString still requested
    this.search = null;
    this.query = {};
  }
  if (rest) {
    this.pathname = rest;
  }
  if (slashedProtocol[lowerProto] && this.hostname && !this.pathname) {
    this.pathname = "/";
  }

  // to support http.request
  if (this.pathname || this.search) {
    const p = this.pathname || "";
    const s = this.search || "";
    this.path = p + s;
  }

  // finally, reconstruct the href based on what has been validated.
  this.href = this.format();
  return this;
};

function isIpv6Hostname(hostname) {
  return (
    hostname.charCodeAt(0) === CHAR_LEFT_SQUARE_BRACKET &&
    hostname.charCodeAt(hostname.length - 1) === CHAR_RIGHT_SQUARE_BRACKET
  );
}

let warnInvalidPort = true;
function getHostname(self, rest, hostname, url) {
  for (let i = 0; i < hostname.length; ++i) {
    const code = hostname.charCodeAt(i);
    const isValid =
      code !== CHAR_FORWARD_SLASH &&
      code !== CHAR_BACKWARD_SLASH &&
      code !== CHAR_HASH &&
      code !== CHAR_QUESTION_MARK &&
      code !== CHAR_COLON;

    if (!isValid) {
      // If leftover starts with :, then it represents an invalid port.
      // But url.parse() is lenient about it for now. Issue a warning and
      // continue.
      if (warnInvalidPort && code === CHAR_COLON) {
        const detail = `The URL ${url} is invalid. Future versions of Node.js will throw an error.`;
        globalThis.process?.emitWarning?.(detail, "DeprecationWarning", "DEP0170");
        warnInvalidPort = false;
      }
      self.hostname = hostname.slice(0, i);
      return `/${hostname.slice(i)}${rest}`;
    }
  }
  return rest;
}

Url.prototype.format = function format() {
  let auth = this.auth || "";
  if (auth) {
    auth = encodeURIComponent(auth);
    auth = auth.replace(/%3A/i, ":");
    auth += "@";
  }

  let protocol = this.protocol || "";
  let pathname = this.pathname || "";
  let hash = this.hash || "";
  let host = "";
  let query = "";

  if (this.host) {
    host = auth + this.host;
  } else if (this.hostname) {
    host = auth + (this.hostname.indexOf(":") === -1 ? this.hostname : `[${this.hostname}]`);
    if (this.port) {
      host += `:${this.port}`;
    }
  }

  if (this.query && typeof this.query === "object" && Object.keys(this.query).length) {
    query = new URLSearchParams(this.query).toString();
  }

  let search = this.search || (query && `?${query}`) || "";

  if (protocol && protocol.charAt(protocol.length - 1) !== ":") {
    protocol += ":";
  }

  // only the slashedProtocols get the //. Not mailto:, xmpp:, etc.
  // unless they had them to begin with.
  if (this.slashes || ((!protocol || slashedProtocol[protocol]) && host.length > 0)) {
    host = `//${host || ""}`;
    if (pathname && pathname.charAt(0) !== "/") {
      pathname = `/${pathname}`;
    }
  } else if (!host) {
    host = "";
  }

  if (hash && hash.charAt(0) !== "#") {
    hash = `#${hash}`;
  }
  if (search && search.charAt(0) !== "?") {
    search = `?${search}`;
  }

  pathname = pathname.replace(/[?#]/g, (match) => encodeURIComponent(match));
  search = search.replace("#", "%23");

  return protocol + host + pathname + search + hash;
};

Url.prototype.resolve = function resolve(relative) {
  return this.resolveObject(parse(relative, false, true)).format();
};

Url.prototype.resolveObject = function resolveObject(relative) {
  if (typeof relative === "string") {
    const rel = new Url();
    rel.parse(relative, false, true);
    relative = rel;
  }

  const result = new Url();
  const tkeys = Object.keys(this);
  for (let tk = 0; tk < tkeys.length; tk++) {
    const tkey = tkeys[tk];
    result[tkey] = this[tkey];
  }

  // hash is always overridden, no matter what. even href="" will remove it.
  result.hash = relative.hash;

  // if the relative url is empty, then there's nothing left to do here.
  if (relative.href === "") {
    result.href = result.format();
    return result;
  }

  // hrefs like //foo/bar always cut to the protocol.
  if (relative.slashes && !relative.protocol) {
    // take everything except the protocol from relative
    const rkeys = Object.keys(relative);
    for (let rk = 0; rk < rkeys.length; rk++) {
      const rkey = rkeys[rk];
      if (rkey !== "protocol") {
        result[rkey] = relative[rkey];
      }
    }

    // urlParse appends trailing / to urls like http://www.example.com
    if (slashedProtocol[result.protocol] && result.hostname && !result.pathname) {
      result.pathname = "/";
      result.path = result.pathname;
    }

    result.href = result.format();
    return result;
  }

  if (relative.protocol && relative.protocol !== result.protocol) {
    // if it's a known url protocol, then changing the protocol does weird
    // things. first, if it's not file:, then we MUST have a host, and if
    // there was a path to begin with, then we MUST have a path. if it is
    // file:, then the host is dropped, because that's known to be hostless.
    // anything else is assumed to be absolute.
    if (!slashedProtocol[relative.protocol]) {
      const keys = Object.keys(relative);
      for (let v = 0; v < keys.length; v++) {
        const k = keys[v];
        result[k] = relative[k];
      }
      result.href = result.format();
      return result;
    }

    result.protocol = relative.protocol;
    if (
      !relative.host &&
      !(relative.protocol === "file" || relative.protocol === "file:") &&
      !hostlessProtocol[relative.protocol]
    ) {
      const relPath = (relative.pathname || "").split("/");
      while (relPath.length && !(relative.host = relPath.shift()));
      relative.host ||= "";
      relative.hostname ||= "";
      if (relPath[0] !== "") relPath.unshift("");
      if (relPath.length < 2) relPath.unshift("");

      result.pathname = relPath.join("/");
    } else {
      result.pathname = relative.pathname;
    }
    result.search = relative.search;
    result.query = relative.query;
    result.host = relative.host || "";
    result.auth = relative.auth;
    result.hostname = relative.hostname || relative.host;
    result.port = relative.port;
    // to support http.request
    if (result.pathname || result.search) {
      const p = result.pathname || "";
      const s = result.search || "";
      result.path = p + s;
    }
    result.slashes = result.slashes || relative.slashes;
    result.href = result.format();
    return result;
  }

  const isSourceAbs = result.pathname && result.pathname.charAt(0) === "/";
  const isRelAbs = relative.host || (relative.pathname && relative.pathname.charAt(0) === "/");
  let mustEndAbs = isRelAbs || isSourceAbs || (result.host && relative.pathname);
  const removeAllDots = mustEndAbs;
  let srcPath = (result.pathname && result.pathname.split("/")) || [];
  const relPath = (relative.pathname && relative.pathname.split("/")) || [];
  const psychotic = result.protocol && !slashedProtocol[result.protocol];

  // if the url is a non-slashed url, then relative links like ../.. should
  // be able to crawl up to the hostname, as well. This is strange.
  // result.protocol has already been set by now. Later on, put the first
  // path part into the host field.
  if (psychotic) {
    result.hostname = "";
    result.port = null;
    if (result.host) {
      if (srcPath[0] === "") srcPath[0] = result.host;
      else srcPath.unshift(result.host);
    }
    result.host = "";
    if (relative.protocol) {
      relative.hostname = null;
      relative.port = null;
      result.auth = null;
      if (relative.host) {
        if (relPath[0] === "") {
          relPath[0] = relative.host;
        } else {
          relPath.unshift(relative.host);
        }
      }
      relative.host = null;
    }
    mustEndAbs &&= relPath[0] === "" || srcPath[0] === "";
  }

  if (isRelAbs) {
    // it's absolute.
    if (relative.host || relative.host === "") {
      if (result.host !== relative.host) result.auth = null;
      result.host = relative.host;
      result.port = relative.port;
    }
    if (relative.hostname || relative.hostname === "") {
      if (result.hostname !== relative.hostname) result.auth = null;
      result.hostname = relative.hostname;
    }
    result.search = relative.search;
    result.query = relative.query;
    srcPath = relPath;
    // fall through to the dot-handling below.
  } else if (relPath.length) {
    // it's relative. throw away the existing file, and take the new path
    // instead.
    srcPath ||= [];
    srcPath.pop();
    srcPath = srcPath.concat(relPath);
    result.search = relative.search;
    result.query = relative.query;
  } else if (relative.search != null) {
    // just pull out the search. like href='?foo'. Put this after the other
    // two cases because it simplifies the booleans
    if (psychotic) {
      result.hostname = result.host = srcPath.shift();
      // occasionally the auth can get stuck only in host. this especially
      // happens in cases like url.resolveObject('mailto:local1@domain1',
      // 'local2@domain2')
      const authInHost = result.host && result.host.indexOf("@") > 0 ? result.host.split("@") : false;
      if (authInHost) {
        result.auth = authInHost.shift();
        result.hostname = result.host = authInHost.shift();
      }
    }
    result.search = relative.search;
    result.query = relative.query;
    // to support http.request
    if (result.pathname !== null || result.search !== null) {
      result.path = (result.pathname ? result.pathname : "") + (result.search ? result.search : "");
    }
    result.href = result.format();
    return result;
  }

  if (!srcPath.length) {
    // no path at all. easy. we've already handled the other stuff above.
    result.pathname = null;
    // to support http.request
    if (result.search) {
      result.path = `/${result.search}`;
    } else {
      result.path = null;
    }
    result.href = result.format();
    return result;
  }

  // if a url ENDs in . or .., then it must get a trailing slash.
  // however, if it ends in anything else non-slashy,
  // then it must NOT get a trailing slash.
  let last = srcPath.slice(-1)[0];
  const hasTrailingSlash =
    ((result.host || relative.host || srcPath.length > 1) && (last === "." || last === "..")) || last === "";

  // strip single dots, resolve double dots to parent dir if the path tries
  // to go above the root, `up` ends up > 0
  let up = 0;
  for (let i = srcPath.length; i >= 0; i--) {
    last = srcPath[i];
    if (last === ".") {
      srcPath.splice(i, 1);
    } else if (last === "..") {
      srcPath.splice(i, 1);
      up++;
    } else if (up) {
      srcPath.splice(i, 1);
      up--;
    }
  }

  // if the path is allowed to go above the root, restore leading ..s
  if (!mustEndAbs && !removeAllDots) {
    for (; up--; up) {
      srcPath.unshift("..");
    }
  }

  if (mustEndAbs && srcPath[0] !== "" && (!srcPath[0] || srcPath[0].charAt(0) !== "/")) {
    srcPath.unshift("");
  }

  if (hasTrailingSlash && srcPath.join("/").substr(-1) !== "/") {
    srcPath.push("");
  }

  const isAbsolute = srcPath[0] === "" || (srcPath[0] && srcPath[0].charAt(0) === "/");

  // put the host back
  if (psychotic) {
    result.hostname = isAbsolute ? "" : srcPath.length ? srcPath.shift() : "";
    result.host = result.hostname;
    // occasionally the auth can get stuck only in host. this especially
    // happens in cases like url.resolveObject('mailto:local1@domain1',
    // 'local2@domain2')
    const authInHost = result.host && result.host.indexOf("@") > 0 ? result.host.split("@") : false;
    if (authInHost) {
      result.auth = authInHost.shift();
      result.hostname = result.host = authInHost.shift();
    }
  }

  mustEndAbs ||= result.host && srcPath.length;

  if (mustEndAbs && !isAbsolute) {
    srcPath.unshift("");
  }

  if (srcPath.length > 0) {
    result.pathname = srcPath.join("/");
  } else {
    result.pathname = null;
    result.path = null;
  }

  // to support request.http
  if (result.pathname !== null || result.search !== null) {
    result.path = (result.pathname ? result.pathname : "") + (result.search ? result.search : "");
  }
  result.auth = relative.auth || result.auth;
  result.slashes = result.slashes || relative.slashes;
  result.href = result.format();
  return result;
};

Url.prototype.parseHost = function parseHost() {
  let host = this.host;
  let port = portPattern.exec(host);
  if (port) {
    port = port[0];
    if (port !== ":") {
      this.port = port.slice(1);
    }
    host = host.slice(0, host.length - port.length);
  }
  if (host) this.hostname = host;
};

export function parse(url, parseQueryString, slashesDenoteHost) {
  if (url !== null && typeof url === "object" && url instanceof Url) return url;

  const urlObject = new Url();
  try {
    urlObject.parse(url, parseQueryString, slashesDenoteHost);
  } catch (e) {
    if (e !== null && typeof e === "object") {
      try {
        e.input = url;
      } catch {
        // ignore non-extensible errors
      }
    }
    throw e;
  }
  return urlObject;
}

function formatWhatwg(url, options) {
  let fragment = true;
  let unicode = false;
  let search = true;
  let auth = true;

  if (options !== undefined && options !== null) {
    if (typeof options !== "object") {
      throw invalidArgTypeError("options", "object", options);
    }
    if (options.fragment != null) fragment = Boolean(options.fragment);
    if (options.unicode != null) unicode = Boolean(options.unicode);
    if (options.search != null) search = Boolean(options.search);
    if (options.auth != null) auth = Boolean(options.auth);
  }

  const copy = new URL(url.href);
  if (!auth) {
    try {
      copy.username = "";
      copy.password = "";
    } catch {
      // URLs that cannot have credentials keep their serialization as-is
    }
  }
  if (!fragment) copy.hash = "";
  if (!search) copy.search = "";
  let href = copy.href;
  if (unicode && copy.hostname) {
    const unicodeHost = domainToUnicode(copy.hostname);
    if (unicodeHost && unicodeHost !== copy.hostname) {
      href = href.replace(copy.hostname, unicodeHost);
    }
  }
  return href;
}

export function format(urlObject, options) {
  // ensure it's an object, and not a string url. If it's an object, this is
  // a no-op. this way, you can call urlParse() on strings to clean up
  // potentially wonky urls.
  if (typeof urlObject === "string") {
    urlObject = parse(urlObject);
  } else if (typeof urlObject !== "object" || urlObject === null) {
    throw invalidArgTypeError("urlObject", "Object or string", urlObject);
  } else if (urlObject instanceof URL) {
    return formatWhatwg(urlObject, options);
  }

  if (!(urlObject instanceof Url)) {
    return Url.prototype.format.call(urlObject);
  }
  return urlObject.format();
}

export function resolveUrl(source, relative) {
  return parse(source, false, true).resolve(relative);
}

export { resolveUrl as resolve };

export function resolveObject(source, relative) {
  if (!source) return relative;
  return parse(source, false, true).resolveObject(relative);
}

// ---------------------------------------------------------------------------
// path <-> file: URL conversion (Node's lib/internal/url.js semantics)
// ---------------------------------------------------------------------------

const percentRegEx = /%/g;
const backslashRegEx = /\\/g;
const newlineRegEx = /\n/g;
const carriageReturnRegEx = /\r/g;
const tabRegEx = /\t/g;
const tildeRegEx = /~/g;

function encodePathChars(filepath) {
  if (filepath.indexOf("%") !== -1) filepath = filepath.replace(percentRegEx, "%25");
  // In posix, backslash is a valid character in paths:
  if (filepath.indexOf("\\") !== -1) filepath = filepath.replace(backslashRegEx, "%5C");
  if (filepath.indexOf("\n") !== -1) filepath = filepath.replace(newlineRegEx, "%0A");
  if (filepath.indexOf("\r") !== -1) filepath = filepath.replace(carriageReturnRegEx, "%0D");
  if (filepath.indexOf("\t") !== -1) filepath = filepath.replace(tabRegEx, "%09");
  // Bun.pathToFileURL escapes tilde even though the WHATWG URL pathname
  // setter leaves it unescaped.
  if (filepath.indexOf("~") !== -1) filepath = filepath.replace(tildeRegEx, "%7E");
  return filepath;
}

export function pathToFileURL(filepath, options = undefined) {
  validateString(filepath, "path");
  const windows = options?.windows ?? globalThis.process?.platform === "win32";
  const outURL = new URL("file://");
  if (windows && filepath.startsWith("\\\\")) {
    // UNC path format: \\server\share\resource
    const hostnameEndIndex = filepath.indexOf("\\", 2);
    if (hostnameEndIndex === -1 || hostnameEndIndex === 2) {
      const err = new TypeError(`The argument 'path' must be an absolute path. Received ${JSON.stringify(filepath)}`);
      err.code = "ERR_INVALID_ARG_VALUE";
      throw err;
    }
    outURL.hostname = toASCII(filepath.slice(2, hostnameEndIndex));
    outURL.pathname = encodePathChars(filepath.slice(hostnameEndIndex).replace(backslashRegEx, "/"));
    return outURL;
  }
  let resolved = windows ? String(filepath).replace(backslashRegEx, "/") : pathResolve(filepath);
  if (!windows) {
    // path.resolve strips trailing slashes so we must add them back
    const filePathLast = filepath.charCodeAt(filepath.length - 1);
    if (filePathLast === CHAR_FORWARD_SLASH && resolved[resolved.length - 1] !== "/") {
      resolved += "/";
    }
  }
  outURL.pathname = encodePathChars(resolved);
  return outURL;
}

function invalidFileUrlPathError(suffix) {
  const err = new TypeError(`File URL path ${suffix}`);
  err.code = "ERR_INVALID_FILE_URL_PATH";
  return err;
}

function getPathFromURLPosix(url) {
  if (url.hostname !== "") {
    const err = new TypeError(`File URL host must be "localhost" or empty on ${globalThis.process?.platform ?? "darwin"}`);
    err.code = "ERR_INVALID_FILE_URL_HOST";
    throw err;
  }
  const pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === "%") {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if (pathname[n + 1] === "2" && third === 102) {
        throw invalidFileUrlPathError("must not include encoded / characters");
      }
    }
  }
  return decodeURIComponent(pathname);
}

function getPathFromURLWin32(url) {
  const hostname = url.hostname;
  let pathname = url.pathname;
  for (let n = 0; n < pathname.length; n++) {
    if (pathname[n] === "%") {
      const third = pathname.codePointAt(n + 2) | 0x20;
      if (
        (pathname[n + 1] === "2" && third === 102) || // 2f => /
        (pathname[n + 1] === "5" && third === 99) // 5c => \
      ) {
        throw invalidFileUrlPathError("must not include encoded \\ or / characters");
      }
    }
  }
  pathname = pathname.replace(/\//g, "\\");
  pathname = decodeURIComponent(pathname);
  if (hostname !== "") {
    // If hostname is set, then we have a UNC path
    return `\\\\${toUnicode(hostname)}${pathname}`;
  }
  // Otherwise, it's a local path that requires a drive letter
  const letter = pathname.codePointAt(1) | 0x20;
  const sep = pathname[2];
  if (letter < 0x61 || letter > 0x7a || sep !== ":") {
    throw invalidFileUrlPathError("must be absolute");
  }
  return pathname.slice(1);
}

export function fileURLToPath(path, options = undefined) {
  const windows = options?.windows ?? globalThis.process?.platform === "win32";
  if (typeof path === "string") {
    path = new URL(path);
  } else if (path === null || typeof path !== "object" || typeof path.href !== "string" || typeof path.protocol !== "string") {
    throw invalidArgTypeError("path", "string or an instance of URL", path);
  } else if (!(path instanceof URL)) {
    path = new URL(path.href);
  }
  if (path.protocol !== "file:") {
    const err = new TypeError("The URL must be of scheme file");
    err.code = "ERR_INVALID_URL_SCHEME";
    throw err;
  }
  return windows ? getPathFromURLWin32(path) : getPathFromURLPosix(path);
}

export function fileURLToPathBuffer(url) {
  return Buffer.from(fileURLToPath(url));
}

// ---------------------------------------------------------------------------
// domainToASCII / domainToUnicode
// ---------------------------------------------------------------------------

// Characters that can never appear in a bare domain; their presence makes the
// input an invalid domain, for which Node (and Bun) return "".
const forbiddenDomainChars = /[\0\t\n\r #%/:<>?@[\\\]^|"{}`]/;

// A label beginning with the ACE prefix "xn--" must already be pure ASCII
// punycode; if it still contains non-ASCII characters the domain is invalid
// and Node (and Bun) return "" from domainToASCII/domainToUnicode.
function hasInvalidAcePrefixLabel(text) {
  for (const label of text.split(".")) {
    if (/^xn--/i.test(label) && /[^\x00-\x7f]/.test(label)) return true;
  }
  return false;
}

export function domainToASCII(domain) {
  if (arguments.length < 1) {
    const err = new TypeError('The "domain" argument must be specified');
    err.code = "ERR_MISSING_ARGS";
    throw err;
  }
  // Bun passes null/undefined through unchanged.
  if (domain === null || domain === undefined) return domain;
  const text = String(domain);
  if (text === "") return "";
  if (forbiddenDomainChars.test(text)) return "";
  if (hasInvalidAcePrefixLabel(text)) return "";
  try {
    return toASCII(text);
  } catch {
    return "";
  }
}

export function domainToUnicode(domain) {
  if (arguments.length < 1) {
    const err = new TypeError('The "domain" argument must be specified');
    err.code = "ERR_MISSING_ARGS";
    throw err;
  }
  // Bun passes null/undefined through unchanged.
  if (domain === null || domain === undefined) return domain;
  const text = String(domain);
  if (text === "") return "";
  if (forbiddenDomainChars.test(text)) return "";
  try {
    return toUnicode(text);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// urlToHttpOptions
// ---------------------------------------------------------------------------

export function urlToHttpOptions(url) {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const { hostname, pathname, port, username, password, search } = parsed;
  const options = {
    __proto__: null,
    ...parsed,
    protocol: parsed.protocol,
    hostname: typeof hostname === "string" && hostname.startsWith("[") ? hostname.slice(1, -1) : hostname,
    hash: parsed.hash,
    search,
    pathname,
    path: `${pathname || ""}${search || ""}`,
    href: parsed.href,
  };
  if (port !== "" && port !== null && port !== undefined) {
    options.port = Number(port);
  }
  if (username || password) {
    options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
  }
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
