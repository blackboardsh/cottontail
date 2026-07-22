// Copyright 2013 the V8 project authors. All rights reserved.
// Copyright (C) 2005, 2006, 2007, 2008, 2009 Apple Inc. All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
// 1. Redistributions of source code must retain the above copyright notice,
//    this list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright
//    notice, this list of conditions and the following disclaimer in the
//    documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY APPLE INC. AND ITS CONTRIBUTORS "AS IS" AND ANY
// EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL APPLE INC. OR ITS CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
// DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
// SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
// CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
// OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//
// Ported from Bun's WebKit JSDateMath-v8.cpp, which is derived from V8's date
// parser. This remains in Cottontail's runtime so the vendored JSC stays stock.

const END = Object.freeze({ kind: "end", length: 0, value: 0 });
const INVALID = Object.freeze({ kind: "invalid", length: 0, value: 0 });
const UNKNOWN = Object.freeze({ kind: "unknown", length: 1, value: 0 });
const NONE = null;

const MONTHS = new Map([
  ["jan", 1], ["feb", 2], ["mar", 3], ["apr", 4],
  ["may", 5], ["jun", 6], ["jul", 7], ["aug", 8],
  ["sep", 9], ["oct", 10], ["nov", 11], ["dec", 12],
]);

const KEYWORDS = new Map([
  ["am", ["ampm", 0]],
  ["pm", ["ampm", 12]],
  ["ut", ["timezone", 0]],
  ["utc", ["timezone", 0]],
  ["z", ["timezone", 0]],
  ["gmt", ["timezone", 0]],
  ["cdt", ["timezone", -5]],
  ["cst", ["timezone", -6]],
  ["edt", ["timezone", -4]],
  ["est", ["timezone", -5]],
  ["mdt", ["timezone", -6]],
  ["mst", ["timezone", -7]],
  ["pdt", ["timezone", -7]],
  ["pst", ["timezone", -8]],
  ["t", ["separator", 0]],
]);

const MAX_TIME_MS = 8_640_000_000_000_000;
const MAX_TIME_BEFORE_UTC_MS = MAX_TIME_MS + 30 * 86_400_000;

function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

function isWhitespace(code) {
  return code === 9 || code === 10 || code === 11 || code === 12 ||
    code === 13 || code === 32 || code === 0x2028 || code === 0x2029;
}

function numberToken(value, length) {
  return { kind: "number", value, length };
}

function symbolToken(value) {
  return { kind: "symbol", value, length: 1 };
}

function keywordToken(type, value, length) {
  return { kind: "keyword", type, value, length };
}

function isSymbol(token, symbol) {
  return token.kind === "symbol" && token.value === symbol;
}

function isSign(token) {
  return isSymbol(token, "+") || isSymbol(token, "-");
}

function signValue(token) {
  return token.value === "+" ? 1 : -1;
}

function isKeyword(token, type) {
  return token.kind === "keyword" && token.type === type;
}

function isKeywordZ(token) {
  return isKeyword(token, "timezone") && token.length === 1 && token.value === 0;
}

function isFixedLengthNumber(token, length) {
  return token.kind === "number" && token.length === length;
}

class DateStringTokenizer {
  constructor(input) {
    this.input = input;
    this.index = 0;
    this.next = this.scan();
  }

  peek() {
    return this.next;
  }

  take() {
    const token = this.next;
    this.next = this.scan();
    return token;
  }

  skipSymbol(symbol) {
    if (!isSymbol(this.next, symbol)) return false;
    this.take();
    return true;
  }

  scan() {
    if (this.index >= this.input.length || this.input.charCodeAt(this.index) === 0) return END;

    const start = this.index;
    let code = this.input.charCodeAt(this.index);
    if (isAsciiDigit(code)) {
      while (this.input.charCodeAt(this.index) === 48) this.index++;
      let value = 0;
      let significantDigits = 0;
      while (this.index < this.input.length) {
        code = this.input.charCodeAt(this.index);
        if (!isAsciiDigit(code)) break;
        if (significantDigits < 9) value = value * 10 + code - 48;
        significantDigits++;
        this.index++;
      }
      return numberToken(value, this.index - start);
    }

    const character = this.input[this.index];
    if (character === ":" || character === "-" || character === "+" ||
        character === "." || character === ")") {
      this.index++;
      return symbolToken(character);
    }

    if (code >= 65 && !isWhitespace(code)) {
      let prefix = "";
      while (this.index < this.input.length) {
        code = this.input.charCodeAt(this.index);
        if (code < 65 || isWhitespace(code) || code === 0) break;
        if (prefix.length < 3) prefix += String.fromCharCode(code | 0x20);
        this.index++;
      }
      const length = this.index - start;
      const month = MONTHS.get(prefix);
      if (month !== undefined) return keywordToken("month", month, length);
      const exact = this.input.slice(start, this.index).toLowerCase();
      const keyword = KEYWORDS.get(exact);
      return keyword ? keywordToken(keyword[0], keyword[1], length) : keywordToken("invalid", 0, length);
    }

    if (isWhitespace(code)) {
      this.index++;
      return { kind: "whitespace", length: 1, value: 0 };
    }

    if (character === "(") {
      let balance = 0;
      do {
        const current = this.input[this.index];
        if (current === ")") balance--;
        else if (current === "(") balance++;
        this.index++;
      } while (balance > 0 && this.index < this.input.length && this.input.charCodeAt(this.index) !== 0);
      return UNKNOWN;
    }

    this.index++;
    return UNKNOWN;
  }
}

