import { isIP } from "./net.js";
import { readFileSync } from "./fs.js";
import { Buffer } from "./buffer.js";
import { createSocket } from "./dgram.js";

const nativeDnsLookup = cottontail.dnsLookup;

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

const SUPPORTED_RRTYPES = new Set([
  "A", "AAAA", "ANY", "CAA", "CNAME", "MX", "NAPTR", "NS", "PTR", "SOA", "SRV", "TLSA", "TXT",
]);

let defaultResultOrder = "verbatim";
let servers = [];
let serversConfigured = false;
let cachedSystemServers = null;

function systemServers() {
  if (cachedSystemServers != null) return cachedSystemServers;
  const found = [];
  try {
    const content = String(readFileSync("/etc/resolv.conf", "utf8"));
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && parts[0] === "nameserver") found.push(parts[1]);
    }
  } catch {}
  cachedSystemServers = found;
  return cachedSystemServers;
}

function effectiveServers() {
  return serversConfigured ? [...servers] : [...systemServers()];
}
const dnsCacheStateKey = Symbol.for("cottontail.runtime.dns-cache");
const dnsCacheState = globalThis[dnsCacheStateKey] ??= {
  entries: new Map(),
  cacheHitsCompleted: 0,
  cacheHitsInflight: 0,
  cacheMisses: 0,
  errors: 0,
  totalCount: 0,
  resolveForNetwork: null,
};

function makeDnsError(error, syscall, hostname = undefined, code = NOTFOUND) {
  const effectiveCode = typeof error?.code === "string" ? error.code : code;
  const host = hostname == null ? undefined : String(hostname);
  const out = new Error(host == null ? `${syscall} ${effectiveCode}` : `${syscall} ${effectiveCode} ${host}`);
  out.code = effectiveCode;
  out.errno = effectiveCode;
  out.syscall = syscall;
  if (host != null) out.hostname = host;
  return out;
}

