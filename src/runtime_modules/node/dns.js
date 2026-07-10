import { isIP } from "./net.js";

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

function invalidServerError(server) {
  const error = new TypeError(`Invalid IP address: ${server}`);
  error.code = "ERR_INVALID_IP_ADDRESS";
  return error;
}

function validatePort(port, server) {
  if (port == null || port === "") return;
  if (!/^\d+$/.test(String(port)) || Number(port) < 0 || Number(port) > 65535) {
    throw invalidServerError(server);
  }
}

function normalizeServer(server) {
  const text = String(server);
  let host = text;
  let port = undefined;
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    if (end < 0) throw invalidServerError(server);
    host = text.slice(1, end);
    const rest = text.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(":")) throw invalidServerError(server);
      port = rest.slice(1);
    }
  } else {
    const firstColon = text.indexOf(":");
    const lastColon = text.lastIndexOf(":");
    if (firstColon > 0 && firstColon === lastColon && text.includes(".")) {
      host = text.slice(0, firstColon);
      port = text.slice(firstColon + 1);
    }
  }
  if (isIP(host) === 0) throw invalidServerError(server);
  validatePort(port, server);
  return text;
}

function normalizeServers(nextServers) {
  if (nextServers == null || typeof nextServers[Symbol.iterator] !== "function") {
    throw new TypeError("servers must be an iterable");
  }
  return Array.from(nextServers, normalizeServer);
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

function resolverNativeOptions(resolverState = undefined) {
  if (resolverState === null) return undefined;
  const state = resolverState ?? { _servers: servers };
  const options = {};
  const stateServers = Array.isArray(state._servers) ? state._servers : [];
  if (stateServers.length > 0) options.servers = [...stateServers];
  if (state.timeout != null) options.timeout = Number(state.timeout);
  if (state.tries != null) options.tries = Number(state.tries);
  return Object.keys(options).length > 0 ? options : undefined;
}

function lookupRecords(hostname, family = 0, order = defaultResultOrder, resolverState = null) {
  if (hostname == null || String(hostname) === "") return [{ address: null, family: 4 }];
  if (typeof cottontail.dnsLookup !== "function") throw makeDnsError("native DNS lookup is unavailable", "getaddrinfo", hostname);
  try {
    const nativeOptions = resolverNativeOptions(resolverState);
    const records = Array.from((nativeOptions == null
      ? cottontail.dnsLookup(String(hostname), Number(family) || 0)
      : cottontail.dnsLookup(String(hostname), Number(family) || 0, nativeOptions)) ?? [])
      .map((record) => ({ address: String(record.address), family: Number(record.family) }))
      .filter((record) => (record.family === 4 || record.family === 6) && record.address);
    if (records.length === 0) throw makeDnsError("no DNS records found", "getaddrinfo", hostname);
    return orderedRecords(records, order);
  } catch (error) {
    throw makeDnsError(error, "getaddrinfo", hostname);
  }
}

function lookupServiceRecord(address, port, resolverState = null) {
  if (typeof cottontail.dnsLookupService !== "function") throw makeDnsError("native DNS service lookup is unavailable", "getnameinfo", address);
  try {
    const nativeOptions = resolverNativeOptions(resolverState);
    const record = nativeOptions == null
      ? cottontail.dnsLookupService(String(address), Number(port) || 0)
      : cottontail.dnsLookupService(String(address), Number(port) || 0, nativeOptions);
    return { hostname: String(record.hostname), service: String(record.service) };
  } catch (error) {
    throw makeDnsError(error, "getnameinfo", address);
  }
}

function resolveAddressRecords(hostname, family, options = undefined, resolverState = undefined) {
  const ttl = typeof options === "object" && options != null && options.ttl === true;
  const records = lookupRecords(hostname, family, defaultResultOrder, resolverState);
  return ttl ? records.map((record) => ({ address: record.address, ttl: 0 })) : records.map((record) => record.address);
}

function resolveNativeRecords(hostname, type, syscall = `query${type[0]}${type.slice(1).toLowerCase()}`, resolverState = undefined) {
  if (typeof cottontail.dnsResolveRecords !== "function") throw makeDnsError("native DNS record resolver is unavailable", syscall, hostname);
  try {
    const nativeOptions = resolverNativeOptions(resolverState);
    const records = Array.from((nativeOptions == null
      ? cottontail.dnsResolveRecords(String(hostname), type)
      : cottontail.dnsResolveRecords(String(hostname), type, nativeOptions)) ?? []);
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
    const records = lookupRecords(hostname, normalized.family, normalized.order, null);
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
  callbackifyDns(() => [resolveAddressRecords(hostname, 4, options, undefined)], callback);
}

export function resolve6(hostname, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  callbackifyDns(() => [resolveAddressRecords(hostname, 6, options, undefined)], callback);
}

function resolveAnyWithState(hostname, callback, resolverState = undefined) {
  callbackifyDns(() => {
    const records = [];
    try {
      for (const address of resolveAddressRecords(hostname, 4, undefined, resolverState)) records.push({ type: "A", address });
    } catch {}
    try {
      for (const address of resolveAddressRecords(hostname, 6, undefined, resolverState)) records.push({ type: "AAAA", address });
    } catch {}
    if (records.length === 0) throw makeDnsError("no DNS records found", "queryAny", hostname);
    return [records];
  }, callback);
}

export function resolveAny(hostname, callback) {
  return resolveAnyWithState(hostname, callback, undefined);
}

function resolvePtrWithState(hostname, callback, resolverState = undefined) {
  callbackifyDns(() => {
    try {
      return [resolveNativeRecords(hostname, "PTR", "queryPtr", resolverState)];
    } catch {
      const record = lookupServiceRecord(ptrNameToAddress(hostname), 0, resolverState);
      return [[record.hostname]];
    }
  }, callback);
}

export function resolvePtr(hostname, callback) {
  return resolvePtrWithState(hostname, callback, undefined);
}

export function reverse(ip, callback) {
  callbackifyDns(() => {
    const record = lookupServiceRecord(ip, 0, undefined);
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
  callbackifyDns(() => [resolveNativeRecords(hostname, "CAA", "queryCaa", undefined)], callback);
}

export function resolveCname(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "CNAME", "queryCname", undefined)], callback);
}

export function resolveMx(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "MX", "queryMx", undefined)], callback);
}