class DayComposer {
  constructor() {
    this.components = [];
    this.namedMonth = NONE;
    this.iso = false;
  }

  isEmpty() {
    return this.components.length === 0;
  }

  add(value) {
    if (this.components.length >= 3) return false;
    this.components.push(value);
    return true;
  }

  write(output) {
    if (this.components.length < 1) return false;
    while (this.components.length < 3) this.components.push(1);

    let year = 0;
    let month;
    let day;
    if (this.namedMonth === NONE) {
      if (this.iso || (this.components.length === 3 && !isDay(this.components[0]))) {
        [year, month, day] = this.components;
      } else {
        [month, day] = this.components;
        year = this.components[2];
      }
    } else {
      month = this.namedMonth;
      if (this.components.length === 1) {
        day = this.components[0];
      } else if (!isDay(this.components[0])) {
        year = this.components[0];
        day = this.components[1];
      } else {
        day = this.components[0];
        year = this.components[1];
      }
    }

    if (!this.iso) {
      if (year >= 0 && year <= 49) year += 2000;
      else if (year >= 50 && year <= 99) year += 1900;
    }
    if (!Number.isInteger(year) || !isMonth(month) || !isDay(day)) return false;
    output.year = year;
    output.month = month - 1;
    output.day = day;
    return true;
  }
}

class TimeComposer {
  constructor() {
    this.components = [];
    this.hourOffset = NONE;
  }

  isEmpty() {
    return this.components.length === 0;
  }

  isExpecting(value) {
    return (this.components.length === 1 && isMinute(value)) ||
      (this.components.length === 2 && isSecond(value)) ||
      (this.components.length === 3 && isMillisecond(value));
  }

  add(value) {
    if (this.components.length >= 4) return false;
    this.components.push(value);
    return true;
  }

  addFinal(value) {
    if (!this.add(value)) return false;
    while (this.components.length < 4) this.components.push(0);
    return true;
  }

  write(output) {
    while (this.components.length < 4) this.components.push(0);
    let [hour, minute, second, millisecond] = this.components;
    if (this.hourOffset !== NONE) {
      if (hour < 0 || hour > 12) return false;
      hour = (hour % 12) + this.hourOffset;
    }
    const ordinaryTime = hour >= 0 && hour <= 23 && isMinute(minute) &&
      isSecond(second) && isMillisecond(millisecond);
    if (!ordinaryTime && !(hour === 24 && minute === 0 && second === 0 && millisecond === 0)) return false;
    output.hour = hour;
    output.minute = minute;
    output.second = second;
    output.millisecond = millisecond;
    return true;
  }
}

class TimeZoneComposer {
  constructor() {
    this.sign = NONE;
    this.hour = NONE;
    this.minute = NONE;
  }

  isEmpty() {
    return this.hour === NONE;
  }

  isUTC() {
    return this.hour === 0 && this.minute === 0;
  }

  set(offsetHours) {
    this.sign = offsetHours < 0 ? -1 : 1;
    this.hour = Math.abs(offsetHours);
    this.minute = 0;
  }

  isExpecting(value) {
    return this.hour !== NONE && this.minute === NONE && isMinute(value);
  }

  write(output) {
    if (this.sign === NONE) {
      output.utcOffsetSeconds = NONE;
      return true;
    }
    const hour = this.hour === NONE ? 0 : this.hour;
    const minute = this.minute === NONE ? 0 : this.minute;
    const totalSeconds = hour * 3600 + minute * 60;
    if (!Number.isSafeInteger(totalSeconds) || totalSeconds > 0x7fffffff) return false;
    output.utcOffsetSeconds = this.sign < 0 ? -totalSeconds : totalSeconds;
    return true;
  }
}

