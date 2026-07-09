export const ADDRCONFIG = 1024;
export const V4MAPPED = 2048;
export const ALL = 256;

export const NODATA = "ENODATA";
export const FORMERR = "EFORMERR";
export const SERVFAIL = "ESERVFAIL";
export const NOTFOUND = "ENOTFOUND";
export const NOTIMP = "ENOTIMP";
export const REFUSED = "EREFUSED";
export const BADQUERY = "EBADQUERY";
export const BADNAME = "EBADNAME";
export const BADFAMILY = "EBADFAMILY";
export const BADRESP = "EBADRESP";
export const CONNREFUSED = "ECONNREFUSED";
export const TIMEOUT = "ETIMEOUT";
export const EOF = "EOF";
export const FILE = "EFILE";
export const NOMEM = "ENOMEM";
export const DESTRUCTION = "EDESTRUCTION";
export const BADSTR = "EBADSTR";
export const BADFLAGS = "EBADFLAGS";
export const NONAME = "ENONAME";
export const BADHINTS = "EBADHINTS";
export const NOTINITIALIZED = "ENOTINITIALIZED";
export const LOADIPHLPAPI = "ELOADIPHLPAPI";
export const ADDRGETNETWORKPARAMS = "EADDRGETNETWORKPARAMS";
export const CANCELLED = "ECANCELLED";

let defaultResultOrder = "verbatim";
let servers = [];

function makeDnsError(error, syscall, hostname = undefined, code = NOTFOUND) {
  const message = error instanceof Error ? error.message : String(error);
  const out = new Error(message || code);
  out.code = code;
  out.errno = code;
  out.syscall = syscall;
  if (hostname != null) out.hostname = String(hostname);
  return out;
}

