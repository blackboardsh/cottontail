export function createCookieRuntime(nodeInspect) {
  function normalizeCookieText(value) {
    const text = String(value ?? "");
    let output = "";
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          output += text[index] + text[index + 1];
          index += 1;
        } else {
          output += "\ufffd";
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        output += "\ufffd";
      } else {
        output += text[index];
      }
    }
    return output;
  }
  
  function encodeCookieText(value) {
    return encodeURIComponent(normalizeCookieText(value));
  }
  
  function decodeCookieText(value) {
    try {
      return decodeURIComponent(String(value));
    } catch {
      return String(value).replace(/%(?![0-9a-fA-F]{2})/g, "\ufffd");
    }
  }
  
  function isInvalidCookieName(value) {
    const text = String(value);
    return text.length === 0 || /[\x00-\x20\x7f;=]/.test(text) || /[^\x00-\x7f]/.test(text);
  }
  
  // Set-Cookie values must be ASCII and must not contain characters that would
  // allow header splitting / cookie injection (NUL, CR, LF).
  function isInvalidCookieValue(value) {
    return /[\x00\r\n]|[^\x00-\x7f]/.test(String(value));
  }
  
  // Attribute names in a Set-Cookie string must be ASCII without control
  // characters; unknown-but-well-formed attributes are ignored by the parser.
  function isInvalidCookieAttributeName(value) {
    return /[\x00-\x08\x0a-\x1f\x7f]|[^\x00-\x7f]/.test(String(value));
  }
  
  function isInvalidCookieDomain(value) {
    return /[^A-Za-z0-9.-]/.test(String(value));
  }
  
  function isInvalidCookiePath(value) {
    return /[\x00-\x1f\x7f;]/.test(String(value));
  }
  
  class Cookie {
    constructor(name, value = undefined, options = {}) {
      if (name && typeof name === "object" && !(name instanceof String)) {
        options = name;
        name = options.name;
        value = options.value;
      }
      // `new Bun.Cookie("a=b; Path=/")` parses the cookie string form.
      if (value === undefined && typeof name === "string" && name.includes("=")) {
        return Cookie.parse(name);
      }
      const initialName = String(name);
      if (isInvalidCookieName(initialName)) throw new TypeError("Invalid cookie name: contains invalid characters");
      this._name = initialName;
      this._value = "";
      this.value = value ?? "";
      this._path = "/";
      this._domain = null;
      this.path = options.path == null ? "/" : String(options.path);
      this.domain = options.domain == null || options.domain === "" ? null : String(options.domain);
      this.secure = Boolean(options.secure);
      this.httpOnly = Boolean(options.httpOnly);
      this.partitioned = Boolean(options.partitioned);
      this.sameSite = String(options.sameSite ?? "lax");
      if (!["strict", "lax", "none"].includes(this.sameSite)) {
        throw new TypeError("Invalid sameSite value. Must be 'strict', 'lax', or 'none'");
      }
      if (options.maxAge != null) this.maxAge = Number(options.maxAge);
      const expires = normalizeCookieExpires(options.expires);
      if (expires !== undefined) this.expires = expires;
    }
    static parse(text) {
      const parts = String(text).split(";");
      const first = parts.shift() ?? "";
      const eq = first.indexOf("=");
      const name = eq >= 0 ? first.slice(0, eq) : first;
      const value = eq >= 0 ? first.slice(eq + 1) : "";
      if (isInvalidCookieValue(value)) {
        throw new TypeError("Invalid cookie value: contains invalid characters");
      }
      const options = {};
      for (const raw of parts) {
        const part = raw.trim();
        if (!part) continue;
        const attrEq = part.indexOf("=");
        const key = (attrEq >= 0 ? part.slice(0, attrEq) : part).trim().toLowerCase();
        if (isInvalidCookieAttributeName(key)) {
          throw new TypeError("Invalid cookie attribute name: contains invalid characters");
        }
        const attrValue = attrEq >= 0 ? part.slice(attrEq + 1).trim().replace(/^"|"$/g, "") : "";
        if (key === "domain") options.domain = attrValue;
        else if (key === "path") options.path = attrValue;
        else if (key === "max-age") options.maxAge = Number(attrValue);
        else if (key === "expires") options.expires = new Date(attrValue);
        else if (key === "secure") options.secure = true;
        else if (key === "httponly") options.httpOnly = true;
        else if (key === "partitioned") options.partitioned = true;
        else if (key === "samesite") options.sameSite = attrValue.toLowerCase();
      }
      return new Cookie(name.trim(), decodeCookieText(value.trim()), options);
    }
    static from(name, value = undefined, options = {}) {
      if (name instanceof Cookie) return name;
      if (value === undefined && typeof name === "string" && String(name).includes("=")) return Cookie.parse(name);
      return new Cookie(name, value, options);
    }
    isExpired() {
      if (this.maxAge != null) return Number(this.maxAge) <= 0;
      return this.expires instanceof Date && this.expires.getTime() <= Date.now();
    }
    serialize() {
      const parts = [`${this.name}=${encodeCookieText(this.value)}`];
      if (this.domain) parts.push(`Domain=${this.domain}`);
      if (this.path != null) parts.push(`Path=${this.path}`);
      if (this.expires instanceof Date) parts.push(`Expires=${formatCookieDate(this.expires)}`);
      if (this.maxAge != null) parts.push(`Max-Age=${Math.trunc(Number(this.maxAge))}`);
      if (this.secure) parts.push("Secure");
      if (this.httpOnly) parts.push("HttpOnly");
      if (this.partitioned) parts.push("Partitioned");
      if (this.sameSite) parts.push(`SameSite=${this.sameSite[0].toUpperCase()}${this.sameSite.slice(1).toLowerCase()}`);
      return parts.join("; ");
    }
    toString() {
      return this.serialize();
    }
    get value() {
      return this._value;
    }
    set value(next) {
      this._value = normalizeCookieText(next);
    }
    get name() {
      return this._name;
    }
    set name(_next) {
    }
    get domain() {
      return this._domain;
    }
    set domain(next) {
      if (next == null || next === "") {
        this._domain = null;
        return;
      }
      const value = String(next);
      if (isInvalidCookieDomain(value)) throw new TypeError("Invalid cookie domain: contains invalid characters");
      this._domain = value;
    }
    get path() {
      return this._path;
    }
    set path(next) {
      if (next === "") {
        this._path = null;
        return;
      }
      const value = next == null ? "/" : String(next);
      if (isInvalidCookiePath(value)) throw new TypeError("Invalid cookie path: contains invalid characters");
      this._path = value;
    }
    toJSON() {
      const result = {
        name: this.name,
        value: this.value,
        domain: this.domain,
        path: this.path,
        secure: this.secure,
        sameSite: this.sameSite,
        httpOnly: this.httpOnly,
        partitioned: this.partitioned,
      };
      if (this.expires !== undefined) result.expires = this.expires;
      if (this.maxAge !== undefined) result.maxAge = this.maxAge;
      return result;
    }
  }
  
  function normalizeCookieExpires(value) {
    if (value == null) return undefined;
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) throw new TypeError("expires must be a valid Date (or Number)");
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("expires must be a valid Number");
      return new Date(value * 1000);
    }
    if (typeof value === "string") {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new TypeError("Invalid cookie expiration date");
      return date;
    }
    throw new TypeError(`The argument 'expires' Invalid expires value. Must be a Date or a number. Received ${nodeInspect(value)}`);
  }
  
  function formatCookieDate(date) {
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const day = days[(date.getUTCDay() + 1) % 7];
    const dd = String(date.getUTCDate());
    const hh = String(date.getUTCHours()).padStart(2, "0");
    const mm = String(date.getUTCMinutes()).padStart(2, "0");
    const ss = String(date.getUTCSeconds()).padStart(2, "0");
    return `${day}, ${dd} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${hh}:${mm}:${ss} -0000`;
  }
  
  class CookieMap extends Map {
    constructor(init = undefined, options = undefined) {
      super();
      this._changes = [];
      this._initialKeys = [];
      this._dynamicKeys = [];
      const preserveFirst = Boolean(options?.preserveFirst);
      if (typeof init === "string") {
        const parts = init.split(";");
        for (let index = 0; index < parts.length; index += 1) {
          const raw = index === 0 ? parts[index].trimEnd() : parts[index].trim();
          const eq = raw.indexOf("=");
          if (eq < 0) continue;
          const name = eq >= 0 ? raw.slice(0, eq).trimEnd() : raw.trimEnd();
          const value = eq >= 0 ? raw.slice(eq + 1).trim() : "";
          if (!name) continue;
          if (preserveFirst && Map.prototype.has.call(this, name)) continue;
          if (!Map.prototype.has.call(this, name)) this._initialKeys.push(name);
          Map.prototype.set.call(this, name, decodeCookieText(value));
        }
      } else if (Array.isArray(init) || (init && typeof init[Symbol.iterator] === "function")) {
        for (const pair of init) {
          if (!Array.isArray(pair) || pair.length !== 2) {
            throw new TypeError("Expected arrays of exactly two strings");
          }
          const [key, value] = pair;
          const name = String(key);
          if (!Map.prototype.has.call(this, name)) this._initialKeys.push(name);
          if (!preserveFirst || !Map.prototype.has.call(this, name)) {
            Map.prototype.set.call(this, name, String(value));
          }
        }
      } else if (init && typeof init === "object") {
        for (const [key, value] of Object.entries(init)) {
          Map.prototype.set.call(this, key, String(value));
          this._initialKeys.push(key);
        }
      }
    }
    set(name, value = undefined, options = {}) {
      const cookie = name instanceof Cookie ? name : new Cookie(name, value, options);
      if (!this._dynamicKeys.includes(cookie.name)) this._dynamicKeys.push(cookie.name);
      Map.prototype.set.call(this, cookie.name, cookie);
      this._changes = this._changes.filter((item) =>
        item.name !== cookie.name ||
        item.domain !== cookie.domain ||
        item.path !== cookie.path
      );
      this._changes.push(cookie);
      return this;
    }
    get(name) {
      if (!super.has(name)) return null;
      const value = super.get(name);
      return value instanceof Cookie ? value.value : value;
    }
    delete(name, options = {}) {
      let cookie;
      if (name instanceof Cookie) {
        cookie = new Cookie(name.name, "", {
          domain: name.domain,
          path: name.path,
          secure: name.secure,
          httpOnly: name.httpOnly,
          partitioned: name.partitioned,
          sameSite: name.sameSite,
          expires: 0,
        });
      } else if (name && typeof name === "object") {
        if (name.name == null) throw new TypeError("Cookie name is required");
        cookie = new Cookie({
          ...name,
          value: "",
          expires: 0,
        });
      } else {
        cookie = new Cookie(name, "", { ...options, expires: 0 });
      }
      const existed = super.delete(cookie.name);
      const dynamicIndex = this._dynamicKeys.indexOf(cookie.name);
      if (dynamicIndex >= 0) this._dynamicKeys.splice(dynamicIndex, 1);
      this._changes = this._changes.filter((item) =>
        item.name !== cookie.name ||
        item.domain !== cookie.domain ||
        item.path !== cookie.path
      );
      this._changes.push(cookie);
      return existed;
    }
    toSetCookieHeaders() {
      return this._changes.map((cookie) => cookie.serialize());
    }
    toString() {
      return [...this].map(([key, value]) => `${key}=${value}`).join("; ");
    }
    toJSON() {
      return Object.fromEntries(this);
    }
    *keys() {
      const yielded = new Set();
      if (this._dynamicKeys.length > 0) {
        for (let index = 0; index < this._dynamicKeys.length; index += 1) {
          const key = this._dynamicKeys[index];
          if (!super.has(key)) continue;
          yielded.add(key);
          yield key;
        }
        const initialKeys = [...this._initialKeys].reverse();
        for (const key of initialKeys) {
          if (yielded.has(key) || !super.has(key)) continue;
          yield key;
        }
        return;
      }
      const initialKeys = [...this._initialKeys];
      for (const key of initialKeys) {
        if (!super.has(key)) continue;
        yield key;
      }
    }
    *entries() {
      for (const key of this.keys()) {
        const value = Map.prototype.get.call(this, key);
        yield [key, value instanceof Cookie ? value.value : value];
      }
    }
    *values() {
      for (const [, value] of this.entries()) yield value;
    }
    [Symbol.iterator]() {
      return this.entries();
    }
    forEach(callback, thisArg = undefined) {
      for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    }
  }
  
    return { Cookie, CookieMap };
}

