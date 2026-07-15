const origin = Date.now();
const nativeNow = globalThis.performance?.now?.bind(globalThis.performance);
const entries = [];
const observers = new Set();

function nowMs() {
  return typeof nativeNow === "function" ? nativeNow() : Date.now() - origin;
}

function entryJson(entry) {
  return {
    name: entry.name,
    entryType: entry.entryType,
    startTime: entry.startTime,
    duration: entry.duration,
    detail: entry.detail,
  };
}

export class PerformanceEntry {
  constructor(name = "", entryType = "", startTime = 0, duration = 0) {
    this.name = String(name);
    this.entryType = String(entryType);
    this.startTime = Number(startTime);
    this.duration = Number(duration);
  }

  toJSON() {
    return entryJson(this);
  }
}

export class PerformanceMark extends PerformanceEntry {
  constructor(name, options = {}) {
    super(name, "mark", options.startTime ?? nowMs(), 0);
    this.detail = options.detail;
  }
}

export class PerformanceMeasure extends PerformanceEntry {
  constructor(name, startTime, duration, detail = undefined) {
    super(name, "measure", startTime, duration);
    this.detail = detail;
  }
}

export class PerformanceResourceTiming extends PerformanceEntry {
  constructor(name = "", startTime = 0, duration = 0, timingInfo = {}, initiatorType = "") {
    super(name, "resource", startTime, duration);
    this.initiatorType = String(initiatorType ?? "");
    this.workerStart = Number(timingInfo.workerStart ?? 0);
    this.redirectStart = Number(timingInfo.redirectStart ?? 0);
    this.redirectEnd = Number(timingInfo.redirectEnd ?? 0);
    this.fetchStart = Number(timingInfo.fetchStart ?? startTime);
    this.domainLookupStart = Number(timingInfo.domainLookupStart ?? 0);
    this.domainLookupEnd = Number(timingInfo.domainLookupEnd ?? 0);
    this.connectStart = Number(timingInfo.connectStart ?? 0);
    this.connectEnd = Number(timingInfo.connectEnd ?? 0);
    this.secureConnectionStart = Number(timingInfo.secureConnectionStart ?? 0);
    this.requestStart = Number(timingInfo.requestStart ?? 0);
    this.responseStart = Number(timingInfo.responseStart ?? 0);
    this.responseEnd = Number(timingInfo.responseEnd ?? (startTime + duration));
    this.transferSize = Number(timingInfo.transferSize ?? 0);
    this.encodedBodySize = Number(timingInfo.encodedBodySize ?? 0);
    this.decodedBodySize = Number(timingInfo.decodedBodySize ?? 0);
    this.responseStatus = Number(timingInfo.responseStatus ?? 0);
    this.deliveryType = String(timingInfo.deliveryType ?? "");
  }

  toJSON() {
    return {
      ...entryJson(this),
      initiatorType: this.initiatorType,
      workerStart: this.workerStart,
      redirectStart: this.redirectStart,
      redirectEnd: this.redirectEnd,
      fetchStart: this.fetchStart,
      domainLookupStart: this.domainLookupStart,
      domainLookupEnd: this.domainLookupEnd,
      connectStart: this.connectStart,
      connectEnd: this.connectEnd,
      secureConnectionStart: this.secureConnectionStart,
      requestStart: this.requestStart,
      responseStart: this.responseStart,
      responseEnd: this.responseEnd,
      transferSize: this.transferSize,
      encodedBodySize: this.encodedBodySize,
      decodedBodySize: this.decodedBodySize,
      responseStatus: this.responseStatus,
      deliveryType: this.deliveryType,
    };
  }
}

export class PerformanceObserverEntryList {
  constructor(items = []) {
    this._entries = [...items];
  }

  getEntries() {
    return [...this._entries].sort((left, right) => left.startTime - right.startTime);
  }

  getEntriesByName(name, type = undefined) {
    return this.getEntries().filter((entry) => entry.name === String(name) && (type == null || entry.entryType === String(type)));
  }

  getEntriesByType(type) {
    return this.getEntries().filter((entry) => entry.entryType === String(type));
  }
}

function notifyObservers(entry) {
  for (const observer of observers) {
    if (!observer._types.has(entry.entryType)) continue;
    observer._queue.push(entry);
    observer._schedule();
  }
}

function addEntry(entry) {
  entries.push(entry);
  notifyObservers(entry);
  return entry;
}

function findMark(name) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.entryType === "mark" && entry.name === name) return entry.startTime;
  }
  throw new Error(`Performance mark not found: ${name}`);
}

