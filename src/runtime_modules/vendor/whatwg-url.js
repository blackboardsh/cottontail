// WHATWG URL Standard implementation (https://url.spec.whatwg.org/).
// Self-contained URL + URLSearchParams for runtimes without native support.
import { toASCII } from "../node/punycode.js";

const SPECIAL_SCHEMES = new Map([
  ["ftp", 21],
  ["file", null],
  ["http", 80],
  ["https", 443],
  ["ws", 80],
  ["wss", 443],
]);

function defaultPort(scheme) {
  const port = SPECIAL_SCHEMES.get(scheme);
  return port === undefined ? null : port;
}

const HEX = "0123456789ABCDEF";

// Percent-encode sets, as predicates over code points.
const C0_SET = (c) => c <= 0x1f || c > 0x7e;
const FRAGMENT_SET = (c) => C0_SET(c) || c === 0x20 || c === 0x22 || c === 0x3c || c === 0x3e || c === 0x60;
const QUERY_SET = (c) => C0_SET(c) || c === 0x20 || c === 0x22 || c === 0x23 || c === 0x3c || c === 0x3e;
const SPECIAL_QUERY_SET = (c) => QUERY_SET(c) || c === 0x27;
const PATH_SET = (c) => QUERY_SET(c) || c === 0x3f || c === 0x5e || c === 0x60 || c === 0x7b || c === 0x7d;
const USERINFO_SET = (c) =>
  PATH_SET(c) || c === 0x2f || c === 0x3a || c === 0x3b || c === 0x3d || c === 0x40 || (c >= 0x5b && c <= 0x5e) || c === 0x7c;
const FORM_SET = (c) =>
  !((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2a || c === 0x2d || c === 0x2e || c === 0x5f);

function percentEncodeByte(byte) {
  return `%${HEX[byte >> 4]}${HEX[byte & 15]}`;
}

function utf8PercentEncode(input, inSet) {
  let output = "";
  for (const ch of input) {
    let cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (!inSet(cp)) {
      output += ch;
    } else if (cp < 0x80) {
      output += percentEncodeByte(cp);
    } else if (cp < 0x800) {
      output += percentEncodeByte(0xc0 | (cp >> 6)) + percentEncodeByte(0x80 | (cp & 63));
    } else if (cp < 0x10000) {
      output += percentEncodeByte(0xe0 | (cp >> 12)) + percentEncodeByte(0x80 | ((cp >> 6) & 63)) + percentEncodeByte(0x80 | (cp & 63));
    } else {
      output +=
        percentEncodeByte(0xf0 | (cp >> 18)) +
        percentEncodeByte(0x80 | ((cp >> 12) & 63)) +
        percentEncodeByte(0x80 | ((cp >> 6) & 63)) +
        percentEncodeByte(0x80 | (cp & 63));
    }
  }
  return output;
}

const HEX_DIGIT = /^[0-9A-Fa-f]$/;

function percentDecodeToBytes(input) {
  const bytes = [];
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "%" && HEX_DIGIT.test(input[i + 1] ?? "") && HEX_DIGIT.test(input[i + 2] ?? "")) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    let cp = input.codePointAt(i);
    if (cp > 0xffff) i += 1;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return bytes;
}

function utf8DecodeBytes(bytes) {
  let output = "";
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte < 0x80) {
      output += String.fromCharCode(byte);
      i += 1;
      continue;
    }
    let needed = 0;
    let cp = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (byte >= 0xc2 && byte <= 0xdf) {
      needed = 1;
      cp = byte & 0x1f;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      needed = 2;
      cp = byte & 0x0f;
      if (byte === 0xe0) lower = 0xa0;
      if (byte === 0xed) upper = 0x9f;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      needed = 3;
      cp = byte & 0x07;
      if (byte === 0xf0) lower = 0x90;
      if (byte === 0xf4) upper = 0x8f;
    } else {
      output += "�";
      i += 1;
      continue;
    }
    let ok = true;
    for (let j = 1; j <= needed; j += 1) {
      const next = bytes[i + j];
      const lo = j === 1 ? lower : 0x80;
      const hi = j === 1 ? upper : 0xbf;
      if (next === undefined || next < lo || next > hi) {
        output += "�";
        i += j;
        ok = false;
        break;
      }
      cp = (cp << 6) | (next & 63);
    }
    if (!ok) continue;
    output += String.fromCodePoint(cp);
    i += needed + 1;
  }
  return output;
}

