import { loadEmbeddedRuntimeModule } from "../node/module.js";
const namespace = loadEmbeddedRuntimeModule("bun/dns.js").default;
export const {
  lookup, resolve, resolveSrv, resolveTxt, resolveSoa, resolveNaptr, resolveMx,
  resolveCaa, resolveNs, resolvePtr, resolveCname, resolveAny, getServers,
  setServers, reverse, lookupService, prefetch, getCacheStats, ADDRCONFIG, ALL,
  V4MAPPED,
} = namespace;
export default namespace;