function invalidRrtypeError(type) {
  const error = new TypeError(`The argument 'rrtype' is invalid. Received ${JSON.stringify(String(type))}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function describeReceived(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an instance of Array";
  if (typeof value === "object") return `an instance of ${value.constructor?.name ?? "Object"}`;
  if (typeof value === "string") return `type string ('${value}')`;
  return `type ${typeof value} (${String(value)})`;
}

function invalidArgType(name, expected, value) {
  const error = new TypeError(`The "${name}" argument must be ${expected}. Received ${describeReceived(value)}`);
  error.code = "ERR_INVALID_ARG_TYPE";
  return error;
}

function missingArgs(names) {
  const quoted = names.map((name) => `"${name}"`);
  const list = quoted.length === 1
    ? quoted[0]
    : quoted.length === 2
      ? `${quoted[0]} and ${quoted[1]}`
      : `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
  const error = new TypeError(`The ${list} arguments must be specified`);
  error.code = "ERR_MISSING_ARGS";
  return error;
}

function validateCallback(callback) {
  if (typeof callback !== "function") throw invalidArgType("callback", "of type function", callback);
}

function validateLookupHostname(hostname) {
  if (hostname && typeof hostname !== "string") {
    throw invalidArgType("hostname", "of type string", hostname);
  }
}

function validateResolveHostname(hostname) {
  if (typeof hostname !== "string") throw invalidArgType("name", "of type string", hostname);
}

function normalizeRrtype(rrtype) {
  if (typeof rrtype !== "string") throw invalidArgType("rrtype", "of type string", rrtype);
  const type = rrtype.toUpperCase();
  if (!SUPPORTED_RRTYPES.has(type)) throw invalidRrtypeError(type);
  return type;
}

function invalidServerError(server) {
  const error = new TypeError(`Invalid IP address: ${server}`);
  error.code = "ERR_INVALID_IP_ADDRESS";
  return error;
}

function validatePort(port, server) {
  if (port == null) return;
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
  const family = isIP(host);
  if (family === 0) throw invalidServerError(server);
  validatePort(port, server);
  if (port == null || Number(port) === 53) return host;
  return family === 6 ? `[${host}]:${Number(port)}` : `${host}:${Number(port)}`;
}

function normalizeServers(nextServers) {
  if (!Array.isArray(nextServers)) throw invalidArgType("servers", "an instance of Array", nextServers);
  // Array#map skips holes and observes a getter that shortens the source array.
  return nextServers.map(normalizeServer).filter(() => true);
}

function callbackifyDns(work, callback) {
  validateCallback(callback);
  queueMicrotask(() => {
    let values;
    try {
      values = work();
    } catch (error) {
      callback(error);
      return;
    }
    callback(null, ...values);
  });
}

function normalizeLookupOptions(options = {}) {
  if (options == null) options = {};
  if (typeof options === "number") {
    if (options !== 0 && options !== 4 && options !== 6) {
      const error = new TypeError(`The argument 'family' must be one of: 0, 4, 6. Received ${options}`);
      error.code = "ERR_INVALID_ARG_VALUE";
      throw error;
    }
    return { family: options, all: false, order: defaultResultOrder };
  }
  if (typeof options !== "object") {
    const error = new TypeError(`The "options" argument must be of type object or integer. Received type ${typeof options}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  let family = options.family ?? 0;
  if (family === "IPv4") family = 4;
  else if (family === "IPv6") family = 6;
  if (family !== 0 && family !== 4 && family !== 6) {
    const error = new TypeError(`The property 'options.family' must be one of: 0, 4, 6. Received ${JSON.stringify(family)}`);
    error.code = typeof family === "string" ? "ERR_INVALID_ARG_TYPE" : "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  let hints = options.hints ?? 0;
  if (typeof hints !== "number") throw invalidArgType("options.hints", "of type number", hints);
  hints = hints >>> 0;
  const validHints = ADDRCONFIG | V4MAPPED | ALL;
  if ((hints & ~validHints) !== 0) {
    const error = new TypeError(`The argument 'hints' is invalid. Received ${hints}`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  let order = options.order;
  if (order == null) {
    order = options.verbatim == null ? defaultResultOrder : options.verbatim ? "verbatim" : "ipv4first";
  }
  if (order !== "verbatim" && order !== "ipv4first" && order !== "ipv6first") {
    const error = new TypeError(`The property 'options.order' must be one of: 'verbatim', 'ipv4first', 'ipv6first'. Received ${JSON.stringify(order)}`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  return {
    family,
    all: Boolean(options.all),
    hints,
    order,
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

function configuredQueryServers(resolverState = undefined) {
  if (resolverState === null) return [];
  if (resolverState == null) return serversConfigured ? [...servers] : [];
  return resolverState._serversExplicit === true ? [...resolverState._servers] : [];
}

function parseServerAddress(server) {
  const text = String(server);
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return {
      address: text.slice(1, end),
      family: 6,
      port: Number(text.slice(end + 2)),
    };
  }
  if (isIP(text) === 6) return { address: text, family: 6, port: 53 };
  const colon = text.lastIndexOf(":");
  if (colon > 0) {
    return {
      address: text.slice(0, colon),
      family: 4,
      port: Number(text.slice(colon + 1)),
    };
  }
  return { address: text, family: 4, port: 53 };
}

const dnsRecordTypes = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  NAPTR: 35,
  TLSA: 52,
  CAA: 257,
  ANY: 255,
};
const dnsRecordNames = new Map(Object.entries(dnsRecordTypes).map(([name, type]) => [type, name]));
let nextDnsQueryId = Math.floor(Math.random() * 0xffff);

function encodeDnsName(hostname) {
  const labels = String(hostname).replace(/\.$/, "").split(".").filter(Boolean);
  const chunks = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw makeDnsError("DNS label is too long", "query", hostname, BADNAME);
    chunks.push(Buffer.from([bytes.length]), bytes);
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function makeDnsQuery(hostname, type) {
  const questionName = encodeDnsName(hostname);
  const packet = Buffer.alloc(12 + questionName.length + 4);
  nextDnsQueryId = (nextDnsQueryId + 1) & 0xffff;
  packet.writeUInt16BE(nextDnsQueryId, 0);
  packet.writeUInt16BE(0x0100, 2);
  packet.writeUInt16BE(1, 4);
  questionName.copy(packet, 12);
  const tail = 12 + questionName.length;
  packet.writeUInt16BE(dnsRecordTypes[type], tail);
  packet.writeUInt16BE(1, tail + 2);
  return { id: nextDnsQueryId, packet };
}

function readDnsName(packet, start, seen = new Set()) {
  let offset = start;
  let nextOffset = start;
  let jumped = false;
  const labels = [];
  for (;;) {
    if (offset >= packet.length) throw new Error("Invalid DNS name");
    const length = packet[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= packet.length) throw new Error("Invalid DNS name pointer");
      const pointer = ((length & 0x3f) << 8) | packet[offset + 1];
      if (seen.has(pointer)) throw new Error("Recursive DNS name pointer");
      seen.add(pointer);
      if (!jumped) nextOffset = offset + 2;
      offset = pointer;
      jumped = true;
      continue;
    }
    if (length === 0) {
      if (!jumped) nextOffset = offset + 1;
      break;
    }
    if ((length & 0xc0) !== 0 || offset + 1 + length > packet.length) throw new Error("Invalid DNS label");
    labels.push(packet.toString("utf8", offset + 1, offset + 1 + length));
    offset += length + 1;
    if (!jumped) nextOffset = offset;
  }
  return { name: labels.join("."), nextOffset };
}

function formatIpv6(bytes) {
  const groups = [];
  for (let index = 0; index < 16; index += 2) groups.push(((bytes[index] << 8) | bytes[index + 1]).toString(16));
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < groups.length && groups[end] === "0") end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestLength < 2) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

function readCharacterStrings(packet, start, end) {
  const entries = [];
  let offset = start;
  while (offset < end) {
    const length = packet[offset++];
    if (offset + length > end) throw new Error("Invalid DNS character string");
    entries.push(packet.toString("utf8", offset, offset + length));
    offset += length;
  }
  return entries;
}

function parseDnsRecordData(packet, recordType, dataOffset, dataEnd, ttl, anyQuery) {
  const type = dnsRecordNames.get(recordType);
  if (type == null || type === "ANY") return undefined;

  let record;
  if (type === "A") {
    if (dataEnd - dataOffset !== 4) throw new Error("Invalid A record");
    record = {
      address: `${packet[dataOffset]}.${packet[dataOffset + 1]}.${packet[dataOffset + 2]}.${packet[dataOffset + 3]}`,
      ttl,
    };
  } else if (type === "AAAA") {
    if (dataEnd - dataOffset !== 16) throw new Error("Invalid AAAA record");
    record = { address: formatIpv6(packet.subarray(dataOffset, dataEnd)), ttl };
  } else if (type === "NS" || type === "CNAME" || type === "PTR") {
    const value = readDnsName(packet, dataOffset).name;
    record = anyQuery ? { value } : value;
  } else if (type === "MX") {
    if (dataOffset + 2 > dataEnd) throw new Error("Invalid MX record");
    record = {
      exchange: readDnsName(packet, dataOffset + 2).name,
      priority: packet.readUInt16BE(dataOffset),
    };
  } else if (type === "TXT") {
    const entries = readCharacterStrings(packet, dataOffset, dataEnd);
    record = anyQuery ? { entries } : entries;
  } else if (type === "SOA") {
    const primary = readDnsName(packet, dataOffset);
    const mailbox = readDnsName(packet, primary.nextOffset);
    if (mailbox.nextOffset + 20 > dataEnd) throw new Error("Invalid SOA record");
    record = {
      nsname: primary.name,
      hostmaster: mailbox.name,
      serial: packet.readUInt32BE(mailbox.nextOffset),
      refresh: packet.readUInt32BE(mailbox.nextOffset + 4),
      retry: packet.readUInt32BE(mailbox.nextOffset + 8),
      expire: packet.readUInt32BE(mailbox.nextOffset + 12),
      minttl: packet.readUInt32BE(mailbox.nextOffset + 16),
    };
  } else if (type === "SRV") {
    if (dataOffset + 6 > dataEnd) throw new Error("Invalid SRV record");
    record = {
      priority: packet.readUInt16BE(dataOffset),
      weight: packet.readUInt16BE(dataOffset + 2),
      port: packet.readUInt16BE(dataOffset + 4),
      name: readDnsName(packet, dataOffset + 6).name,
    };
  } else if (type === "NAPTR") {
    if (dataOffset + 4 > dataEnd) throw new Error("Invalid NAPTR record");
    let offset = dataOffset + 4;
    const fields = [];
    for (let index = 0; index < 3; index += 1) {
      if (offset >= dataEnd) throw new Error("Invalid NAPTR record");
      const length = packet[offset++];
      if (offset + length > dataEnd) throw new Error("Invalid NAPTR record");
      fields.push(packet.toString("utf8", offset, offset + length));
      offset += length;
    }
    record = {
      flags: fields[0],
      service: fields[1],
      regexp: fields[2],
      replacement: readDnsName(packet, offset).name,
      order: packet.readUInt16BE(dataOffset),
      preference: packet.readUInt16BE(dataOffset + 2),
    };
  } else if (type === "CAA") {
    if (dataOffset + 2 > dataEnd) throw new Error("Invalid CAA record");
    const critical = packet[dataOffset];
    const tagLength = packet[dataOffset + 1];
    if (dataOffset + 2 + tagLength > dataEnd) throw new Error("Invalid CAA record");
    const tag = packet.toString("ascii", dataOffset + 2, dataOffset + 2 + tagLength);
    record = {
      critical,
      [tag]: packet.toString("utf8", dataOffset + 2 + tagLength, dataEnd),
    };
  } else if (type === "TLSA") {
    if (dataOffset + 3 > dataEnd) throw new Error("Invalid TLSA record");
    record = {
      certUsage: packet[dataOffset],
      selector: packet[dataOffset + 1],
      match: packet[dataOffset + 2],
      data: Uint8Array.from(packet.subarray(dataOffset + 3, dataEnd)).buffer,
    };
  }

  if (record == null) return undefined;
  if (anyQuery && typeof record === "object" && !Array.isArray(record)) record.type = type;
  return record;
}

function parseDnsResponse(packet, id, hostname, type, syscall) {
  if (packet.length < 12 || packet.readUInt16BE(0) !== id) return null;
  const flags = packet.readUInt16BE(2);
  const responseCode = flags & 0x0f;
  if (responseCode !== 0) {
    const codes = [undefined, FORMERR, SERVFAIL, NOTFOUND, NOTIMP, REFUSED];
    throw makeDnsError("DNS query failed", syscall, hostname, codes[responseCode] ?? SERVFAIL);
  }
  const questionCount = packet.readUInt16BE(4);
  const answerCount = packet.readUInt16BE(6);
  let offset = 12;
  for (let index = 0; index < questionCount; index += 1) {
    offset = readDnsName(packet, offset).nextOffset + 4;
  }

  const records = [];
  for (let index = 0; index < answerCount; index += 1) {
    offset = readDnsName(packet, offset).nextOffset;
    if (offset + 10 > packet.length) throw new Error("Invalid DNS record header");
    const recordType = packet.readUInt16BE(offset);
    const ttl = packet.readUInt32BE(offset + 4);
    const dataLength = packet.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    const dataEnd = dataOffset + dataLength;
    if (dataEnd > packet.length) throw new Error("Invalid DNS record data");

    if (type === "ANY" || recordType === dnsRecordTypes[type]) {
      const record = parseDnsRecordData(packet, recordType, dataOffset, dataEnd, ttl, type === "ANY");
      if (record !== undefined) records.push(record);
    }
    offset = dataEnd;
  }
  if (records.length === 0) throw makeDnsError("no DNS records found", syscall, hostname, NODATA);
  return records;
}

function queryDnsServer(server, hostname, type, syscall, timeout, resolverState = undefined) {
  const target = parseServerAddress(server);
  const query = makeDnsQuery(hostname, type);
  return new Promise((resolvePromise, reject) => {
    const socket = createSocket(target.family === 6 ? "udp6" : "udp4");
    const pendingQueries = resolverState?._pendingQueries;
    let settled = false;
    let cancelQuery;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelQuery != null) pendingQueries?.delete(cancelQuery);
      try { socket.close(); } catch {}
      if (error) reject(error);
      else resolvePromise(value);
    };
    const timer = setTimeout(() => finish(makeDnsError("DNS query timed out", syscall, hostname, TIMEOUT)), timeout);
    cancelQuery = () => finish(makeDnsError("DNS query cancelled", syscall, hostname, CANCELLED));
    pendingQueries?.add(cancelQuery);
    socket.on("error", (error) => finish(makeDnsError(error, syscall, hostname, SERVFAIL)));
    socket.on("message", (packet) => {
      try {
        const records = parseDnsResponse(packet, query.id, hostname, type, syscall);
        if (records != null) finish(null, records);
      } catch (error) {
        finish(error?.code ? error : makeDnsError(error, syscall, hostname, BADRESP));
      }
    });
    const localAddress = target.family === 6
      ? resolverState?._localAddress6 ?? "::"
      : resolverState?._localAddress4 ?? "0.0.0.0";
    socket.bind(0, localAddress, () => {
      socket.send(query.packet, target.port, target.address, (error) => {
        if (error) finish(makeDnsError(error, syscall, hostname, SERVFAIL));
      });
    });
  });
}

async function queryConfiguredDns(hostname, type, syscall, resolverState) {
  const queryServers = configuredQueryServers(resolverState);
  const timeout = Number(resolverState?.timeout) > 0 ? Number(resolverState.timeout) : 2000;
  const tries = Number(resolverState?.tries) > 0 ? Math.trunc(Number(resolverState.tries)) : 1;
  let lastError;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    for (const server of queryServers) {
      try {
        return await queryDnsServer(server, hostname, type, syscall, timeout, resolverState);
      } catch (error) {
        if (error?.code === CANCELLED) throw error;
        lastError = error;
      }
    }
  }
  throw lastError ?? makeDnsError("No DNS servers configured", syscall, hostname, SERVFAIL);
}

function callbackifyDnsAsync(work, callback) {
  validateCallback(callback);
  queueMicrotask(() => {
    Promise.resolve().then(work).then(
      (values) => callback(null, ...values),
      (error) => callback(error),
    );
  });
}

function lookupRecords(hostname, family = 0, order = defaultResultOrder, resolverState = null) {
  if (hostname == null || String(hostname) === "") return [{ address: null, family: 4 }];
  if (typeof nativeDnsLookup !== "function") throw makeDnsError("native DNS lookup is unavailable", "getaddrinfo", hostname);
  try {
    const nativeOptions = resolverNativeOptions(resolverState);
    const records = Array.from((nativeOptions == null
      ? nativeDnsLookup(String(hostname), Number(family) || 0)
      : nativeDnsLookup(String(hostname), Number(family) || 0, nativeOptions)) ?? [])
      .map((record) => ({ address: String(record.address), family: Number(record.family) }))
      .filter((record) => (record.family === 4 || record.family === 6) && record.address);
    if (records.length === 0) throw makeDnsError("no DNS records found", "getaddrinfo", hostname);
    return orderedRecords(records, order);
  } catch (error) {
    throw makeDnsError(error, "getaddrinfo", hostname);
  }
}

const DNS_CACHE_MAX_ENTRIES = 256;

function networkCacheTtlMs() {
  const configured = Number(globalThis.process?.env?.BUN_CONFIG_DNS_TIME_TO_LIVE_SECONDS ?? 30);
  return Math.max(0, Number.isFinite(configured) ? configured : 30) * 1000;
}

function pruneNetworkCache(now) {
  const ttl = networkCacheTtlMs();
  for (const [key, entry] of dnsCacheState.entries) {
    if (ttl === 0 || now - entry.createdAt > ttl) dnsCacheState.entries.delete(key);
  }
}

function resolveForNetwork(hostname, port = 0, preload = false) {
  const host = String(hostname);
  const now = Date.now();
  dnsCacheState.totalCount += 1;
  pruneNetworkCache(now);

  const existing = dnsCacheState.entries.get(host);
  if (existing) {
    // Bun preloads an existing entry without counting it as a consumer hit.
    if (!preload) {
      if (existing.records) dnsCacheState.cacheHitsCompleted += 1;
      else dnsCacheState.cacheHitsInflight += 1;
    }
    if (existing.records) return existing.records.map((record) => ({ ...record }));
    if (existing.error) throw existing.error;
    return [];
  }

  dnsCacheState.cacheMisses += 1;
  while (dnsCacheState.entries.size >= DNS_CACHE_MAX_ENTRIES) {
    const oldest = dnsCacheState.entries.keys().next().value;
    if (oldest === undefined) break;
    dnsCacheState.entries.delete(oldest);
  }
  const entry = { createdAt: now, port: Number(port) || 0, records: null, error: null };
  dnsCacheState.entries.set(host, entry);
  try {
    entry.records = lookupRecords(host, 0, defaultResultOrder, null);
    return entry.records.map((record) => ({ ...record }));
  } catch (error) {
    entry.error = error;
    dnsCacheState.errors += 1;
    dnsCacheState.entries.delete(host);
    throw error;
  }
}

dnsCacheState.resolveForNetwork = resolveForNetwork;

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
  const type = family === 6 ? "AAAA" : "A";
  const records = resolveNativeRecords(hostname, type, `query${type}`, resolverState);
  return ttl
    ? records.map((record) => ({ address: String(record.address), ttl: Number(record.ttl) }))
    : records.map((record) => String(record.address));
}

async function resolveAddressRecordsAsync(hostname, family, options = undefined, resolverState = undefined) {
  if (configuredQueryServers(resolverState).length === 0) {
    return resolveAddressRecords(hostname, family, options, resolverState);
  }
  const type = family === 6 ? "AAAA" : "A";
  const records = await queryConfiguredDns(hostname, type, `query${type}`, resolverState);
  const ttl = typeof options === "object" && options != null && options.ttl === true;
  return ttl ? records.map((record) => ({ address: record.address, ttl: record.ttl })) : records.map((record) => record.address);
}

function resolveNativeRecords(hostname, type, syscall = `query${type[0]}${type.slice(1).toLowerCase()}`, resolverState = undefined) {
  if (typeof cottontail.dnsResolveRecords !== "function") throw makeDnsError("native DNS record resolver is unavailable", syscall, hostname);
  try {
    const nativeOptions = resolverNativeOptions(resolverState);
    const records = Array.from((nativeOptions == null
      ? cottontail.dnsResolveRecords(String(hostname), type)
      : cottontail.dnsResolveRecords(String(hostname), type, nativeOptions)) ?? []);
    if (records.length === 0) throw makeDnsError("no DNS records found", syscall, hostname, NODATA);
    if (type === "NAPTR") {
      // c-ares (and Node) present empty regexp/replacement fields as "", not the DNS root ".".
      return records.map((record) => ({
        ...record,
        regexp: record.regexp === "." ? "" : record.regexp,
        replacement: record.replacement === "." ? "" : record.replacement,
      }));
    }
    return records;
  } catch (error) {
    throw makeDnsError(error, syscall, hostname);
  }
}

async function resolveNativeRecordsAsync(hostname, type, syscall, resolverState = undefined) {
  if (configuredQueryServers(resolverState).length > 0) {
    return queryConfiguredDns(hostname, type, syscall, resolverState);
  }
  return resolveNativeRecords(hostname, type, syscall, resolverState);
}

function resolveRecordsWithState(hostname, type, syscall, callback, resolverState = undefined, first = false) {
  callbackifyDnsAsync(async () => {
    const records = await resolveNativeRecordsAsync(hostname, type, syscall, resolverState);
    return [first ? records[0] : records];
  }, callback);
}

function ptrNameToAddress(name) {
  const text = String(name).toLowerCase();
  if (text.endsWith(".in-addr.arpa")) {
    const parts = text.slice(0, -".in-addr.arpa".length).split(".").filter(Boolean).reverse();
    if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) return parts.join(".");
  }
  return name;
}

function ipv6Groups(address) {
  let text = String(address).toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  let [leftText, rightText] = text.split("::");
  if (rightText === undefined) {
    rightText = "";
  }
  const normalizeParts = (value) => {
    const parts = value ? value.split(":") : [];
    const last = parts.at(-1);
    if (last?.includes(".")) {
      const bytes = last.split(".").map(Number);
      parts.splice(parts.length - 1, 1, ((bytes[0] << 8) | bytes[1]).toString(16), ((bytes[2] << 8) | bytes[3]).toString(16));
    }
    return parts;
  };
  const left = normalizeParts(leftText);
  const right = normalizeParts(rightText);
  const missing = 8 - left.length - right.length;
  return [...left, ...Array(Math.max(0, missing)).fill("0"), ...right].map(part => part.padStart(4, "0"));
}

function reverseNameForIp(ip) {
  const family = isIP(ip);
  if (family === 4) return `${String(ip).split(".").reverse().join(".")}.in-addr.arpa`;
  if (family === 6) return `${ipv6Groups(ip).join("").split("").reverse().join(".")}.ip6.arpa`;
  throw invalidLocalAddress(ip);
}

function reverseWithState(ip, callback, resolverState = undefined) {
  callbackifyDnsAsync(async () => {
    const queryName = reverseNameForIp(ip);
    try {
      return [await resolveNativeRecordsAsync(queryName, "PTR", "getHostByAddr", resolverState)];
    } catch (error) {
      if (error != null && typeof error === "object") error.hostname = String(ip);
      if (configuredQueryServers(resolverState).length > 0 || error?.code === CANCELLED) throw error;
      const record = lookupServiceRecord(ip, 0, resolverState);
      return [[record.hostname]];
    }
  }, callback);
}

function lookupWithNormalizedOptions(hostname, normalized, callback) {
  validateCallback(callback);
  if (!hostname) {
    // Deprecated behavior (DEP0118): falsy hostname resolves to null address.
    queueMicrotask(() => {
      if (normalized.all) callback(null, []);
      else callback(null, null, normalized.family === 6 ? 6 : 4);
    });
    return;
  }
  callbackifyDns(() => {
    const records = lookupRecords(hostname, normalized.family, normalized.order, null);
    if (normalized.all) return [records];
    const first = records[0];
    return [first.address, first.family];
  }, callback);
}

export function lookup(hostname, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  validateLookupHostname(hostname);
  const normalized = normalizeLookupOptions(options);
  return lookupWithNormalizedOptions(hostname, normalized, callback);
}

export function prefetch(hostname, port = 443) {
  if (arguments.length === 0) {
    const error = new TypeError("Not enough arguments to 'prefetch'. Expected 1, got 0.");
    error.code = "ERR_MISSING_ARGS";
    throw error;
  }
  if (typeof hostname !== "string") {
    const error = new TypeError("hostname must be a string");
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (port == null) port = 443;
  if (typeof port !== "number") {
    const error = new TypeError(`The "port" property must be of type number. Received ${typeof port}`);
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (Number.isNaN(port)) port = 0;
  if (!Number.isFinite(port) || port < 0 || port > 65535) {
    const error = new RangeError(`The value of "port" is out of range. It must be >= -9007199254740991 and <= 9007199254740991. Received ${port}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  if (!Number.isInteger(port)) {
    const error = new TypeError("The \"port\" property must be of type integer. Received number");
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  try {
    resolveForNetwork(hostname, port, true);
  } catch {}
}

export function getCacheStats() {
  return {
    cacheHitsCompleted: dnsCacheState.cacheHitsCompleted,
    cacheHitsInflight: dnsCacheState.cacheHitsInflight,
    cacheMisses: dnsCacheState.cacheMisses,
    size: dnsCacheState.entries.size,
    errors: dnsCacheState.errors,
    totalCount: dnsCacheState.totalCount,
  };
}

function validateLookupServiceArgs(address, port) {
  if (typeof address !== "string" || address.length === 0) {
    const error = new TypeError("Expected address to be a non-empty string for 'lookupService'.");
    error.code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  if (isIP(address) === 0) {
    const error = new TypeError(`The "address" argument is invalid. Received type string ('${address}')`);
    error.code = "ERR_INVALID_ARG_VALUE";
    throw error;
  }
  const portNumber = typeof port === "string" && /^\d+$/.test(port) ? Number(port) : port;
  if (typeof portNumber !== "number" || !Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
    const received = typeof port === "string" ? `type string ('${port}')` : String(port);
    const error = new RangeError(`Port should be >= 0 and < 65536. Received ${received}.`);
    error.code = "ERR_SOCKET_BAD_PORT";
    throw error;
  }
}

function lookupServiceWithValidatedArgs(address, port, callback) {
  validateCallback(callback);
  callbackifyDns(() => {
    const record = lookupServiceRecord(address, port);
    return [record.hostname, record.service];
  }, callback);
}

export function lookupService(address, port, callback) {
  if (arguments.length < 3) throw missingArgs(["address", "port", "callback"]);
  validateLookupServiceArgs(address, port);
  return lookupServiceWithValidatedArgs(address, port, callback);
}

export function resolve4(hostname, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  validateResolveHostname(hostname);
  callbackifyDnsAsync(async () => [await resolveAddressRecordsAsync(hostname, 4, options, undefined)], callback);
}

export function resolve6(hostname, options = undefined, callback = undefined) {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  validateResolveHostname(hostname);
  callbackifyDnsAsync(async () => [await resolveAddressRecordsAsync(hostname, 6, options, undefined)], callback);
}

function resolveAnyWithState(hostname, callback, resolverState = undefined) {
  return resolveRecordsWithState(hostname, "ANY", "queryAny", callback, resolverState);
}

export function resolveAny(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveAnyWithState(hostname, callback, undefined);
}

function resolvePtrWithState(hostname, callback, resolverState = undefined) {
  callbackifyDnsAsync(async () => {
    try {
      return [await resolveNativeRecordsAsync(hostname, "PTR", "queryPtr", resolverState)];
    } catch (error) {
      if (configuredQueryServers(resolverState).length > 0 || error?.code === CANCELLED) throw error;
      const record = lookupServiceRecord(ptrNameToAddress(hostname), 0, resolverState);
      return [[record.hostname]];
    }
  }, callback);
}

export function resolvePtr(hostname, callback) {
  validateResolveHostname(hostname);
  return resolvePtrWithState(hostname, callback, undefined);
}

export function reverse(ip, callback) {
  if (typeof ip !== "string") throw invalidArgType("ip", "of type string", ip);
  return reverseWithState(ip, callback, undefined);
}

export function resolve(hostname, rrtype = "A", callback = undefined) {
  validateResolveHostname(hostname);
  if (typeof rrtype === "function") {
    callback = rrtype;
    rrtype = "A";
  }
  const type = normalizeRrtype(rrtype);
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
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "CAA", "queryCaa", callback, undefined);
}

export function resolveCname(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "CNAME", "queryCname", callback, undefined);
}

export function resolveMx(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "MX", "queryMx", callback, undefined);
}

export function resolveNaptr(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "NAPTR", "queryNaptr", callback, undefined);
}

export function resolveNs(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "NS", "queryNs", callback, undefined);
}