function invalidRrtypeError(type) {
  const error = new TypeError(`The argument 'rrtype' is invalid. Received ${JSON.stringify(String(type))}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function callbackifyDns(work, callback) {
  if (typeof callback !== "function") throw new TypeError("callback must be a function");
  queueMicrotask(() => {
    try {
      callback(null, ...work());
    } catch (error) {
      callback(error);
    }
  });
}

function normalizeLookupOptions(options = {}) {
  if (typeof options === "number") return { family: options, all: false };
  if (typeof options === "string") return { family: Number(options) || 0, all: false };
  return {
    family: Number(options?.family ?? 0) || 0,
    all: Boolean(options?.all),
    order: options?.order ?? defaultResultOrder,
  };
}

function orderedRecords(records, order = defaultResultOrder) {
  const list = [...records];
  if (order === "ipv4first") list.sort((left, right) => left.family === right.family ? 0 : left.family === 4 ? -1 : 1);
  else if (order === "ipv6first") list.sort((left, right) => left.family === right.family ? 0 : left.family === 6 ? -1 : 1);
  return list;
}

function lookupRecords(hostname, family = 0, order = defaultResultOrder) {
  if (hostname == null || String(hostname) === "") return [{ address: null, family: 4 }];
  if (typeof cottontail.dnsLookup !== "function") throw makeDnsError("native DNS lookup is unavailable", "getaddrinfo", hostname);
  try {
    const records = Array.from(cottontail.dnsLookup(String(hostname), Number(family) || 0) ?? [])
      .map((record) => ({ address: String(record.address), family: Number(record.family) }))
      .filter((record) => (record.family === 4 || record.family === 6) && record.address);
    if (records.length === 0) throw makeDnsError("no DNS records found", "getaddrinfo", hostname);
    return orderedRecords(records, order);
  } catch (error) {
    throw makeDnsError(error, "getaddrinfo", hostname);
  }
}

function lookupServiceRecord(address, port) {
  if (typeof cottontail.dnsLookupService !== "function") throw makeDnsError("native DNS service lookup is unavailable", "getnameinfo", address);
  try {
    const record = cottontail.dnsLookupService(String(address), Number(port) || 0);
    return { hostname: String(record.hostname), service: String(record.service) };
  } catch (error) {
    throw makeDnsError(error, "getnameinfo", address);
  }
}

function resolveAddressRecords(hostname, family, options = undefined) {
  const ttl = typeof options === "object" && options != null && options.ttl === true;
  const records = lookupRecords(hostname, family);
  return ttl ? records.map((record) => ({ address: record.address, ttl: 0 })) : records.map((record) => record.address);
}

function resolveNativeRecords(hostname, type, syscall = `query${type[0]}${type.slice(1).toLowerCase()}`) {
  if (typeof cottontail.dnsResolveRecords !== "function") throw makeDnsError("native DNS record resolver is unavailable", syscall, hostname);
  try {
    const records = Array.from(cottontail.dnsResolveRecords(String(hostname), type) ?? []);
    if (records.length === 0) throw makeDnsError("no DNS records found", syscall, hostname, NODATA);
    return records;
  } catch (error) {
    throw makeDnsError(error, syscall, hostname);
  }
}

function ptrNameToAddress(name) {
  const text = String(name).toLowerCase();
  if (text.endsWith(".in-addr.arpa")) {
    const parts = text.slice(0, -".in-addr.arpa".length).split(".").filter(Boolean).reverse();
    if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) return parts.join(".");
  }
  return name;
}

export function lookup(hostname, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  const normalized = normalizeLookupOptions(options);
  callbackifyDns(() => {
    const records = lookupRecords(hostname, normalized.family, normalized.order);
    if (normalized.all) return [records];
    const first = records[0];
    return [first.address, first.family];
  }, callback);
}

export function lookupService(address, port, callback) {
  callbackifyDns(() => {
    const record = lookupServiceRecord(address, port);
    return [record.hostname, record.service];
  }, callback);
}

export function resolve4(hostname, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  callbackifyDns(() => [resolveAddressRecords(hostname, 4, options)], callback);
}

export function resolve6(hostname, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  callbackifyDns(() => [resolveAddressRecords(hostname, 6, options)], callback);
}

export function resolveAny(hostname, callback) {
  callbackifyDns(() => {
    const records = [];
    try {
      for (const address of resolveAddressRecords(hostname, 4)) records.push({ type: "A", address });
    } catch {}
    try {
      for (const address of resolveAddressRecords(hostname, 6)) records.push({ type: "AAAA", address });
    } catch {}
    if (records.length === 0) throw makeDnsError("no DNS records found", "queryAny", hostname);
    return [records];
  }, callback);
}

export function resolvePtr(hostname, callback) {
  callbackifyDns(() => {
    try {
      return [resolveNativeRecords(hostname, "PTR", "queryPtr")];
    } catch {
      const record = lookupServiceRecord(ptrNameToAddress(hostname), 0);
      return [[record.hostname]];
    }
  }, callback);
}

export function reverse(ip, callback) {
  callbackifyDns(() => {
    const record = lookupServiceRecord(ip, 0);
    return [[record.hostname]];
  }, callback);
}

export function resolve(hostname, rrtype = "A", callback = undefined) {
  if (typeof rrtype === "function") {
    callback = rrtype;
    rrtype = "A";
  }
  const type = String(rrtype || "A").toUpperCase();
  if (type === "A") return resolve4(hostname, callback);
  if (type === "AAAA") return resolve6(hostname, callback);
  if (type === "ANY") return resolveAny(hostname, callback);
  if (type === "PTR") return resolvePtr(hostname, callback);
  if (type === "CAA") return resolveCaa(hostname, callback);
  if (type === "CNAME") return resolveCname(hostname, callback);
  if (type === "MX") return resolveMx(hostname, callback);
  if (type === "NAPTR") return resolveNaptr(hostname, callback);
  if (type === "NS") return resolveNs(hostname, callback);
  if (type === "SOA") return resolveSoa(hostname, callback);
  if (type === "SRV") return resolveSrv(hostname, callback);
  if (type === "TLSA") return resolveTlsa(hostname, callback);
  if (type === "TXT") return resolveTxt(hostname, callback);
  throw invalidRrtypeError(type);
}

export function resolveCaa(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "CAA", "queryCaa")], callback);
}

export function resolveCname(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "CNAME", "queryCname")], callback);
}

export function resolveMx(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "MX", "queryMx")], callback);
}

export function resolveNaptr(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "NAPTR", "queryNaptr")], callback);
}

export function resolveNs(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "NS", "queryNs")], callback);
}

export function resolveSoa(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "SOA", "querySoa")[0]], callback);
}

export function resolveSrv(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "SRV", "querySrv")], callback);
}

export function resolveTlsa(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "TLSA", "queryTlsa")], callback);
}

export function resolveTxt(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "TXT", "queryTxt")], callback);
}

export function getDefaultResultOrder() {
  return defaultResultOrder;
}

export function setDefaultResultOrder(order) {
  const value = String(order);
  if (value !== "verbatim" && value !== "ipv4first" && value !== "ipv6first") {
    throw new TypeError("order must be verbatim, ipv4first, or ipv6first");
  }
  defaultResultOrder = value;
}

export function getServers() {
  return [...servers];
}

export function setServers(nextServers) {
  servers = Array.from(nextServers ?? [], String);
}

function promiseFromCallback(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

export class Resolver {
  cancel() {}
  getServers() { return getServers(); }
  setServers(nextServers) { return setServers(nextServers); }
  resolve(hostname, rrtype, callback) { return resolve(hostname, rrtype, callback); }
  resolve4(hostname, options, callback) { return resolve4(hostname, options, callback); }
  resolve6(hostname, options, callback) { return resolve6(hostname, options, callback); }
  resolveAny(hostname, callback) { return resolveAny(hostname, callback); }
  resolveCaa(hostname, callback) { return resolveCaa(hostname, callback); }
  resolveCname(hostname, callback) { return resolveCname(hostname, callback); }
  resolveMx(hostname, callback) { return resolveMx(hostname, callback); }
  resolveNaptr(hostname, callback) { return resolveNaptr(hostname, callback); }
  resolveNs(hostname, callback) { return resolveNs(hostname, callback); }
  resolvePtr(hostname, callback) { return resolvePtr(hostname, callback); }
  resolveSoa(hostname, callback) { return resolveSoa(hostname, callback); }
  resolveSrv(hostname, callback) { return resolveSrv(hostname, callback); }
  resolveTlsa(hostname, callback) { return resolveTlsa(hostname, callback); }
  resolveTxt(hostname, callback) { return resolveTxt(hostname, callback); }
  reverse(ip, callback) { return reverse(ip, callback); }
}

export class PromisesResolver {
  cancel() {}
  getServers() { return getServers(); }
  setServers(nextServers) { return setServers(nextServers); }
  resolve(hostname, rrtype = "A") { return promises.resolve(hostname, rrtype); }
  resolve4(hostname, options = undefined) { return promises.resolve4(hostname, options); }
  resolve6(hostname, options = undefined) { return promises.resolve6(hostname, options); }
  resolveAny(hostname) { return promises.resolveAny(hostname); }
  resolveCaa(hostname) { return promises.resolveCaa(hostname); }
  resolveCname(hostname) { return promises.resolveCname(hostname); }
  resolveMx(hostname) { return promises.resolveMx(hostname); }
  resolveNaptr(hostname) { return promises.resolveNaptr(hostname); }
  resolveNs(hostname) { return promises.resolveNs(hostname); }
  resolvePtr(hostname) { return promises.resolvePtr(hostname); }
  resolveSoa(hostname) { return promises.resolveSoa(hostname); }
  resolveSrv(hostname) { return promises.resolveSrv(hostname); }
  resolveTlsa(hostname) { return promises.resolveTlsa(hostname); }
  resolveTxt(hostname) { return promises.resolveTxt(hostname); }
  reverse(ip) { return promises.reverse(ip); }
}

export const promises = {
  ADDRGETNETWORKPARAMS,
  BADFAMILY,
  BADFLAGS,
  BADHINTS,
  BADNAME,
  BADQUERY,
  BADRESP,
  BADSTR,
  CANCELLED,
  CONNREFUSED,
  DESTRUCTION,
  EOF,
  FILE,
  FORMERR,
  LOADIPHLPAPI,
  NODATA,
  NOMEM,
  NONAME,
  NOTFOUND,
  NOTIMP,
  NOTINITIALIZED,
  REFUSED,
  SERVFAIL,
  TIMEOUT,
  Resolver: PromisesResolver,
  getDefaultResultOrder,
  getServers,
  lookup: (hostname, options = undefined) => new Promise((resolvePromise, reject) => {
    lookup(hostname, options, (error, address, family) => {
      if (error) reject(error);
      else if (Array.isArray(address)) resolvePromise(address);
      else resolvePromise({ address, family });
    });
  }),
  lookupService: (address, port) => new Promise((resolvePromise, reject) => {
    lookupService(address, port, (error, hostname, service) => {
      if (error) reject(error);
      else resolvePromise({ hostname, service });
    });
  }),
  resolve: (hostname, rrtype = "A") => promiseFromCallback(resolve, hostname, rrtype),
  resolve4: (hostname, options = undefined) => promiseFromCallback(resolve4, hostname, options),
  resolve6: (hostname, options = undefined) => promiseFromCallback(resolve6, hostname, options),
  resolveAny: (hostname) => promiseFromCallback(resolveAny, hostname),
  resolveCaa: (hostname) => promiseFromCallback(resolveCaa, hostname),
  resolveCname: (hostname) => promiseFromCallback(resolveCname, hostname),
  resolveMx: (hostname) => promiseFromCallback(resolveMx, hostname),
  resolveNaptr: (hostname) => promiseFromCallback(resolveNaptr, hostname),
  resolveNs: (hostname) => promiseFromCallback(resolveNs, hostname),
  resolvePtr: (hostname) => promiseFromCallback(resolvePtr, hostname),
  resolveSoa: (hostname) => promiseFromCallback(resolveSoa, hostname),
  resolveSrv: (hostname) => promiseFromCallback(resolveSrv, hostname),
  resolveTlsa: (hostname) => promiseFromCallback(resolveTlsa, hostname),
  resolveTxt: (hostname) => promiseFromCallback(resolveTxt, hostname),
  reverse: (ip) => promiseFromCallback(reverse, ip),
  setDefaultResultOrder,
  setServers,
};

// COTTONTAIL-COMPAT: node:dns resolver controls - lookup/getaddrinfo and DNS record queries use native system resolvers; setServers stores requested servers for API compatibility, but record queries still use the platform resolver configuration until per-query resolver state is wired.

export default {
  ADDRCONFIG,
  ADDRGETNETWORKPARAMS,
  ALL,
  BADFAMILY,
  BADFLAGS,
  BADHINTS,
  BADNAME,
  BADQUERY,
  BADRESP,
  BADSTR,
  CANCELLED,
  CONNREFUSED,
  DESTRUCTION,
  EOF,
  FILE,
  FORMERR,
  LOADIPHLPAPI,
  NODATA,
  NOMEM,
  NONAME,
  NOTFOUND,
  NOTIMP,
  NOTINITIALIZED,
  REFUSED,
  Resolver,
  SERVFAIL,
  TIMEOUT,
  V4MAPPED,
  getDefaultResultOrder,
  getServers,
  lookup,
  lookupService,
  promises,
  resolve,
  resolve4,
  resolve6,
  resolveAny,
  resolveCaa,
  resolveCname,
  resolveMx,
  resolveNaptr,
  resolveNs,
  resolvePtr,
  resolveSoa,
  resolveSrv,
  resolveTlsa,
  resolveTxt,
  reverse,
  setDefaultResultOrder,
  setServers,
};
