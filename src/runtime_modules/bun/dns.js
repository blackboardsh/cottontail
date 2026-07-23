import * as nodeDns from "../node/dns.js";
import * as nodeNet from "../node/net.js";

function normalizeFamily(family) {
  if (family == null || family === "" || family === "any" || (typeof family === "number" && Number.isNaN(family))) return 0;
  if (family === "IPv4" || family === "ipv4") return 4;
  if (family === "IPv6" || family === "ipv6") return 6;
  if (family === 0 || family === 4 || family === 6) return family;
  throw new Error("Invalid options passed to lookup(): InvalidFamily");
}

function normalizeLookupOptions(options) {
  const defaultBackend = process.platform === "darwin" || process.platform === "win32" ? "system" : "c-ares";
  const optionType = typeof options;
  if (optionType === "string" || optionType === "symbol" || optionType === "bigint") {
    throw new Error("Invalid options passed to lookup(): InvalidOptions");
  }
  if (options == null || (optionType !== "object" && optionType !== "function")) {
    return {
      family: 0,
      all: true,
      hints: 0,
      backend: defaultBackend,
      socketType: "stream",
      protocol: "unspecified",
    };
  }

  let backend = options.backend;
  if (backend === "cares" || backend === "c_ares" || backend === "async") backend = "c-ares";
  if (backend === "getaddrinfo") backend = "libc";
  if (backend == null || backend === "") backend = defaultBackend;
  if (backend !== "system" && backend !== "libc" && backend !== "c-ares") {
    throw new Error("Invalid options passed to lookup(): InvalidBackend");
  }

  let socketType = options.socketType;
  if (socketType == null) {
    socketType = "stream";
  } else if (socketType === "" || socketType === 0 || (typeof socketType === "number" && Number.isNaN(socketType))) {
    socketType = "unspecified";
  } else if (socketType === 1) {
    socketType = "stream";
  } else if (socketType === 2) {
    socketType = "dgram";
  } else if (socketType === "tcp") {
    socketType = "stream";
  } else if (socketType === "udp") {
    socketType = "dgram";
  } else if (socketType !== "stream" && socketType !== "dgram") {
    throw new Error("Invalid options passed to lookup(): InvalidSocketType");
  }

  let protocol = options.protocol;
  if (protocol == null || protocol === "" || protocol === 0 || (typeof protocol === "number" && Number.isNaN(protocol))) {
    protocol = "unspecified";
  } else if (protocol === 6) {
    protocol = "tcp";
  } else if (protocol === 17) {
    protocol = "udp";
  } else if (protocol !== "tcp" && protocol !== "udp") {
    throw new Error("Invalid options passed to lookup(): InvalidProtocol");
  }

  let flags = options.flags;
  if (flags === undefined || (typeof flags === "number" && Number.isNaN(flags))) flags = 0;
  const validFlags = nodeDns.ADDRCONFIG | nodeDns.V4MAPPED | nodeDns.ALL;
  if (typeof flags !== "number" || !Number.isFinite(flags) || !Number.isInteger(flags) || flags < 0 || flags > validFlags || (flags & ~validFlags) !== 0) {
    const error = new TypeError(`The "flags" argument is invalid. Received ${flags === null ? "undefined" : typeof flags === "number" ? `type number (${flags})` : `type ${typeof flags} (${String(flags)})`}`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }

  let port = options.port;
  if (port != null && port !== "") {
    if (typeof port !== "number" || Number.isNaN(port)) {
      const error = new RangeError("Invalid port number");
      error.code = "ERR_SOCKET_BAD_PORT";
      throw error;
    }
    const normalizedPort = Math.trunc(port);
    if (!Number.isFinite(port) || normalizedPort < 0 || normalizedPort > 65535) {
      const displayed = port === Infinity ? 9223372036854775807 : port === -Infinity ? -9223372036854775808 : normalizedPort;
      const error = new RangeError(`Port number out of range: ${displayed}`);
      error.code = "ERR_SOCKET_BAD_PORT";
      throw error;
    }
    port = normalizedPort;
  }

  return {
    family: normalizeFamily(options.family),
    all: true,
    hints: flags,
    backend,
    socketType,
    protocol,
    port,
  };
}

function toBunDnsError(error) {
  const rawCode = String(error?.code || "ENOTFOUND").replace(/^DNS_/, "");
  const syscall = error?.syscall ?? "getaddrinfo";
  const hostname = error?.hostname == null ? undefined : String(error.hostname);
  const out = new Error(hostname === undefined ? `${syscall} ${rawCode}` : `${syscall} ${rawCode} ${hostname}`);
  out.name = "DNSException";
  out.code = `DNS_${rawCode}`;
  out.errno = ({
    ENODATA: 1,
    EFORMERR: 2,
    ESERVFAIL: 3,
    ENOTFOUND: 4,
    ENOTIMP: 5,
    EREFUSED: 6,
    ETIMEOUT: 12,
    ECONNREFUSED: 11,
  })[rawCode] ?? error?.errno ?? 4;
  out.syscall = syscall;
  if (hostname !== undefined) out.hostname = hostname;
  return out;
}

function missingArgs(method, expected, received) {
  const error = new TypeError(`Not enough arguments to '${method}'. Expected ${expected}, got ${received}.`);
  error.code = "ERR_MISSING_ARGS";
  return error;
}

function invalidString(method, property, nonEmpty = false) {
  const error = new TypeError(`Expected ${property} to be a ${nonEmpty ? "non-empty " : ""}string for '${method}'.`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function validateName(method, hostname, allowEmpty = false) {
  if (typeof hostname !== "string") throw invalidString(method, method === "resolve" ? "name" : "hostname");
  if (!allowEmpty && hostname.length === 0) throw invalidString(method, method === "resolve" ? "name" : "hostname", true);
}

function translatePromise(promise, hostname = undefined) {
  return Promise.resolve(promise).catch((error) => {
    if (hostname != null && error != null && typeof error === "object" && error.hostname == null) {
      error.hostname = String(hostname);
    }
    throw toBunDnsError(error);
  });
}

function systemLookup(hostname, lookupOptions) {
  return new Promise((resolve, reject) => {
    nodeDns.lookup(hostname, lookupOptions, (error, records) => {
      if (error) reject(error);
      else resolve(Array.from(records ?? []).map((record) => ({
        address: String(record.address),
        family: Number(record.family),
        ttl: Number(record.ttl ?? 0),
      })));
    });
  });
}

async function caresLookup(hostname, lookupOptions) {
  const families = lookupOptions.family === 4 ? [4] : lookupOptions.family === 6 ? [6] : [6, 4];
  const results = await Promise.allSettled(families.map((family) =>
    family === 4
      ? nodeDns.promises.resolve4(hostname, { ttl: true })
      : nodeDns.promises.resolve6(hostname, { ttl: true })));
  const records = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result.status !== "fulfilled") continue;
    const family = families[index];
    for (const record of result.value) {
      records.push({ address: String(record.address), family, ttl: Number(record.ttl ?? 0) });
    }
  }
  if (records.length > 0) return records;

  // c-ares also consults local hosts files for names such as localhost.
  return systemLookup(hostname, lookupOptions);
}

function lookup(hostname, options = {}) {
  if (arguments.length < 1) throw missingArgs("lookup", 2, arguments.length);
  if (typeof hostname !== "string") throw invalidString("lookup", "hostname");
  if (hostname.length === 0) throw invalidString("lookup", "hostname", true);

  const lookupOptions = normalizeLookupOptions(options);
  if ((lookupOptions.socketType === "stream" && lookupOptions.protocol === "udp") ||
      (lookupOptions.socketType === "dgram" && lookupOptions.protocol === "tcp")) {
    return translatePromise(Promise.reject(Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
      syscall: "getaddrinfo",
    })), hostname);
  }

  let lookupHostname = hostname;
  if (lookupOptions.backend === "c-ares") {
    if (hostname.endsWith(".localhost")) {
      lookupHostname = "localhost";
      lookupOptions.backend = "system";
    } else if (hostname === "localhost" || hostname.endsWith(".local") || nodeNet.isIPv6(hostname)) {
      lookupOptions.backend = "system";
    }
  }
  const promise = lookupOptions.backend === "c-ares"
    ? caresLookup(lookupHostname, lookupOptions)
    : systemLookup(lookupHostname, lookupOptions);
  return translatePromise(promise, hostname);
}