function utf8PercentDecodeString(input) {
  return utf8DecodeBytes(percentDecodeToBytes(input));
}

// Host parsing.
const FORBIDDEN_HOST = /[\u0000\u0009\u000a\u000d\u0020#/:<>?@[\\\]^|]/;
const FORBIDDEN_DOMAIN = /[\u0000-\u001f\u007f\u0020#%/:<>?@[\\\]^|]/;

function parseIPv4Number(input) {
  if (input === "") return null;
  let radix = 10;
  if (input.length >= 2 && (input[0] === "0") && (input[1] === "x" || input[1] === "X")) {
    input = input.slice(2);
    radix = 16;
  } else if (input.length >= 2 && input[0] === "0") {
    input = input.slice(1);
    radix = 8;
  }
  if (input === "") return 0;
  const pattern = radix === 16 ? /^[0-9A-Fa-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!pattern.test(input)) return null;
  return parseInt(input, radix);
}

function endsInANumber(input) {
  const parts = input.split(".");
  if (parts[parts.length - 1] === "") {
    if (parts.length === 1) return false;
    parts.pop();
  }
  const last = parts[parts.length - 1];
  if (last !== "" && /^[0-9]+$/.test(last)) return true;
  return parseIPv4Number(last) !== null;
}

function parseIPv4(input) {
  const parts = input.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length > 4) return null;
  const numbers = [];
  for (const part of parts) {
    const value = parseIPv4Number(part);
    if (value === null) return null;
    numbers.push(value);
  }
  for (let i = 0; i < numbers.length - 1; i += 1) {
    if (numbers[i] > 255) return null;
  }
  if (numbers[numbers.length - 1] >= 256 ** (5 - numbers.length)) return null;
  let ipv4 = numbers.pop();
  for (let i = 0; i < numbers.length; i += 1) ipv4 += numbers[i] * 256 ** (3 - i);
  return ipv4;
}

function serializeIPv4(address) {
  return `${(address >>> 24) & 255}.${(address >>> 16) & 255}.${(address >>> 8) & 255}.${address & 255}`;
}

function parseIPv6(input) {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  let pieceIndex = 0;
  let compress = null;
  let pointer = 0;
  const len = input.length;
  if (input[0] === ":") {
    if (input[1] !== ":") return null;
    pointer = 2;
    pieceIndex = 1;
    compress = 1;
  }
  while (pointer < len) {
    if (pieceIndex === 8) return null;
    if (input[pointer] === ":") {
      if (compress !== null) return null;
      pointer += 1;
      pieceIndex += 1;
      compress = pieceIndex;
      continue;
    }
    let value = 0;
    let length = 0;
    while (length < 4 && HEX_DIGIT.test(input[pointer] ?? "")) {
      value = value * 16 + parseInt(input[pointer], 16);
      pointer += 1;
      length += 1;
    }
    if (input[pointer] === ".") {
      if (length === 0) return null;
      pointer -= length;
      if (pieceIndex > 6) return null;
      let numbersSeen = 0;
      while (pointer < len) {
        let ipv4Piece = null;
        if (numbersSeen > 0) {
          if (input[pointer] === "." && numbersSeen < 4) pointer += 1;
          else return null;
        }
        if (!/^[0-9]$/.test(input[pointer] ?? "")) return null;
        while (/^[0-9]$/.test(input[pointer] ?? "")) {
          const number = input.charCodeAt(pointer) - 48;
          if (ipv4Piece === null) ipv4Piece = number;
          else if (ipv4Piece === 0) return null;
          else ipv4Piece = ipv4Piece * 10 + number;
          if (ipv4Piece > 255) return null;
          pointer += 1;
        }
        address[pieceIndex] = address[pieceIndex] * 256 + ipv4Piece;
        numbersSeen += 1;
        if (numbersSeen === 2 || numbersSeen === 4) pieceIndex += 1;
      }
      if (numbersSeen !== 4) return null;
      break;
    } else if (input[pointer] === ":") {
      pointer += 1;
      if (pointer === len) return null;
    } else if (pointer < len) {
      return null;
    }
    address[pieceIndex] = value;
    pieceIndex += 1;
  }
  if (compress !== null) {
    let swaps = pieceIndex - compress;
    pieceIndex = 7;
    while (pieceIndex !== 0 && swaps > 0) {
      const temp = address[compress + swaps - 1];
      address[compress + swaps - 1] = address[pieceIndex];
      address[pieceIndex] = temp;
      pieceIndex -= 1;
      swaps -= 1;
    }
  } else if (pieceIndex !== 8) {
    return null;
  }
  return address;
}

function serializeIPv6(address) {
  let bestStart = -1;
  let bestLen = 1;
  let runStart = -1;
  for (let i = 0; i < 8; i += 1) {
    if (address[i] === 0) {
      if (runStart === -1) runStart = i;
      const runLen = i - runStart + 1;
      if (runLen > bestLen) {
        bestLen = runLen;
        bestStart = runStart;
      }
    } else {
      runStart = -1;
    }
  }
  let output = "";
  let ignore0 = false;
  for (let i = 0; i < 8; i += 1) {
    if (ignore0 && address[i] === 0) continue;
    ignore0 = false;
    if (i === bestStart) {
      output += i === 0 ? "::" : ":";
      ignore0 = true;
      continue;
    }
    output += address[i].toString(16);
    if (i !== 7) output += ":";
  }
  return output;
}

function parseOpaqueHost(input) {
  if (FORBIDDEN_HOST.test(input)) return null;
  return utf8PercentEncode(input, C0_SET);
}

function parseHost(input, isOpaque) {
  if (input[0] === "[") {
    if (!input.endsWith("]")) return null;
    const address = parseIPv6(input.slice(1, -1));
    return address === null ? null : `[${serializeIPv6(address)}]`;
  }
  if (isOpaque) return parseOpaqueHost(input);
  if (input === "") return null;
  const domain = utf8PercentDecodeString(input);
  let asciiDomain;
  if (/[^\u0000-\u007f]/.test(domain)) {
    try {
      asciiDomain = toASCII(domain.toLowerCase());
    } catch {
      return null;
    }
  } else {
    asciiDomain = domain;
  }
  asciiDomain = asciiDomain.toLowerCase();
  if (asciiDomain === "" || FORBIDDEN_DOMAIN.test(asciiDomain) || /[^\u0000-\u007f]/.test(asciiDomain)) return null;
  if (endsInANumber(asciiDomain)) {
    const ipv4 = parseIPv4(asciiDomain);
    return ipv4 === null ? null : serializeIPv4(ipv4);
  }
  return asciiDomain;
}

// URL record helpers.
function newRecord() {
  return {
    scheme: "",
    username: "",
    password: "",
    host: null,
    port: null,
    path: [],
    opaquePath: false,
    query: null,
    fragment: null,
  };
}

function cloneRecord(record) {
  const copy = { ...record };
  if (!record.opaquePath) copy.path = record.path.slice();
  return copy;
}

function includesCredentials(url) {
  return url.username !== "" || url.password !== "";
}

function cannotHaveCredentialsOrPort(url) {
  return url.host === null || url.host === "" || url.scheme === "file";
}

function isWindowsDriveLetter(input) {
  return input.length === 2 && /[A-Za-z]/.test(input[0]) && (input[1] === ":" || input[1] === "|");
}

function isNormalizedWindowsDriveLetter(input) {
  return input.length === 2 && /[A-Za-z]/.test(input[0]) && input[1] === ":";
}

function startsWithWindowsDriveLetter(chars, pointer) {
  const c0 = chars[pointer];
  const c1 = chars[pointer + 1];
  const c2 = chars[pointer + 2];
  if (c0 === undefined || c1 === undefined) return false;
  if (!/[A-Za-z]/.test(c0) || (c1 !== ":" && c1 !== "|")) return false;
  return c2 === undefined || c2 === "/" || c2 === "\\" || c2 === "?" || c2 === "#";
}

function shortenPath(url) {
  if (url.scheme === "file" && url.path.length === 1 && isNormalizedWindowsDriveLetter(url.path[0])) return;
  url.path.pop();
}

function isSingleDot(buffer) {
  const lower = buffer.toLowerCase();
  return lower === "." || lower === "%2e";
}

function isDoubleDot(buffer) {
  const lower = buffer.toLowerCase();
  return lower === ".." || lower === ".%2e" || lower === "%2e." || lower === "%2e%2e";
}

// The basic URL parser (state machine per spec). Returns the URL record or
// null on failure. When `url` is given the record is modified in place.
function basicParse(input, base = null, url = null, stateOverride = null) {
  if (url === null) {
    url = newRecord();
    input = input.replace(/^[\u0000-\u0020]+/, "").replace(/[\u0000-\u0020]+$/, "");
  }
  input = input.replace(/[\u0009\u000a\u000d]/g, "");
  const chars = Array.from(input);
  let state = stateOverride ?? "scheme-start";
  let buffer = "";
  let atSignSeen = false;
  let insideBrackets = false;
  let passwordTokenSeen = false;
  let pointer = 0;

  while (pointer <= chars.length) {
    const c = pointer < chars.length ? chars[pointer] : null;
    switch (state) {
      case "scheme-start": {
        if (c !== null && /[A-Za-z]/.test(c)) {
          buffer += c.toLowerCase();
          state = "scheme";
        } else if (!stateOverride) {
          state = "no-scheme";
          continue;
        } else {
          return null;
        }
        break;
      }
      case "scheme": {
        if (c !== null && /[A-Za-z0-9+.-]/.test(c)) {
          buffer += c.toLowerCase();
        } else if (c === ":") {
          if (stateOverride) {
            if (SPECIAL_SCHEMES.has(url.scheme) !== SPECIAL_SCHEMES.has(buffer)) return null;
            if ((includesCredentials(url) || url.port !== null) && buffer === "file") return null;
            if (url.scheme === "file" && url.host === "") return null;
          }
          url.scheme = buffer;
          if (stateOverride) {
            if (url.port === defaultPort(url.scheme)) url.port = null;
            return url;
          }
          buffer = "";
          if (url.scheme === "file") {
            state = "file";
          } else if (SPECIAL_SCHEMES.has(url.scheme) && base !== null && base.scheme === url.scheme) {
            state = "special-relative-or-authority";
          } else if (SPECIAL_SCHEMES.has(url.scheme)) {
            state = "special-authority-slashes";
          } else if (chars[pointer + 1] === "/") {
            state = "path-or-authority";
            pointer += 1;
          } else {
            url.path = "";
            url.opaquePath = true;
            state = "opaque-path";
          }
        } else if (!stateOverride) {
          buffer = "";
          state = "no-scheme";
          pointer = 0;
          continue;
        } else {
          return null;
        }
        break;
      }
      case "no-scheme": {
        if (base === null || (base.opaquePath && c !== "#")) return null;
        if (base.opaquePath && c === "#") {
          url.scheme = base.scheme;
          url.path = base.path;
          url.opaquePath = true;
          url.query = base.query;
          url.fragment = "";
          state = "fragment";
        } else if (base.scheme !== "file") {
          state = "relative";
          continue;
        } else {
          state = "file";
          continue;
        }
        break;
      }
      case "special-relative-or-authority": {
        if (c === "/" && chars[pointer + 1] === "/") {
          state = "special-authority-ignore-slashes";
          pointer += 1;
        } else {
          state = "relative";
          continue;
        }
        break;
      }
      case "path-or-authority": {
        if (c === "/") {
          state = "authority";
        } else {
          state = "path";
          continue;
        }
        break;
      }
      case "relative": {
        url.scheme = base.scheme;
        if (c === "/" || (SPECIAL_SCHEMES.has(url.scheme) && c === "\\")) {
          state = "relative-slash";
        } else {
          url.username = base.username;
          url.password = base.password;
          url.host = base.host;
          url.port = base.port;
          url.path = base.path.slice();
          url.query = base.query;
          if (c === "?") {
            url.query = "";
            state = "query";
          } else if (c === "#") {
            url.fragment = "";
            state = "fragment";
          } else if (c !== null) {
            url.query = null;
            shortenPath(url);
            state = "path";
            continue;
          }
        }
        break;
      }
      case "relative-slash": {
        if (SPECIAL_SCHEMES.has(url.scheme) && (c === "/" || c === "\\")) {
          state = "special-authority-ignore-slashes";
        } else if (c === "/") {
          state = "authority";
        } else {
          url.username = base.username;
          url.password = base.password;
          url.host = base.host;
          url.port = base.port;
          state = "path";
          continue;
        }
        break;
      }
      case "special-authority-slashes": {
        if (c === "/" && chars[pointer + 1] === "/") {
          state = "special-authority-ignore-slashes";
          pointer += 1;
        } else {
          state = "special-authority-ignore-slashes";
          continue;
        }
        break;
      }
      case "special-authority-ignore-slashes": {
        if (c !== "/" && c !== "\\") {
          state = "authority";
          continue;
        }
        break;
      }
      case "authority": {
        if (c === "@") {
          if (atSignSeen) buffer = `%40${buffer}`;
          atSignSeen = true;
          for (const cp of buffer) {
            if (cp === ":" && !passwordTokenSeen) {
              passwordTokenSeen = true;
              continue;
            }
            const encoded = utf8PercentEncode(cp, USERINFO_SET);
            if (passwordTokenSeen) url.password += encoded;
            else url.username += encoded;
          }
          buffer = "";
        } else if (c === null || c === "/" || c === "?" || c === "#" || (SPECIAL_SCHEMES.has(url.scheme) && c === "\\")) {
          if (atSignSeen && buffer === "") return null;
          pointer -= Array.from(buffer).length + 1;
          buffer = "";
          state = "host";
        } else {
          buffer += c;
        }
        break;
      }
      case "host":
      case "hostname": {
        if (stateOverride && url.scheme === "file") {
          state = "file-host";
          continue;
        }
        if (c === ":" && !insideBrackets) {
          if (buffer === "") return null;
          if (stateOverride === "hostname") return url;
          const host = parseHost(buffer, !SPECIAL_SCHEMES.has(url.scheme));
          if (host === null) return null;
          url.host = host;
          buffer = "";
          state = "port";
        } else if (c === null || c === "/" || c === "?" || c === "#" || (SPECIAL_SCHEMES.has(url.scheme) && c === "\\")) {
          if (SPECIAL_SCHEMES.has(url.scheme) && buffer === "") return null;
          if (stateOverride && buffer === "" && (includesCredentials(url) || url.port !== null)) return url;
          const host = parseHost(buffer, !SPECIAL_SCHEMES.has(url.scheme));
          if (host === null) return null;
          url.host = host;
          buffer = "";
          if (stateOverride) return url;
          state = "path-start";
          continue;
        } else {
          if (c === "[") insideBrackets = true;
          else if (c === "]") insideBrackets = false;
          buffer += c;
        }
        break;
      }
      case "port": {
        if (c !== null && /[0-9]/.test(c)) {
          buffer += c;
        } else if (
          c === null ||
          c === "/" ||
          c === "?" ||
          c === "#" ||
          (SPECIAL_SCHEMES.has(url.scheme) && c === "\\") ||
          stateOverride
        ) {
          if (buffer !== "") {
            const port = parseInt(buffer, 10);
            if (port > 65535) return null;
            url.port = port === defaultPort(url.scheme) ? null : port;
            buffer = "";
          }
          if (stateOverride) return url;
          state = "path-start";
          continue;
        } else {
          return null;
        }
        break;
      }
      case "file": {
        url.scheme = "file";
        url.host = "";
        if (c === "/" || c === "\\") {
          state = "file-slash";
        } else if (base !== null && base.scheme === "file") {
          url.host = base.host;
          url.path = base.path.slice();
          url.query = base.query;
          if (c === "?") {
            url.query = "";
            state = "query";
          } else if (c === "#") {
            url.fragment = "";
            state = "fragment";
          } else if (c !== null) {
            url.query = null;
            if (!startsWithWindowsDriveLetter(chars, pointer)) shortenPath(url);
            else url.path = [];
            state = "path";
            continue;
          }
        } else {
          state = "path";
          continue;
        }
        break;
      }
      case "file-slash": {
        if (c === "/" || c === "\\") {
          state = "file-host";
        } else {
          if (base !== null && base.scheme === "file") {
            url.host = base.host;
            if (!startsWithWindowsDriveLetter(chars, pointer) && isNormalizedWindowsDriveLetter(base.path[0] ?? "")) {
              url.path.push(base.path[0]);
            }
          }
          state = "path";
          continue;
        }
        break;
      }
      case "file-host": {
        if (c === null || c === "/" || c === "\\" || c === "?" || c === "#") {
          if (!stateOverride && isWindowsDriveLetter(buffer)) {
            state = "path";
            continue;
          }
          if (buffer === "") {
            url.host = "";
            if (stateOverride) return url;
            state = "path-start";
            continue;
          }
          let host = parseHost(buffer, !SPECIAL_SCHEMES.has(url.scheme));
          if (host === null) return null;
          if (host === "localhost") host = "";
          url.host = host;
          if (stateOverride) return url;
          buffer = "";
          state = "path-start";
          continue;
        }
        buffer += c;
        break;
      }
      case "path-start": {
        if (SPECIAL_SCHEMES.has(url.scheme)) {
          state = "path";
          if (c !== "/" && c !== "\\") continue;
        } else if (!stateOverride && c === "?") {
          url.query = "";
          state = "query";
        } else if (!stateOverride && c === "#") {
          url.fragment = "";
          state = "fragment";
        } else if (c !== null) {
          state = "path";
          if (c !== "/") continue;
        } else if (stateOverride && url.host === null) {
          url.path.push("");
        }
        break;
      }
      case "path": {
        const special = SPECIAL_SCHEMES.has(url.scheme);
        if (c === null || c === "/" || (special && c === "\\") || (!stateOverride && (c === "?" || c === "#"))) {
          if (isDoubleDot(buffer)) {
            shortenPath(url);
            if (c !== "/" && !(special && c === "\\")) url.path.push("");
          } else if (isSingleDot(buffer)) {
            if (c !== "/" && !(special && c === "\\")) url.path.push("");
          } else {
            if (url.scheme === "file" && url.path.length === 0 && isWindowsDriveLetter(buffer)) {
              buffer = `${buffer[0]}:`;
            }
            url.path.push(buffer);
          }
          buffer = "";
          if (c === "?") {
            url.query = "";
            state = "query";
          } else if (c === "#") {
            url.fragment = "";
            state = "fragment";
          }
        } else {
          buffer += utf8PercentEncode(c, PATH_SET);
        }
        break;
      }
      case "opaque-path": {
        if (c === "?") {
          url.query = "";
          state = "query";
        } else if (c === "#") {
          url.fragment = "";
          state = "fragment";
        } else if (c !== null) {
          url.path += utf8PercentEncode(c, C0_SET);
        }
        break;
      }
      case "query": {
        if ((c === "#" && !stateOverride) || c === null) {
          url.query += utf8PercentEncode(buffer, SPECIAL_SCHEMES.has(url.scheme) ? SPECIAL_QUERY_SET : QUERY_SET);
          buffer = "";
          if (c === "#") {
            url.fragment = "";
            state = "fragment";
          }
        } else {
          buffer += c;
        }
        break;
      }
      case "fragment": {
        if (c === null) {
          url.fragment += utf8PercentEncode(buffer, FRAGMENT_SET);
          buffer = "";
        } else {
          buffer += c;
        }
        break;
      }
    }
    pointer += 1;
  }
  return url;
}

function serializePath(url) {
  if (url.opaquePath) return url.path;
  let output = "";
  for (const segment of url.path) output += `/${segment}`;
  return output;
}

function serializeURL(url, excludeFragment = false) {
  let output = `${url.scheme}:`;
  if (url.host !== null) {
    output += "//";
    if (includesCredentials(url)) {
      output += url.username;
      if (url.password !== "") output += `:${url.password}`;
      output += "@";
    }
    output += url.host;
    if (url.port !== null) output += `:${url.port}`;
  }
  if (url.host === null && !url.opaquePath && url.path.length > 1 && url.path[0] === "") output += "/.";
  output += serializePath(url);
  if (url.query !== null) output += `?${url.query}`;
  if (!excludeFragment && url.fragment !== null) output += `#${url.fragment}`;
  return output;
}

// application/x-www-form-urlencoded parsing/serialization.
function parseFormUrlencoded(input) {
  const list = [];
  for (const sequence of input.split("&")) {
    if (sequence === "") continue;
    const eq = sequence.indexOf("=");
    const name = eq === -1 ? sequence : sequence.slice(0, eq);
    const value = eq === -1 ? "" : sequence.slice(eq + 1);
    list.push([utf8PercentDecodeString(name.replace(/\+/g, " ")), utf8PercentDecodeString(value.replace(/\+/g, " "))]);
  }
  return list;
}

function serializeFormUrlencodedComponent(input) {
  let output = "";
  for (let i = 0; i < input.length; i += 1) {
    if (input[i] === " ") {
      output += "+";
      continue;
    }
    let cp = input.codePointAt(i);
    if (cp > 0xffff) i += 1;
    if (!FORM_SET(cp)) output += String.fromCodePoint(cp);
    else output += utf8PercentEncode(String.fromCodePoint(cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp), FORM_SET);
  }
  return output;
}

function serializeFormUrlencoded(list) {
  let output = "";
  for (const [name, value] of list) {
    if (output !== "") output += "&";
    output += `${serializeFormUrlencodedComponent(name)}=${serializeFormUrlencodedComponent(value)}`;
  }
  return output;
}

// Internal state, kept off the instances.
const urlRecord = new WeakMap();
const urlQueryObject = new WeakMap();
const paramsList = new WeakMap();
const paramsUrl = new WeakMap();

function recordOf(url) {
  const record = urlRecord.get(url);
  if (!record) throw new TypeError("Receiver is not a URL");
  return record;
}

function listOf(params) {
  const list = paramsList.get(params);
  if (!list) throw new TypeError("Receiver is not a URLSearchParams");
  return list;
}

function updateBoundURL(params) {
  const boundUrl = paramsUrl.get(params);
  if (!boundUrl) return;
  const record = urlRecord.get(boundUrl);
  const serialized = serializeFormUrlencoded(paramsList.get(params));
  record.query = serialized === "" ? null : serialized;
}

function syncQueryObject(url, record) {
  const params = urlQueryObject.get(url);
  if (params) paramsList.set(params, parseFormUrlencoded(record.query ?? ""));
}

export class URLSearchParams {
  constructor(init = "") {
    const list = [];
    paramsList.set(this, list);
    if (init === undefined || init === null) return;
    if (typeof init === "object" || typeof init === "function") {
      if (typeof init[Symbol.iterator] === "function") {
        for (const pair of init) {
          const entry = Array.from(pair);
          if (entry.length !== 2) {
            throw new TypeError("URLSearchParams: iterable initializer entries must be [name, value] pairs");
          }
          list.push([String(entry[0]), String(entry[1])]);
        }
      } else {
        for (const key of Object.keys(init)) list.push([String(key), String(init[key])]);
      }
      return;
    }
    let text = String(init);
    if (text[0] === "?") text = text.slice(1);
    for (const pair of parseFormUrlencoded(text)) list.push(pair);
  }

  append(name, value) {
    listOf(this).push([String(name), String(value)]);
    updateBoundURL(this);
  }

  delete(name, value = undefined) {
    const list = listOf(this);
    name = String(name);
    const matchValue = value !== undefined ? String(value) : undefined;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i][0] === name && (matchValue === undefined || list[i][1] === matchValue)) list.splice(i, 1);
    }
    updateBoundURL(this);
  }

  get(name) {
    name = String(name);
    for (const [key, value] of listOf(this)) {
      if (key === name) return value;
    }
    return null;
  }

  getAll(name) {
    name = String(name);
    const output = [];
    for (const [key, value] of listOf(this)) {
      if (key === name) output.push(value);
    }
    return output;
  }

  has(name, value = undefined) {
    const list = listOf(this);
    name = String(name);
    const matchValue = value !== undefined ? String(value) : undefined;
    return list.some(([key, entryValue]) => key === name && (matchValue === undefined || entryValue === matchValue));
  }

  set(name, value) {
    const list = listOf(this);
    name = String(name);
    value = String(value);
    let replaced = false;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i][0] !== name) continue;
      if (replaced) {
        list.splice(i, 1);
        i -= 1;
      } else {
        list[i][1] = value;
        replaced = true;
      }
    }
    if (!replaced) list.push([name, value]);
    updateBoundURL(this);
  }

  sort() {
    const list = listOf(this);
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    updateBoundURL(this);
  }

  forEach(callback, thisArg = undefined) {
    const list = listOf(this);
    for (let i = 0; i < list.length; i += 1) {
      callback.call(thisArg, list[i][1], list[i][0], this);
    }
  }

  get size() {
    return listOf(this).length;
  }

  *entries() {
    for (const [name, value] of listOf(this).slice()) yield [name, value];
  }

  *keys() {
    for (const [name] of listOf(this).slice()) yield name;
  }

  *values() {
    for (const [, value] of listOf(this).slice()) yield value;
  }

  toString() {
    return serializeFormUrlencoded(listOf(this));
  }
}

