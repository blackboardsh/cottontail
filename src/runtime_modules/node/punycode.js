const base = 36;
const tMin = 1;
const tMax = 26;
const skew = 38;
const damp = 700;
const initialBias = 72;
const initialN = 128;
const delimiter = "-";

function ucs2decode(string) {
  const output = [];
  for (let counter = 0; counter < string.length; counter += 1) {
    const value = string.charCodeAt(counter);
    if (value >= 0xd800 && value <= 0xdbff && counter + 1 < string.length) {
      const extra = string.charCodeAt(counter + 1);
      if ((extra & 0xfc00) === 0xdc00) {
        output.push(((value & 0x3ff) << 10) + (extra & 0x3ff) + 0x10000);
        counter += 1;
        continue;
      }
    }
    output.push(value);
  }
  return output;
}

function ucs2encode(array) {
  return array.map((value) => {
    if (value > 0xffff) {
      const next = value - 0x10000;
      return String.fromCharCode((next >>> 10) + 0xd800, (next & 0x3ff) + 0xdc00);
    }
    return String.fromCharCode(value);
  }).join("");
}

function basicToDigit(codePoint) {
  if (codePoint >= 0x30 && codePoint < 0x3a) return 26 + (codePoint - 0x30);
  if (codePoint >= 0x41 && codePoint < 0x5b) return codePoint - 0x41;
  if (codePoint >= 0x61 && codePoint < 0x7b) return codePoint - 0x61;
  return base;
}

function digitToBasic(digit) {
  return digit + 22 + 75 * (digit < 26);
}

function adapt(delta, numPoints, firstTime) {
  let nextDelta = firstTime ? Math.floor(delta / damp) : delta >> 1;
  nextDelta += Math.floor(nextDelta / numPoints);
  let k = 0;
  while (nextDelta > (((base - tMin) * tMax) >> 1)) {
    nextDelta = Math.floor(nextDelta / (base - tMin));
    k += base;
  }
  return k + Math.floor(((base - tMin + 1) * nextDelta) / (nextDelta + skew));
}

export function decode(input) {
  const text = String(input);
  const output = [];
  const basic = text.lastIndexOf(delimiter);
  let index = 0;
  if (basic >= 0) {
    for (let j = 0; j < basic; j += 1) output.push(text.charCodeAt(j));
    index = basic + 1;
  }
  let n = initialN;
  let i = 0;
  let bias = initialBias;
  while (index < text.length) {
    const oldi = i;
    let w = 1;
    for (let k = base; ; k += base) {
      if (index >= text.length) throw new RangeError("Invalid punycode input");
      const digit = basicToDigit(text.charCodeAt(index++));
      if (digit >= base) throw new RangeError("Invalid punycode input");
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    const out = output.length + 1;
    bias = adapt(i - oldi, out, oldi === 0);
    n += Math.floor(i / out);
    i %= out;
    output.splice(i, 0, n);
    i += 1;
  }
  return ucs2encode(output);
}

export function encode(input) {
  const codePoints = ucs2decode(String(input));
  let n = initialN;
  let delta = 0;
  let bias = initialBias;
  const output = [];
  for (const current of codePoints) {
    if (current < 0x80) output.push(String.fromCharCode(current));
  }
  const basicLength = output.length;
  let handled = basicLength;
  if (basicLength > 0) output.push(delimiter);
  while (handled < codePoints.length) {
    let m = Infinity;
    for (const current of codePoints) {
      if (current >= n && current < m) m = current;
    }
    delta += (m - n) * (handled + 1);
    n = m;
    for (const current of codePoints) {
      if (current < n) {
        delta += 1;
      } else if (current === n) {
        let q = delta;
        for (let k = base; ; k += base) {
          const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
          if (q < t) break;
          output.push(String.fromCharCode(digitToBasic(t + ((q - t) % (base - t)))));
          q = Math.floor((q - t) / (base - t));
        }
        output.push(String.fromCharCode(digitToBasic(q)));
        bias = adapt(delta, handled + 1, handled === basicLength);
        delta = 0;
        handled += 1;
      }
    }
    delta += 1;
    n += 1;
  }
  return output.join("");
}

function mapDomain(domain, fn) {
  return String(domain).split(".").map(fn).join(".");
}

export function toASCII(domain) {
  return mapDomain(domain, (label) => /[^\0-\x7E]/.test(label) ? `xn--${encode(label)}` : label);
}

export function toUnicode(domain) {
  return mapDomain(domain, (label) => label.toLowerCase().startsWith("xn--") ? decode(label.slice(4)) : label);
}

export const ucs2 = { decode: ucs2decode, encode: ucs2encode };
export const version = "2.1.0";

export default { decode, encode, toASCII, toUnicode, ucs2, version };