export class PerformanceObserver {
  constructor(callback) {
    if (typeof callback !== "function") throw new TypeError("PerformanceObserver callback must be a function");
    this._callback = callback;
    this._queue = [];
    this._types = new Set();
    this._scheduled = false;
  }

  observe(options = {}) {
    this._types.clear();
    if (options.entryTypes) {
      for (const type of options.entryTypes) this._types.add(String(type));
    } else if (options.type) {
      this._types.add(String(options.type));
    } else {
      throw new TypeError("PerformanceObserver.observe requires entryTypes or type");
    }
    observers.add(this);
    if (options.buffered) {
      for (const entry of entries) {
        if (this._types.has(entry.entryType)) this._queue.push(entry);
      }
      this._schedule();
    }
  }

  disconnect() {
    observers.delete(this);
    this._queue = [];
  }

  takeRecords() {
    const records = this._queue;
    this._queue = [];
    return records;
  }

  _schedule() {
    if (this._scheduled) return;
    this._scheduled = true;
    queueMicrotask(() => {
      this._scheduled = false;
      const records = this.takeRecords();
      if (records.length > 0) this._callback(new PerformanceObserverEntryList(records), this);
    });
  }

  static get supportedEntryTypes() {
    return ["mark", "measure", "resource", "function"];
  }
}

export class Performance {
  constructor() {
    this.timeOrigin = origin;
    this._resourceTimingBufferSize = 250;
    this.nodeTiming = {
      name: "node",
      entryType: "node",
      startTime: 0,
      duration: 0,
      nodeStart: 0,
      v8Start: 0,
      bootstrapComplete: 0,
      environment: 0,
      loopStart: -1,
      loopExit: -1,
      idleTime: 0,
    };
  }

  now() {
    return nowMs();
  }

  eventLoopUtilization(previous = undefined) {
    const active = Math.max(0, nowMs());
    const result = { idle: 0, active, utilization: active > 0 ? 1 : 0 };
    if (previous && typeof previous === "object") {
      result.idle -= Number(previous.idle ?? 0);
      result.active -= Number(previous.active ?? 0);
      const total = result.idle + result.active;
      result.utilization = total > 0 ? result.active / total : 0;
    }
    return result;
  }

  mark(name, options = {}) {
    return addEntry(new PerformanceMark(name, options));
  }

  measure(name, startOrOptions = undefined, endMark = undefined) {
    let startTime = 0;
    let endTime = nowMs();
    let detail = undefined;
    if (typeof startOrOptions === "string") {
      startTime = findMark(startOrOptions);
      if (typeof endMark === "string") endTime = findMark(endMark);
    } else if (startOrOptions && typeof startOrOptions === "object") {
      detail = startOrOptions.detail;
      startTime = typeof startOrOptions.start === "string" ? findMark(startOrOptions.start) : Number(startOrOptions.start ?? 0);
      endTime = typeof startOrOptions.end === "string" ? findMark(startOrOptions.end) : Number(startOrOptions.end ?? nowMs());
      if (startOrOptions.duration != null) endTime = startTime + Number(startOrOptions.duration);
    }
    return addEntry(new PerformanceMeasure(name, startTime, Math.max(0, endTime - startTime), detail));
  }

  clearMarks(name = undefined) {
    removeEntries("mark", name);
  }

  clearMeasures(name = undefined) {
    removeEntries("measure", name);
  }

  clearResourceTimings() {
    removeEntries("resource");
  }

  getEntries() {
    return new PerformanceObserverEntryList(entries).getEntries();
  }

  getEntriesByName(name, type = undefined) {
    return new PerformanceObserverEntryList(entries).getEntriesByName(name, type);
  }

  getEntriesByType(type) {
    return new PerformanceObserverEntryList(entries).getEntriesByType(type);
  }

  setResourceTimingBufferSize(size = 250) {
    this._resourceTimingBufferSize = Math.max(0, Number(size) || 0);
  }