URLSearchParams.prototype[Symbol.iterator] = URLSearchParams.prototype.entries;
Object.defineProperty(URLSearchParams.prototype, Symbol.toStringTag, { value: "URLSearchParams", configurable: true });

export class URL {
  constructor(input, base = undefined) {
    let parsedBase = null;
    if (base !== undefined && base !== null) {
      parsedBase = base instanceof URL ? cloneRecord(urlRecord.get(base)) : basicParse(String(base));
      if (parsedBase === null) throw new TypeError(`Invalid base URL: ${String(base)}`);
    }
    const record = input instanceof URL && parsedBase === null ? cloneRecord(urlRecord.get(input)) : basicParse(String(input), parsedBase);
    if (record === null) throw new TypeError(`Invalid URL: ${String(input)}`);
    urlRecord.set(this, record);
  }

  static parse(input, base = undefined) {
    try {
      return new URL(input, base);
    } catch {
      return null;
    }
  }

  static canParse(input, base = undefined) {
    try {
      // eslint-disable-next-line no-new
      new URL(input, base);
      return true;
    } catch {
      return false;
    }
  }

  get href() {
    return serializeURL(recordOf(this));
  }

  set href(value) {
    const record = basicParse(String(value));
    if (record === null) throw new TypeError(`Invalid URL: ${String(value)}`);
    urlRecord.set(this, record);
    syncQueryObject(this, record);
  }