function isMonth(value) {
  return Number.isInteger(value) && value >= 1 && value <= 12;
}

function isDay(value) {
  return Number.isInteger(value) && value >= 1 && value <= 31;
}

function isMinute(value) {
  return Number.isInteger(value) && value >= 0 && value <= 59;
}

function isSecond(value) {
  return Number.isInteger(value) && value >= 0 && value <= 59;
}

function isMillisecond(value) {
  return Number.isInteger(value) && value >= 0 && value <= 999;
}

function readMilliseconds(token) {
  let value = token.value;
  let length = token.length;
  if (length === 1) return value * 100;
  if (length === 2) return value * 10;
  length = Math.min(length, 9);
  while (length > 3) {
    value = Math.trunc(value / 10);
    length--;
  }
  return value;
}

function parseES5DateTime(scanner, day, time, timezone) {
  if (isSign(scanner.peek())) {
    const sign = scanner.take();
    if (!isFixedLengthNumber(scanner.peek(), 6)) return sign;
    const year = scanner.take().value;
    if (signValue(sign) < 0 && year === 0) return sign;
    day.add(signValue(sign) * year);
  } else if (isFixedLengthNumber(scanner.peek(), 4)) {
    day.add(scanner.take().value);
  } else {
    return scanner.take();
  }

  if (scanner.skipSymbol("-")) {
    if (!isFixedLengthNumber(scanner.peek(), 2) || !isMonth(scanner.peek().value)) return scanner.take();
    day.add(scanner.take().value);
    if (scanner.skipSymbol("-")) {
      if (!isFixedLengthNumber(scanner.peek(), 2) || !isDay(scanner.peek().value)) return scanner.take();
      day.add(scanner.take().value);
    }
  }

  if (!isKeyword(scanner.peek(), "separator")) {
    if (scanner.peek().kind !== "end") return scanner.take();
  } else {
    scanner.take();
    if (!isFixedLengthNumber(scanner.peek(), 2) || scanner.peek().value < 0 || scanner.peek().value > 24) return INVALID;
    const hourIs24 = scanner.peek().value === 24;
    time.add(scanner.take().value);
    if (!scanner.skipSymbol(":")) return INVALID;
    if (!isFixedLengthNumber(scanner.peek(), 2) || !isMinute(scanner.peek().value) ||
        (hourIs24 && scanner.peek().value > 0)) return INVALID;
    time.add(scanner.take().value);
    if (scanner.skipSymbol(":")) {
      if (!isFixedLengthNumber(scanner.peek(), 2) || !isSecond(scanner.peek().value) ||
          (hourIs24 && scanner.peek().value > 0)) return INVALID;
      time.add(scanner.take().value);
      if (scanner.skipSymbol(".")) {
        if (scanner.peek().kind !== "number" || (hourIs24 && scanner.peek().value > 0)) return INVALID;
        time.add(readMilliseconds(scanner.take()));
      }
    }

    if (isKeywordZ(scanner.peek())) {
      scanner.take();
      timezone.set(0);
    } else if (isSign(scanner.peek())) {
      timezone.sign = signValue(scanner.take());
      if (isFixedLengthNumber(scanner.peek(), 4)) {
        const hourMinute = scanner.take().value;
        const hour = Math.trunc(hourMinute / 100);
        const minute = hourMinute % 100;
        if (hour < 0 || hour > 23 || !isMinute(minute)) return INVALID;
        timezone.hour = hour;
        timezone.minute = minute;
      } else {
        if (!isFixedLengthNumber(scanner.peek(), 2) || scanner.peek().value < 0 || scanner.peek().value > 23) return INVALID;
        timezone.hour = scanner.take().value;
        if (!scanner.skipSymbol(":")) return INVALID;
        if (!isFixedLengthNumber(scanner.peek(), 2) || !isMinute(scanner.peek().value)) return INVALID;
        timezone.minute = scanner.take().value;
      }
    }
    if (scanner.peek().kind !== "end") return INVALID;
  }

  if (timezone.isEmpty() && time.isEmpty()) timezone.set(0);
  day.iso = true;
  return END;
}