  markResourceTiming(timingInfo = {}, requestedUrl = "", initiatorType = "", global = undefined, cacheMode = "", bodyInfo = undefined, responseStatus = 0, deliveryType = "") {
    void global;
    void cacheMode;
    const startTime = Number(timingInfo.startTime ?? timingInfo.start ?? timingInfo.fetchStart ?? 0);
    const responseEnd = Number(timingInfo.responseEnd ?? timingInfo.endTime ?? startTime);
    const body = bodyInfo && typeof bodyInfo === "object" ? bodyInfo : {};
    const entry = new PerformanceResourceTiming(
      String(requestedUrl),
      startTime,
      Math.max(0, responseEnd - startTime),
      {
        ...timingInfo,
        transferSize: timingInfo.transferSize ?? body.transferSize,
        encodedBodySize: timingInfo.encodedBodySize ?? body.encodedBodySize,
        decodedBodySize: timingInfo.decodedBodySize ?? body.decodedBodySize,
        responseStatus: timingInfo.responseStatus ?? responseStatus,
        deliveryType: timingInfo.deliveryType ?? deliveryType,
      },
      initiatorType,
    );
    if (this.getEntriesByType("resource").length >= this._resourceTimingBufferSize) removeEntries("resource", entries.find((item) => item.entryType === "resource")?.name);
    return addEntry(entry);
  }

  timerify(fn) {
    if (typeof fn !== "function") throw new TypeError("performance.timerify requires a function");
    const wrapped = (...args) => {
      const start = nowMs();
      try {
        const result = fn(...args);
        if (result && typeof result.then === "function") {
          return result.finally(() => addEntry(new PerformanceEntry(fn.name || "anonymous", "function", start, nowMs() - start)));
        }
        addEntry(new PerformanceEntry(fn.name || "anonymous", "function", start, nowMs() - start));
        return result;
      } catch (error) {
        addEntry(new PerformanceEntry(fn.name || "anonymous", "function", start, nowMs() - start));
        throw error;
      }
    };
    Object.defineProperty(wrapped, "name", { value: fn.name, configurable: true });
    return wrapped;
  }
}

function removeEntries(type, name = undefined) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].entryType === type && (name == null || entries[index].name === String(name))) {
      entries.splice(index, 1);
    }
  }
}

const EMPTY_HISTOGRAM_MIN_BIGINT = 9223372036854775807n;
const MAX_HISTOGRAM_VALUE = Number.MAX_SAFE_INTEGER;
const histogramPercentiles = [0, 50, 75, 90, 99, 100];

function histogramError(code, message, ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function validateHistogramInteger(value, name) {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw histogramError("ERR_INVALID_ARG_TYPE", `The \"${name}\" argument must be of type number or bigint`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw histogramError("ERR_OUT_OF_RANGE", `The value of \"${name}\" is out of range`, RangeError);
  }
  return number;
}

class RecordableHistogram {
  constructor(lowest, highest, figures, token) {
    if (token !== RecordableHistogram) {
      throw histogramError("ERR_ILLEGAL_CONSTRUCTOR", "Illegal constructor");
    }
    this._lowest = lowest;
    this._highest = highest;
    this._figures = figures;
    this._values = [];
    this._exceeds = 0;
    this._lastDelta = undefined;
  }

  record(value) {
    const number = validateHistogramInteger(value, "val");
    if (number < 1) {
      throw histogramError("ERR_OUT_OF_RANGE", "The value of \"val\" is out of range", RangeError);
    }
    if (number > this._highest) {
      this._exceeds += 1;
      return;
    }
    this._values.push(number);
  }

  recordDelta() {
    const current = nowMs() * 1e6;
    if (this._lastDelta !== undefined) this.record(Math.max(1, Math.round(current - this._lastDelta)));
    this._lastDelta = current;
  }

  add(other) {
    if (!(other instanceof RecordableHistogram)) {
      throw histogramError("ERR_INVALID_ARG_TYPE", "The \"other\" argument must be a Histogram");
    }
    for (const value of other._values) {
      if (value > this._highest) this._exceeds += 1;
      else this._values.push(value);
    }
    this._exceeds += other._exceeds;
  }

  reset() {
    this._values = [];
    this._exceeds = 0;
    this._lastDelta = undefined;
  }

  _percentile(percentile) {
    const value = Number(percentile);
    if (!Number.isFinite(value) || value <= 0 || value > 100) {
      throw histogramError("ERR_OUT_OF_RANGE", "The value of \"percentile\" is out of range", RangeError);
    }
    if (this._values.length === 0) return 0;
    const sorted = [...this._values].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil((value / 100) * sorted.length) - 1)];
  }

  percentile(percentile) {
    return this._percentile(percentile);
  }

  percentileBigInt(percentile) {
    return BigInt(this._percentile(percentile));
  }

  get percentiles() {
    if (this._values.length === 0) return new Map();
    return new Map(histogramPercentiles.map((percentile) => [percentile, BigInt(percentile === 0 ? this.min : this._percentile(percentile))]));
  }

  get percentilesBigInt() {
    return this.percentiles;
  }

  get count() { return this._values.length; }
  get countBigInt() { return BigInt(this.count); }
  get min() { return this._values.length ? Math.min(...this._values) : Number(EMPTY_HISTOGRAM_MIN_BIGINT); }
  get minBigInt() { return this._values.length ? BigInt(this.min) : EMPTY_HISTOGRAM_MIN_BIGINT; }
  get max() { return this._values.length ? Math.max(...this._values) : 0; }
  get maxBigInt() { return BigInt(this.max); }
  get exceeds() { return this._exceeds; }
  get exceedsBigInt() { return BigInt(this._exceeds); }
  get mean() { return this._values.length ? this._values.reduce((sum, value) => sum + value, 0) / this._values.length : NaN; }
  get stddev() {
    if (this._values.length === 0) return NaN;
    const mean = this.mean;
    return Math.sqrt(this._values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / this._values.length);
  }

  toJSON() {
    return {
      count: this.count,
      min: this.min,
      max: this.max,
      mean: this.mean,
      exceeds: this.exceeds,
      stddev: this.stddev,
      percentiles: Object.fromEntries([...this.percentiles].map(([key, value]) => [key, Number(value)])),
    };
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `Histogram { min: ${this.min}, max: ${this.max}, mean: ${this.mean}, exceeds: ${this.exceeds}, stddev: ${this.stddev}, count: ${this.count} }`;
  }
}