const resolveMethods = {
  A: (hostname) => nodeDns.promises.resolve4(hostname, { ttl: true }),
  AAAA: (hostname) => nodeDns.promises.resolve6(hostname, { ttl: true }),
  ANY: (hostname) => nodeDns.promises.resolveAny(hostname),
  CAA: (hostname) => nodeDns.promises.resolveCaa(hostname),
  CNAME: (hostname) => nodeDns.promises.resolveCname(hostname),
  MX: (hostname) => nodeDns.promises.resolveMx(hostname),
  NS: (hostname) => nodeDns.promises.resolveNs(hostname),
  PTR: (hostname) => nodeDns.promises.resolvePtr(hostname),
  SOA: (hostname) => nodeDns.promises.resolveSoa(hostname),
  SRV: (hostname) => nodeDns.promises.resolveSrv(hostname),
  TXT: (hostname) => nodeDns.promises.resolveTxt(hostname),
};

function resolve(hostname, record = "A") {
  if (arguments.length < 1) throw missingArgs("resolve", 3, arguments.length);
  validateName("resolve", hostname);
  if (record == null || typeof record !== "string" || record.length === 0) record = "A";
  const method = resolveMethods[record] ?? resolveMethods[record.toLowerCase() === record ? record.toUpperCase() : ""];
  if (method == null) {
    const error = new TypeError(`The property "record" is invalid. Expected one of: A, AAAA, ANY, CAA, CNAME, MX, NS, PTR, SOA, SRV, TXT, received type string ('${record}')`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  return translatePromise(method(hostname), hostname);
}

function resolveWith(method, hostname, allowEmpty, received) {
  if (received < 1) throw missingArgs(method, 1, received);
  validateName(method, hostname, allowEmpty);
  return translatePromise(nodeDns.promises[method](hostname), hostname);
}

function resolveSrv(hostname) { return resolveWith("resolveSrv", hostname, false, arguments.length); }
function resolveTxt(hostname) { return resolveWith("resolveTxt", hostname, false, arguments.length); }
function resolveSoa(hostname) { return resolveWith("resolveSoa", hostname, true, arguments.length); }
function resolveNaptr(hostname) { return resolveWith("resolveNaptr", hostname, false, arguments.length); }
function resolveMx(hostname) { return resolveWith("resolveMx", hostname, false, arguments.length); }
function resolveCaa(hostname) { return resolveWith("resolveCaa", hostname, false, arguments.length); }
function resolveNs(hostname) { return resolveWith("resolveNs", hostname, true, arguments.length); }
function resolvePtr(hostname) { return resolveWith("resolvePtr", hostname, false, arguments.length); }
function resolveCname(hostname) { return resolveWith("resolveCname", hostname, false, arguments.length); }
function resolveAny(hostname) { return resolveWith("resolveAny", hostname, false, arguments.length); }

function reverse(ip) {
  if (arguments.length < 1) throw missingArgs("reverse", 1, arguments.length);
  if (typeof ip !== "string") throw invalidString("reverse", "ip");
  if (ip.length === 0) throw invalidString("reverse", "ip", true);
  return translatePromise(nodeDns.promises.reverse(ip), ip);
}

function lookupService(address, port) {
  if (arguments.length < 2) throw missingArgs("lookupService", 2, arguments.length);
  if (typeof address !== "string") throw invalidString("lookupService", "address");
  if (address.length === 0) throw invalidString("lookupService", "address", true);
  const promise = nodeDns.promises.lookupService(address, port).then(({ hostname, service }) => [hostname, service]);
  return translatePromise(promise, address);
}

function setServers(nextServers) {
  if (arguments.length < 1) throw missingArgs("setServers", 1, arguments.length);
  if (!Array.isArray(nextServers)) {
    const error = new TypeError("Expected servers to be a array for 'setServers'.");
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  const normalized = nextServers.map((triple) => {
    if (!Array.isArray(triple)) {
      const error = new TypeError("Expected triple to be a array for 'setServers'.");
      error.code = "ERR_INVALID_ARG_TYPE";
      throw error;
    }
    const family = Number(triple[0]);
    const address = String(triple[1]);
    const port = Number(triple[2]);
    if ((family !== 4 && family !== 6) || nodeNet.isIP(address) !== family) {
      const error = new TypeError(family !== 4 && family !== 6 ? "Invalid address family" : `Invalid IP address: "${address}"`);
      error.code = family !== 4 && family !== 6 ? "ERR_INVALID_ARG_VALUE" : "ERR_INVALID_IP_ADDRESS";
      throw error;
    }
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      const error = new RangeError(`Port should be >= 0 and < 65536. Received ${port}.`);
      error.code = "ERR_SOCKET_BAD_PORT";
      throw error;
    }
    if (port === 53) return address;
    return family === 6 ? `[${address}]:${port}` : `${address}:${port}`;
  });
  nodeDns.setServers(normalized);
}

const resolverHookKey = Symbol.for("cottontail.runtime.bun-dns-resolver-hook");
const cacheState = globalThis[Symbol.for("cottontail.runtime.dns-cache")];

function installResolverCache() {
  if (globalThis[resolverHookKey] != null || typeof cottontail.dnsLookup !== "function") return;
  if (typeof cacheState?.resolveForNetwork !== "function") return;

  const state = {
    nativeLookup: cottontail.dnsLookup,
    nativeLookupAsync: cottontail.dnsLookupAsync,
    resolving: 0,
  };
  globalThis[resolverHookKey] = state;

  cottontail.dnsLookup = function bunCachedDnsLookup(hostname, family = 0, nativeOptions = undefined) {
    const normalizedFamily = Number(family) || 0;
    if (state.resolving > 0 || nativeOptions !== undefined || normalizedFamily !== 0) {
      return state.nativeLookup(hostname, normalizedFamily, nativeOptions);
    }

    state.resolving += 1;
    try {
      const records = cacheState.resolveForNetwork(String(hostname), 0, false);
      return records;
    } finally {
      state.resolving -= 1;
    }
  };

  if (typeof state.nativeLookupAsync === "function") {
    cottontail.dnsLookupAsync = function bunCachedDnsLookupAsync(hostname, family = 0, hints = 0, callback) {
      const normalizedFamily = Number(family) || 0;
      if (state.resolving > 0 || Number(hints) !== 0 || normalizedFamily !== 0) {
        return state.nativeLookupAsync(hostname, normalizedFamily, hints, callback);
      }

      state.resolving += 1;
      let records;
      let failure;
      try {
        records = cacheState.resolveForNetwork(String(hostname), 0, false);
      } catch (error) {
        failure = error;
      } finally {
        state.resolving -= 1;
      }
      queueMicrotask(() => {
        if (failure) {
          callback(failure.code ?? "ENOTFOUND", undefined, failure.message ?? String(failure));
        } else {
          callback(null, records, undefined);
        }
      });
      return undefined;
    };
  }
}

installResolverCache();

export const dns = {
  lookup,
  resolve,
  resolveSrv,
  resolveTxt,
  resolveSoa,
  resolveNaptr,
  resolveMx,
  resolveCaa,
  resolveNs,
  resolvePtr,
  resolveCname,
  resolveAny,
  getServers: nodeDns.getServers,
  setServers,
  reverse,
  lookupService,
  prefetch: cacheState.prefetch,
  getCacheStats: cacheState.getCacheStats,
  ADDRCONFIG: nodeDns.ADDRCONFIG,
  ALL: nodeDns.ALL,
  V4MAPPED: nodeDns.V4MAPPED,
};

export default dns;