function parseComponents(input) {
  const scanner = new DateStringTokenizer(input);
  const day = new DayComposer();
  const time = new TimeComposer();
  const timezone = new TimeZoneComposer();
  let token = parseES5DateTime(scanner, day, time, timezone);
  if (token.kind === "invalid") return null;
  let hasReadNumber = !day.isEmpty();

  while (token.kind !== "end") {
    if (token.kind === "number") {
      hasReadNumber = true;
      const value = token.value;
      if (scanner.skipSymbol(":")) {
        if (scanner.skipSymbol(":")) {
          if (!time.isEmpty()) return null;
          time.add(value);
          time.add(0);
        } else {
          if (!time.add(value)) return null;
          if (isSymbol(scanner.peek(), ".")) scanner.take();
        }
      } else if (scanner.skipSymbol(".") && time.isExpecting(value)) {
        time.add(value);
        if (scanner.peek().kind !== "number") return null;
        time.addFinal(readMilliseconds(scanner.take()));
      } else if (timezone.isExpecting(value)) {
        timezone.minute = value;
      } else if (time.isExpecting(value)) {
        time.addFinal(value);
        const next = scanner.peek();
        if (next.kind !== "end" && next.kind !== "whitespace" && !isKeywordZ(next) && !isSign(next)) return null;
      } else {
        if (!day.add(value)) return null;
        scanner.skipSymbol("-");
      }
    } else if (token.kind === "keyword") {
      if (token.type === "ampm" && !time.isEmpty()) {
        time.hourOffset = token.value;
      } else if (token.type === "month") {
        day.namedMonth = token.value;
        scanner.skipSymbol("-");
      } else if (token.type === "timezone" && hasReadNumber) {
        timezone.set(token.value);
      } else {
        if (hasReadNumber) return null;
        if (scanner.peek().kind === "number") return null;
      }
    } else if (isSign(token) && (timezone.isUTC() || !time.isEmpty())) {
      timezone.sign = signValue(token);
      let value = 0;
      let length = 0;
      if (scanner.peek().kind === "number") {
        const number = scanner.take();
        value = number.value;
        length = number.length;
      }
      hasReadNumber = true;
      if (isSymbol(scanner.peek(), ":")) {
        timezone.hour = value;
        timezone.minute = NONE;
      } else if (length === 1 || length === 2) {
        timezone.hour = value;
        timezone.minute = 0;
      } else if (length === 3 || length === 4) {
        timezone.hour = Math.trunc(value / 100);
        timezone.minute = value % 100;
      } else {
        return null;
      }
    } else if ((isSign(token) || isSymbol(token, ")")) && hasReadNumber) {
      return null;
    }
    token = scanner.take();
  }

  const output = {};
  return day.write(output) && time.write(output) && timezone.write(output) ? output : null;
}

function makeDay(year, month, date) {
  if (year < -1_000_000 || year > 1_000_000 || month < -10_000_000 ||
      month > 10_000_000 || !Number.isFinite(date)) return NaN;
  let y = Math.trunc(year);
  let m = Math.trunc(month);
  y += Math.trunc(m / 12);
  m %= 12;
  if (m < 0) {
    m += 12;
    y--;
  }
  const yearDelta = 399_999;
  const baseYear = 1970 + yearDelta;
  const baseDay = 365 * baseYear + Math.trunc(baseYear / 4) -
    Math.trunc(baseYear / 100) + Math.trunc(baseYear / 400);
  const adjustedYear = y + yearDelta;
  let dayFromYear = 365 * adjustedYear + Math.trunc(adjustedYear / 4) -
    Math.trunc(adjustedYear / 100) + Math.trunc(adjustedYear / 400) - baseDay;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const dayFromMonth = leap
    ? [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335]
    : [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  dayFromYear += dayFromMonth[m];
  return dayFromYear - 1 + Math.trunc(date);
}

function timeClip(value) {
  if (!Number.isFinite(value) || value < -MAX_TIME_MS || value > MAX_TIME_MS) return NaN;
  return Math.trunc(value) + 0;
}

function abstractToPrimitive(value, hint) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  const exotic = value[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic !== "function") throw new TypeError("@@toPrimitive must be a function");
    const primitive = exotic.call(value, hint);
    if ((typeof primitive !== "object" && typeof primitive !== "function") || primitive === null) return primitive;
    throw new TypeError("Cannot convert object to primitive value");
  }
  const methods = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const methodName of methods) {
    const method = value[methodName];
    if (typeof method !== "function") continue;
    const primitive = method.call(value);
    if ((typeof primitive !== "object" && typeof primitive !== "function") || primitive === null) return primitive;
  }
  throw new TypeError("Cannot convert object to primitive value");
}