export function createHistogram(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw histogramError("ERR_INVALID_ARG_TYPE", "The \"options\" argument must be of type object");
  }
  const lowest = options.lowest === undefined ? 1 : validateHistogramInteger(options.lowest, "options.lowest");
  const highest = options.highest === undefined ? MAX_HISTOGRAM_VALUE : validateHistogramInteger(options.highest, "options.highest");
  if (typeof options.figures !== "undefined" && typeof options.figures !== "number") {
    throw histogramError("ERR_INVALID_ARG_TYPE", "The \"options.figures\" argument must be of type number");
  }
  const figures = options.figures === undefined ? 3 : options.figures;
  if (!Number.isInteger(figures) || figures < 1 || figures > 5) {
    throw histogramError("ERR_OUT_OF_RANGE", "The value of \"options.figures\" is out of range", RangeError);
  }
  if (lowest < 1) {
    throw histogramError("ERR_OUT_OF_RANGE", "The value of \"options.lowest\" is out of range", RangeError);
  }
  if (highest < lowest * 2 || highest > MAX_HISTOGRAM_VALUE) {
    throw histogramError("ERR_OUT_OF_RANGE", "The value of \"options.highest\" is out of range", RangeError);
  }
  return new RecordableHistogram(lowest, highest, figures, RecordableHistogram);
}

export function monitorEventLoopDelay(options = {}) {
  const histogram = createHistogram();
  const resolution = Math.max(1, Number(options.resolution ?? 10));
  let timer = null;
  histogram.enable = () => {
    if (timer != null) return true;
    histogram._last = nowMs();
    timer = setInterval(() => histogram.recordDelta(), resolution);
    timer?.unref?.();
    return true;
  };
  histogram.disable = () => {
    if (timer != null) clearInterval(timer);
    timer = null;
    return true;
  };
  return histogram;
}

export const constants = {
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16,
  NODE_PERFORMANCE_GC_FLAGS_NO: 0,
  NODE_PERFORMANCE_GC_FLAGS_CONSTRUCT_RETAINED: 2,
  NODE_PERFORMANCE_GC_FLAGS_FORCED: 4,
  NODE_PERFORMANCE_GC_FLAGS_SYNCHRONOUS_PHANTOM_PROCESSING: 8,
  NODE_PERFORMANCE_GC_FLAGS_ALL_AVAILABLE_GARBAGE: 16,
  NODE_PERFORMANCE_GC_FLAGS_ALL_EXTERNAL_MEMORY: 32,
  NODE_PERFORMANCE_GC_FLAGS_SCHEDULE_IDLE: 64,
};

export const performance = new Performance();

if (globalThis.performance && typeof globalThis.performance.markResourceTiming !== "function") {
  globalThis.performance.markResourceTiming = performance.markResourceTiming.bind(performance);
}

// COTTONTAIL-COMPAT: node:perf_hooks native entries - user marks/measures, explicit resource timings, observers, timerify, and histograms are implemented; automatic GC/resource entries need JSC instrumentation.

export default {
  Performance,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserver,
  PerformanceObserverEntryList,
  PerformanceResourceTiming,
  constants,
  createHistogram,
  monitorEventLoopDelay,
  performance,
};