  get origin() {
    const record = recordOf(this);
    if (record.scheme === "blob" && record.opaquePath) {
      const inner = URL.parse(record.path);
      return inner === null ? "null" : inner.origin;
    }
    if (SPECIAL_SCHEMES.has(record.scheme) && record.scheme !== "file") {
      return `${record.scheme}://${record.host}${record.port !== null ? `:${record.port}` : ""}`;
    }
    return "null";
  }

  get protocol() {
    return `${recordOf(this).scheme}:`;
  }

  set protocol(value) {
    basicParse(`${String(value)}:`, null, recordOf(this), "scheme-start");
  }

  get username() {
    return recordOf(this).username;
  }

  set username(value) {
    const record = recordOf(this);
    if (cannotHaveCredentialsOrPort(record)) return;
    record.username = utf8PercentEncode(String(value), USERINFO_SET);
  }

  get password() {
    return recordOf(this).password;
  }

  set password(value) {
    const record = recordOf(this);
    if (cannotHaveCredentialsOrPort(record)) return;
    record.password = utf8PercentEncode(String(value), USERINFO_SET);
  }

  get host() {
    const record = recordOf(this);
    if (record.host === null) return "";
    return record.port === null ? record.host : `${record.host}:${record.port}`;
  }

  set host(value) {
    const record = recordOf(this);
    if (record.opaquePath) return;
    basicParse(String(value), null, record, "host");
  }