export function resolveSoa(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "SOA", "querySoa", callback, undefined, true);
}

export function resolveSrv(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "SRV", "querySrv", callback, undefined);
}

export function resolveTlsa(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "TLSA", "queryTlsa", callback, undefined);
}

export function resolveTxt(hostname, callback) {
  validateResolveHostname(hostname);
  return resolveRecordsWithState(hostname, "TXT", "queryTxt", callback, undefined);
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
  return effectiveServers();
}

export function setServers(nextServers) {
  servers = normalizeServers(nextServers);
  serversConfigured = true;
}

function promiseFromCallback(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

function normalizeResolverOptions(options = {}) {
  if (options == null || typeof options !== "object") throw invalidArgType("options", "of type object", options);
  const normalized = {};
  for (const name of ["timeout", "tries", "maxTimeout"]) {
    if (options[name] === undefined) continue;
    if (typeof options[name] !== "number") throw invalidArgType(name, "of type number", options[name]);
    normalized[name] = options[name];
  }
  if (normalized.timeout !== undefined && (
    !Number.isInteger(normalized.timeout) || normalized.timeout < -1 || normalized.timeout >= 2 ** 31
  )) {
    const error = new RangeError(`The value of "timeout" is out of range. Received ${normalized.timeout}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  if (normalized.maxTimeout !== undefined && (
    !Number.isInteger(normalized.maxTimeout) || normalized.maxTimeout < -1 || normalized.maxTimeout >= 2 ** 31
  )) {
    const error = new RangeError(`The value of "maxTimeout" is out of range. Received ${normalized.maxTimeout}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  if (normalized.tries !== undefined && (!Number.isInteger(normalized.tries) || normalized.tries < 1 || normalized.tries >= 2 ** 31)) {
    const error = new RangeError(`The value of "tries" is out of range. Received ${normalized.tries}`);
    error.code = "ERR_OUT_OF_RANGE";
    throw error;
  }
  return normalized;
}

function cancelResolverQueries(resolver) {
  for (const cancelQuery of [...resolver._pendingQueries]) cancelQuery();
}

function invalidLocalAddress(address) {
  const error = new Error(`Invalid IP address: ${address}`);
  error.code = "ERR_INVALID_ARG_VALUE";
  return error;
}

function setResolverLocalAddress(resolver, first, second = undefined) {
  if (typeof first !== "string") throw invalidArgType("ipv4", "of type string", first);
  if (second !== undefined && typeof second !== "string") throw invalidArgType("ipv6", "of type string", second);
  const firstFamily = isIP(first);
  if (firstFamily === 0) throw invalidLocalAddress(first);
  if (second === undefined) {
    if (firstFamily === 4) resolver._localAddress4 = first;
    else resolver._localAddress6 = first;
    return;
  }
  if (firstFamily !== 4 || isIP(second) !== 6) throw invalidLocalAddress(`${first}, ${second}`);
  resolver._localAddress4 = first;
  resolver._localAddress6 = second;
}

export class Resolver {
  constructor(options = {}) {
    options = normalizeResolverOptions(options);
    this._servers = effectiveServers();
    this._serversExplicit = false;
    this.timeout = options?.timeout;
    this.tries = options?.tries;
    this.maxTimeout = options?.maxTimeout;
    this._pendingQueries = new Set();
    this._localAddress4 = undefined;
    this._localAddress6 = undefined;
  }

  cancel() { cancelResolverQueries(this); }
  getServers() { return [...this._servers]; }
  setServers(nextServers) { this._servers = normalizeServers(nextServers); this._serversExplicit = true; }
  setLocalAddress(first, second = undefined) { setResolverLocalAddress(this, first, second); }
  resolve(hostname, rrtype = "A", callback = undefined) {
    validateResolveHostname(hostname);
    if (typeof rrtype === "function") {
      callback = rrtype;
      rrtype = "A";
    }
    const type = normalizeRrtype(rrtype);
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
    validateResolveHostname(hostname);
    callbackifyDnsAsync(async () => [await resolveAddressRecordsAsync(hostname, 4, options, this)], callback);
  }
  resolve6(hostname, options = undefined, callback = undefined) {
    if (typeof options === "function") {
      callback = options;
      options = undefined;
    }
    validateResolveHostname(hostname);
    callbackifyDnsAsync(async () => [await resolveAddressRecordsAsync(hostname, 6, options, this)], callback);
  }
  resolveAny(hostname, callback) { validateResolveHostname(hostname); return resolveAnyWithState(hostname, callback, this); }
  resolveCaa(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "CAA", "queryCaa", callback, this); }
  resolveCname(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "CNAME", "queryCname", callback, this); }
  resolveMx(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "MX", "queryMx", callback, this); }
  resolveNaptr(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "NAPTR", "queryNaptr", callback, this); }
  resolveNs(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "NS", "queryNs", callback, this); }
  resolvePtr(hostname, callback) { validateResolveHostname(hostname); return resolvePtrWithState(hostname, callback, this); }
  resolveSoa(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "SOA", "querySoa", callback, this, true); }
  resolveSrv(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "SRV", "querySrv", callback, this); }
  resolveTlsa(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "TLSA", "queryTlsa", callback, this); }
  resolveTxt(hostname, callback) { validateResolveHostname(hostname); return resolveRecordsWithState(hostname, "TXT", "queryTxt", callback, this); }
  reverse(ip, callback) {
    if (typeof ip !== "string") throw invalidArgType("ip", "of type string", ip);
    return reverseWithState(ip, callback, this);
  }
}