function abstractToString(value) {
  const primitive = abstractToPrimitive(value, "string");
  if (typeof primitive === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
  return String(primitive);
}

export function parseV8Date(input, NativeDate = globalThis.Date, dateIntrinsics = undefined) {
  const components = parseComponents(input);
  if (!components) return NaN;

  if (components.utcOffsetSeconds === NONE) {
    const approximate = makeDay(components.year, components.month, components.day) * 86_400_000 +
      components.hour * 3_600_000 + components.minute * 60_000 +
      components.second * 1_000 + components.millisecond;
    if (approximate < -MAX_TIME_BEFORE_UTC_MS || approximate > MAX_TIME_BEFORE_UTC_MS) return NaN;
    const local = Reflect.construct(NativeDate, [0]);
    const setFullYear = dateIntrinsics?.setFullYear ?? NativeDate.prototype.setFullYear;
    const setHours = dateIntrinsics?.setHours ?? NativeDate.prototype.setHours;
    const getTime = dateIntrinsics?.getTime ?? NativeDate.prototype.getTime;
    Reflect.apply(setFullYear, local, [components.year, components.month, components.day]);
    Reflect.apply(setHours, local, [components.hour, components.minute, components.second, components.millisecond]);
    return timeClip(Reflect.apply(getTime, local, []));
  }

  const day = makeDay(components.year, components.month, components.day);
  const time = components.hour * 3_600_000 + components.minute * 60_000 +
    components.second * 1_000 + components.millisecond;
  return timeClip(day * 86_400_000 + time - components.utcOffsetSeconds * 1_000);
}

const installedDates = new WeakSet();

function installISO8601LocaleDateCompatibility(NativeDate) {
  const prototype = NativeDate.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "toLocaleDateString");
  const nativeToLocaleDateString = descriptor?.value;
  if (typeof nativeToLocaleDateString !== "function") return;

  const probe = Reflect.construct(NativeDate, [Date.UTC(1583, 0, 1)]);
  const isoResult = Reflect.apply(nativeToLocaleDateString, probe, [
    "en-US",
    { timeZone: "UTC", calendar: "iso8601" },
  ]);
  const gregoryResult = Reflect.apply(nativeToLocaleDateString, probe, [
    "en-US",
    { timeZone: "UTC", calendar: "gregory" },
  ]);
  if (isoResult === gregoryResult) return;

  function toLocaleDateString(locales, options) {
    if (options !== null && (typeof options === "object" || typeof options === "function") &&
        options.calendar === "iso8601") {
      const compatibleOptions = Object.create(options);
      Object.defineProperty(compatibleOptions, "calendar", {
        configurable: true,
        enumerable: true,
        value: "gregory",
        writable: true,
      });
      return Reflect.apply(nativeToLocaleDateString, this, [locales, compatibleOptions]);
    }
    return Reflect.apply(nativeToLocaleDateString, this, arguments);
  }

  Object.defineProperty(toLocaleDateString, "name", { value: "toLocaleDateString" });
  Object.defineProperty(prototype, "toLocaleDateString", {
    ...descriptor,
    value: toLocaleDateString,
  });
}

export function installV8DateParser() {
  const NativeDate = globalThis.Date;
  if (typeof NativeDate !== "function" || installedDates.has(NativeDate)) return NativeDate;
  const dateIntrinsics = {
    getTime: NativeDate.prototype.getTime,
    setFullYear: NativeDate.prototype.setFullYear,
    setHours: NativeDate.prototype.setHours,
  };

  function parse(value) {
    return parseV8Date(abstractToString(value), NativeDate, dateIntrinsics);
  }

  let CompatibleDate;
  CompatibleDate = new Proxy(NativeDate, {
    apply(target, thisArg, argumentsList) {
      return Reflect.apply(target, thisArg, argumentsList);
    },
    construct(target, argumentsList, newTarget) {
      if (argumentsList.length !== 1) return Reflect.construct(target, argumentsList, newTarget);
      const value = argumentsList[0];
      if ((typeof value === "object" || typeof value === "function") && value !== null) {
        try {
          const dateValue = Reflect.apply(dateIntrinsics.getTime, value, []);
          return Reflect.construct(target, [dateValue], newTarget);
        } catch {}
      }
      const primitive = abstractToPrimitive(value, "default");
      const parsed = typeof primitive === "string"
        ? parseV8Date(primitive, NativeDate, dateIntrinsics)
        : primitive;
      return Reflect.construct(target, [parsed], newTarget);
    },
  });

  Object.defineProperty(CompatibleDate, "parse", {
    configurable: true,
    enumerable: false,
    writable: true,
    value: parse,
  });
  installedDates.add(NativeDate);
  installedDates.add(CompatibleDate);
  const constructorDescriptor = Object.getOwnPropertyDescriptor(NativeDate.prototype, "constructor");
  Object.defineProperty(NativeDate.prototype, "constructor", {
    ...constructorDescriptor,
    value: CompatibleDate,
  });
  installISO8601LocaleDateCompatibility(NativeDate);
  globalThis.Date = CompatibleDate;
  return CompatibleDate;
}

installV8DateParser();