export function resolveNaptr(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "NAPTR", "queryNaptr", undefined)], callback);
}

export function resolveNs(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "NS", "queryNs", undefined)], callback);
}

export function resolveSoa(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "SOA", "querySoa", undefined)[0]], callback);
}

export function resolveSrv(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "SRV", "querySrv", undefined)], callback);
}

export function resolveTlsa(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "TLSA", "queryTlsa", undefined)], callback);
}

export function resolveTxt(hostname, callback) {
  callbackifyDns(() => [resolveNativeRecords(hostname, "TXT", "queryTxt", undefined)], callback);
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
  servers = normalizeServers(nextServers ?? []);
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
  constructor(options = {}) {
    this._servers = [...servers];
    this.timeout = options?.timeout;
    this.tries = options?.tries;
  }

  cancel() {}
  getServers() { return [...this._servers]; }
  setServers(nextServers) { this._servers = normalizeServers(nextServers ?? []); }
  resolve(hostname, rrtype = "A", callback = undefined) {
    if (typeof rrtype === "function") {
      callback = rrtype;
      rrtype = "A";
    }
    const type = String(rrtype || "A").toUpperCase();
    if (type === "A") return this.resolve4(hostname, callback);
    if (type === "AAAA") return this.resolve6(hostname, callback);
    if (type === "ANY") return this.resolveAny(hostname, callback);
    if (type === "PTR") return this.resolvePtr(hostname, callback);
    if (type === "CAA") return this.resolveCaa(hostname, callback);
    if (type === "CNAME") return this.resolveCname(hostname, callback);
    if (type === "MX") return this.resolveMx(hostname, callback);
    if (type === "NAPTR") return this.resolveNaptr(hostname, callback);
    if (type === "NS") return this.resolveNs(hostname, callback);
    if (type === "SOA") return this.resolveSoa(hostname, callback);
    if (type === "SRV") return this.resolveSrv(hostname, callback);
    if (type === "TLSA") return this.resolveTlsa(hostname, callback);
    if (type === "TXT") return this.resolveTxt(hostname, callback);
    throw invalidRrtypeError(type);
  }
  resolve4(hostname, options = undefined, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    callbackifyDns(() => [resolveAddressRecords(hostname, 4, options, this)], callback);
  }
  resolve6(hostname, options = undefined, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    callbackifyDns(() => [resolveAddressRecords(hostname, 6, options, this)], callback);
  }
  resolveAny(hostname, callback) { return resolveAnyWithState(hostname, callback, this); }
  resolveCaa(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "CAA", "queryCaa", this)], callback); }
  resolveCname(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "CNAME", "queryCname", this)], callback); }
  resolveMx(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "MX", "queryMx", this)], callback); }
  resolveNaptr(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "NAPTR", "queryNaptr", this)], callback); }
  resolveNs(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "NS", "queryNs", this)], callback); }
  resolvePtr(hostname, callback) { return resolvePtrWithState(hostname, callback, this); }
  resolveSoa(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "SOA", "querySoa", this)[0]], callback); }
  resolveSrv(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "SRV", "querySrv", this)], callback); }
  resolveTlsa(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "TLSA", "queryTlsa", this)], callback); }
  resolveTxt(hostname, callback) { callbackifyDns(() => [resolveNativeRecords(hostname, "TXT", "queryTxt", this)], callback); }
  reverse(ip, callback) {
    callbackifyDns(() => {
      const record = lookupServiceRecord(ip, 0, this);
      return [[record.hostname]];
    }, callback);
  }
}