export class PromisesResolver {
  constructor(options = {}) {
    options = normalizeResolverOptions(options);
    this._servers = effectiveServers();
    this._serversExplicit = false;
    this.timeout = options?.timeout;
    this.tries = options?.tries;
    this.maxTimeout = options?.maxTimeout;
    this._pendingQueries = new Set();
    this._localAddress4 = undefined;
    this._localAddress6 = undefined;
  }

  cancel() { cancelResolverQueries(this); }
  getServers() { return [...this._servers]; }
  setServers(nextServers) { this._servers = normalizeServers(nextServers); this._serversExplicit = true; }
  setLocalAddress(first, second = undefined) { setResolverLocalAddress(this, first, second); }
  resolve(hostname, rrtype = "A") { validateResolveHostname(hostname); normalizeRrtype(rrtype); return promiseFromCallback(Resolver.prototype.resolve.bind(this), hostname, rrtype); }
  resolve4(hostname, options = undefined) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolve4.bind(this), hostname, options); }
  resolve6(hostname, options = undefined) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolve6.bind(this), hostname, options); }
  resolveAny(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveAny.bind(this), hostname); }
  resolveCaa(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveCaa.bind(this), hostname); }
  resolveCname(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveCname.bind(this), hostname); }
  resolveMx(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveMx.bind(this), hostname); }
  resolveNaptr(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveNaptr.bind(this), hostname); }
  resolveNs(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveNs.bind(this), hostname); }
  resolvePtr(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolvePtr.bind(this), hostname); }
  resolveSoa(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveSoa.bind(this), hostname); }
  resolveSrv(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveSrv.bind(this), hostname); }
  resolveTlsa(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveTlsa.bind(this), hostname); }
  resolveTxt(hostname) { validateResolveHostname(hostname); return promiseFromCallback(Resolver.prototype.resolveTxt.bind(this), hostname); }
  reverse(ip) { if (typeof ip !== "string") throw invalidArgType("ip", "of type string", ip); return promiseFromCallback(Resolver.prototype.reverse.bind(this), ip); }
}

