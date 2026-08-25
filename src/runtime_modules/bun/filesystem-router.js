export class FileSystemRouter {
  constructor(options) {
    if (options == null || typeof options !== "object") throw new TypeError("Expected object");
    if (options.style !== "nextjs") throw new TypeError("Only 'nextjs' style is currently implemented");
    if (typeof options.dir !== "string") throw new TypeError("Expected dir to be a string");
    if (options.origin !== undefined && typeof options.origin !== "string") throw new TypeError("Expected origin to be a string");
    if (options.assetPrefix !== undefined && typeof options.assetPrefix !== "string") throw new TypeError("Expected assetPrefix to be a string");
    if (options.fileExtensions !== undefined && (!Array.isArray(options.fileExtensions) || options.fileExtensions.some((value) => typeof value !== "string"))) {
      throw new TypeError("Expected fileExtensions to be an Array of strings");
    }
    this.options = { ...options };
    this.style = "nextjs";
    this.origin = options.origin ?? "";
    this.assetPrefix = options.assetPrefix ?? "";
    this._dir = options.dir;
    this._extensions = (options.fileExtensions ?? [".tsx", ".jsx", ".ts", ".mjs", ".cjs", ".js"])
      .filter(Boolean)
      .map((value) => value.startsWith(".") ? value : `.${value}`);
    this._records = [];
    this.routes = Object.create(null);
    this.reload();
  }

  match(input) {
    const { pathname, query } = normalizeRouterInput(input);
    const normalized = normalizeRoutePath(pathname);
    let best = null;
    for (const record of this._records) {
      const params = matchFileSystemRoute(record, normalized);
      if (params == null) continue;
      if (best == null || compareFileSystemRoutes(record, best.record) < 0) best = { record, params };
    }
    if (best == null) return null;
    const { record, params } = best;
    const resultQuery = { ...params, ...query };
    let src = record.relative;
    if (this.assetPrefix) src = `${this.assetPrefix.replace(/\/+$/, "")}/${src.replace(/^\/+/, "")}`;
    if (this.origin) src = `${this.origin.replace(/\/+$/, "")}/${src.replace(/^\/+/, "")}`;
    return {
      filePath: record.filePath,
      kind: record.kind,
      name: record.name,
      pathname: normalized,
      src,
      params,
      query: resultQuery,
    };
  }

  reload() {
    const routes = Object.create(null);
    const records = [];
    if (cottontail.existsSync(this._dir)) {
      for (const entry of globalThis.Cottontail.glob.walkFiles(this._dir, { dot: false, onlyFiles: true })) {
        const relative = String(entry.relative).replace(/\\/g, "/");
        const extension = this._extensions.find((candidate) => relative.endsWith(candidate));
        if (!extension) continue;
        const name = routePathFromFile(relative, extension);
        const record = makeFileSystemRouteRecord(name, entry.absolute, relative);
        routes[name] = entry.absolute;
        records.push(record);
      }
    }
    this.routes = routes;
    this._records = records;
    return this;
  }
}
function normalizeRoutePath(value) {
  let pathname = String(value || "/").split(/[?#]/, 1)[0] || "/";
  if (!pathname.startsWith("/")) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+/g, "/");
  if (pathname === "/index") pathname = "/";
  else if (pathname.endsWith("/index")) pathname = pathname.slice(0, -6) || "/";
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "");
  return pathname || "/";
}

function normalizeRouterInput(input) {
  if (input == null) throw new TypeError("Expected string, Request or Response");
  let raw;
  if (typeof input === "string") raw = input;
  else if (typeof input.url === "string") raw = input.url;
  else if (typeof input.href === "string") raw = input.href;
  else if (typeof input.pathname === "string") raw = `${input.pathname}${input.search ?? ""}`;
  else throw new TypeError("Expected string, Request or Response");
  const query = {};
  const queryStart = raw.indexOf("?");
  if (queryStart !== -1) {
    const hashStart = raw.indexOf("#", queryStart);
    const queryText = raw.slice(queryStart + 1, hashStart === -1 ? raw.length : hashStart);
    for (const part of queryText.split("&")) {
      if (!part) continue;
      const separator = part.indexOf("=");
      const decode = (value) => decodeURIComponent(value.replace(/\+/g, " "));
      const key = decode(separator === -1 ? part : part.slice(0, separator));
      query[key] = decode(separator === -1 ? "" : part.slice(separator + 1));
    }
  }
  let url;
  try {
    url = new URL(raw, "http://cottontail.invalid");
  } catch {
    return { pathname: queryStart === -1 ? raw : raw.slice(0, queryStart), query };
  }
  return { pathname: url.pathname, query };
}

function routePathFromFile(file, extension) {
  let route = String(file).replace(/\\/g, "/").slice(0, -extension.length);
  route = route.replace(/\/index$/, "").replace(/^index$/, "");
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function makeFileSystemRouteRecord(name, filePath, relative) {
  const segments = name === "/" ? [] : name.slice(1).split("/");
  let kind = "exact";
  let rank = 0;
  if (segments.some((segment) => /^\[\[\.\.\.[^\]]+\]\]$/.test(segment))) {
    kind = "catch-all-optional";
    rank = 3;
  } else if (segments.some((segment) => /^\[\.\.\.[^\]]+\]$/.test(segment))) {
    kind = "catch-all";
    rank = 2;
  } else if (segments.some((segment) => /^\[[^\]]+\]$/.test(segment))) {
    kind = "dynamic";
    rank = 1;
  }
  return { name, filePath, relative, segments, kind, rank };
}

function compareFileSystemRoutes(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  const leftStatic = left.segments.filter((segment) => !segment.startsWith("[")).length;
  const rightStatic = right.segments.filter((segment) => !segment.startsWith("[")).length;
  if (leftStatic !== rightStatic) return rightStatic - leftStatic;
  return right.segments.length - left.segments.length;
}

function matchFileSystemRoute(record, pathname) {
  const inputSegments = pathname === "/" ? [] : pathname.slice(1).split("/").map((value) => decodeURIComponent(value));
  const params = {};
  let inputIndex = 0;
  for (let routeIndex = 0; routeIndex < record.segments.length; routeIndex += 1) {
    const segment = record.segments[routeIndex];
    const optionalCatchAll = segment.match(/^\[\[\.\.\.([^\]]+)\]\]$/);
    if (optionalCatchAll) {
      params[optionalCatchAll[1]] = inputSegments.slice(inputIndex).join("/");
      inputIndex = inputSegments.length;
      continue;
    }
    const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/);
    if (catchAll) {
      if (inputIndex >= inputSegments.length) return null;
      params[catchAll[1]] = inputSegments.slice(inputIndex).join("/");
      inputIndex = inputSegments.length;
      continue;
    }
    const dynamic = segment.match(/^\[([^\]]+)\]$/);
    if (dynamic) {
      if (inputIndex >= inputSegments.length) return null;
      params[dynamic[1]] = inputSegments[inputIndex++];
      continue;
    }
    if (inputSegments[inputIndex++] !== segment) return null;
  }
  return inputIndex === inputSegments.length ? params : null;
}