export class PromisesResolver {
  constructor(options = {}) {
    this._servers = [...servers];
    this.timeout = options?.timeout;
    this.tries = options?.tries;
  }

  cancel() {}
  getServers() { return [...this._servers]; }
  setServers(nextServers) { this._servers = normalizeServers(nextServers ?? []); }
  resolve(hostname, rrtype = "A") { return promiseFromCallback(Resolver.prototype.resolve.bind(this), hostname, rrtype); }
  resolve4(hostname, options = undefined) { return promiseFromCallback(Resolver.prototype.resolve4.bind(this), hostname, options); }
  resolve6(hostname, options = undefined) { return promiseFromCallback(Resolver.prototype.resolve6.bind(this), hostname, options); }
  resolveAny(hostname) { return promiseFromCallback(Resolver.prototype.resolveAny.bind(this), hostname); }
  resolveCaa(hostname) { return promiseFromCallback(Resolver.prototype.resolveCaa.bind(this), hostname); }
  resolveCname(hostname) { return promiseFromCallback(Resolver.prototype.resolveCname.bind(this), hostname); }
  resolveMx(hostname) { return promiseFromCallback(Resolver.prototype.resolveMx.bind(this), hostname); }
  resolveNaptr(hostname) { return promiseFromCallback(Resolver.prototype.resolveNaptr.bind(this), hostname); }
  resolveNs(hostname) { return promiseFromCallback(Resolver.prototype.resolveNs.bind(this), hostname); }
  resolvePtr(hostname) { return promiseFromCallback(Resolver.prototype.resolvePtr.bind(this), hostname); }
  resolveSoa(hostname) { return promiseFromCallback(Resolver.prototype.resolveSoa.bind(this), hostname); }
  resolveSrv(hostname) { return promiseFromCallback(Resolver.prototype.resolveSrv.bind(this), hostname); }
  resolveTlsa(hostname) { return promiseFromCallback(Resolver.prototype.resolveTlsa.bind(this), hostname); }
  resolveTxt(hostname) { return promiseFromCallback(Resolver.prototype.resolveTxt.bind(this), hostname); }
  reverse(ip) { return promiseFromCallback(Resolver.prototype.reverse.bind(this), ip); }
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

// COTTONTAIL-COMPAT: node:dns resolver controls - lookup/getaddrinfo and DNS record queries use native system resolvers; global and per-Resolver server state is validated and passed to native calls, but the current platform resolver backend does not yet issue record queries through caller-selected DNS servers.

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