export const promises = {
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
  SERVFAIL,
  TIMEOUT,
  V4MAPPED,
  Resolver: PromisesResolver,
  getCacheStats,
  getDefaultResultOrder,
  getServers,
  lookup(hostname, options = undefined) {
    validateLookupHostname(hostname);
    const normalized = normalizeLookupOptions(options);
    return new Promise((resolvePromise, reject) => {
      lookupWithNormalizedOptions(hostname, normalized, (error, address, family) => {
        if (error) reject(error);
        else if (Array.isArray(address)) resolvePromise(address);
        else resolvePromise({ address, family });
      });
    });
  },
  lookupService(address, port) {
    if (arguments.length < 2) throw missingArgs(["address", "port"]);
    validateLookupServiceArgs(address, port);
    return new Promise((resolvePromise, reject) => {
      lookupServiceWithValidatedArgs(address, port, (error, hostname, service) => {
        if (error) reject(error);
        else resolvePromise({ hostname, service });
      });
    });
  },
  resolve(hostname, rrtype = "A") { validateResolveHostname(hostname); normalizeRrtype(rrtype); return promiseFromCallback(resolve, hostname, rrtype); },
  resolve4(hostname, options = undefined) { validateResolveHostname(hostname); return promiseFromCallback(resolve4, hostname, options); },
  resolve6(hostname, options = undefined) { validateResolveHostname(hostname); return promiseFromCallback(resolve6, hostname, options); },
  resolveAny(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveAny, hostname); },
  resolveCaa(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveCaa, hostname); },
  resolveCname(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveCname, hostname); },
  resolveMx(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveMx, hostname); },
  resolveNaptr(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveNaptr, hostname); },
  resolveNs(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveNs, hostname); },
  resolvePtr(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolvePtr, hostname); },
  resolveSoa(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveSoa, hostname); },
  resolveSrv(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveSrv, hostname); },
  resolveTlsa(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveTlsa, hostname); },
  resolveTxt(hostname) { validateResolveHostname(hostname); return promiseFromCallback(resolveTxt, hostname); },
  reverse(ip) { if (typeof ip !== "string") throw invalidArgType("ip", "of type string", ip); return promiseFromCallback(reverse, ip); },
  prefetch,
  setDefaultResultOrder,
  setServers,
};