  get hostname() {
    return recordOf(this).host ?? "";
  }

  set hostname(value) {
    const record = recordOf(this);
    if (record.opaquePath) return;
    basicParse(String(value), null, record, "hostname");
  }

  get port() {
    const record = recordOf(this);
    return record.port === null ? "" : String(record.port);
  }

  set port(value) {
    const record = recordOf(this);
    if (cannotHaveCredentialsOrPort(record)) return;
    const text = String(value);
    if (text === "") record.port = null;
    else basicParse(text, null, record, "port");
  }

  get pathname() {
    return serializePath(recordOf(this));
  }

  set pathname(value) {
    const record = recordOf(this);
    if (record.opaquePath) return;
    record.path = [];
    basicParse(String(value), null, record, "path-start");
  }

  get search() {
    const record = recordOf(this);
    return record.query === null || record.query === "" ? "" : `?${record.query}`;
  }

  set search(value) {
    const record = recordOf(this);
    const text = String(value);
    if (text === "") {
      record.query = null;
    } else {
      record.query = "";
      basicParse(text[0] === "?" ? text.slice(1) : text, null, record, "query");
    }
    syncQueryObject(this, record);
  }

  get searchParams() {
    let params = urlQueryObject.get(this);
    if (!params) {
      params = new URLSearchParams(recordOf(this).query ?? "");
      paramsUrl.set(params, this);
      urlQueryObject.set(this, params);
    }
    return params;
  }

  get hash() {
    const record = recordOf(this);
    return record.fragment === null || record.fragment === "" ? "" : `#${record.fragment}`;
  }

  set hash(value) {
    const record = recordOf(this);
    const text = String(value);
    if (text === "") {
      record.fragment = null;
      return;
    }
    record.fragment = "";
    basicParse(text[0] === "#" ? text.slice(1) : text, null, record, "fragment");
  }

  toString() {
    return serializeURL(recordOf(this));
  }

  toJSON() {
    return serializeURL(recordOf(this));
  }
}

Object.defineProperty(URL.prototype, Symbol.toStringTag, { value: "URL", configurable: true });