// util.promisify(dns.fn) must return the exact dns.promises implementation (Node behavior).
const kCustomPromisify = Symbol.for("nodejs.util.promisify.custom");
lookup[kCustomPromisify] = promises.lookup;
lookupService[kCustomPromisify] = promises.lookupService;
resolve[kCustomPromisify] = promises.resolve;
resolve4[kCustomPromisify] = promises.resolve4;
resolve6[kCustomPromisify] = promises.resolve6;
resolveAny[kCustomPromisify] = promises.resolveAny;
resolveCaa[kCustomPromisify] = promises.resolveCaa;
resolveCname[kCustomPromisify] = promises.resolveCname;
resolveMx[kCustomPromisify] = promises.resolveMx;
resolveNaptr[kCustomPromisify] = promises.resolveNaptr;
resolveNs[kCustomPromisify] = promises.resolveNs;
resolvePtr[kCustomPromisify] = promises.resolvePtr;
resolveSoa[kCustomPromisify] = promises.resolveSoa;
resolveSrv[kCustomPromisify] = promises.resolveSrv;
resolveTlsa[kCustomPromisify] = promises.resolveTlsa;
resolveTxt[kCustomPromisify] = promises.resolveTxt;
reverse[kCustomPromisify] = promises.reverse;

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
  getCacheStats,
  getDefaultResultOrder,
  getServers,
  lookup,
  lookupService,
  promises,
  prefetch,
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
