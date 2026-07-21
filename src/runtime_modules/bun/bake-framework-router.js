import path from "../node/path.js";
import { readdirSync } from "../node/fs.js";

// COTTONTAIL-COMPAT: bun:bake - JavaScript port of Bun's Zig
// bake/FrameworkRouter.zig. This keeps the routing rules usable while the full
// Bake VM and dev-server host boundary are being connected to Cottontail.

const supportedStyles = new Set([
  "nextjs-pages",
  "nextjs-app-ui",
  "nextjs-app-routes",
]);

const javascriptExtensions = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
]);

const scannedExtensions = new Set([".tsx", ".ts", ".jsx", ".js"]);

function routeError(message, start, length) {
  throw new Error(`${message} (${start}:${length})`);
}

function normalizeStyle(style) {
  if (typeof style === "function") return style;
  if (typeof style === "string" && supportedStyles.has(style)) return style;
  throw new TypeError(
    "'style' must be either \"nextjs-pages\", \"nextjs-app-ui\", \"nextjs-app-routes\", or a function.",
  );
}

function text(value) {
  return { type: "text", value };
}

function renderPart(part) {
  switch (part.type) {
    case "text":
      return `/${part.value}`;
    case "param":
      return `/:${part.value}`;
    case "group":
      return `/(${part.value})`;
    case "catch_all":
      return `/:*${part.value}`;
    case "catch_all_optional":
      return `/:*?${part.value}`;
    default:
      throw new TypeError(`Unknown route part: ${String(part.type)}`);
  }
}

function renderPattern(parts) {
  return parts.map(renderPart).join("");
}

function appendTextParts(parts, value) {
  for (const part of value.split("/")) {
    if (part.length > 0) parts.push(text(part));
  }
}

function findStop(route, offset, convention) {
  for (let index = offset; index < route.length; index += 1) {
    const character = route[index];
    if (character === "[" || (convention === "app" && (character === "(" || character === "@"))) {
      return index;
    }
  }
  return -1;
}

function parseNextLikeSegment(rawInput, routeSegment, convention) {
  let offset = 1;
  const parts = [];
  while (true) {
    const start = findStop(routeSegment, offset, convention);
    if (start < 0) break;

    if (convention === "pages" || routeSegment[start] === "[") {
      let end = routeSegment.indexOf("]", start + 1);
      if (end < 0) {
        routeError('Missing "]" to match this route parameter', start, rawInput.length - start);
      }

      const optional = routeSegment[start + 1] === "[";
      const parameter = routeSegment.slice(start + 1 + Number(optional), end);
      let endingDoubleBracket = false;
      if (end + 1 < routeSegment.length && routeSegment[end + 1] === "]") {
        end += 1;
        endingDoubleBracket = true;
      }
      const length = end - start + 1;
      const catchAll = parameter.startsWith("...");
      const name = catchAll ? parameter.slice(3) : parameter;

      if (name.length === 0) routeError("Parameter needs a name", start, length);
      if (name[0] === ".") {
        routeError('Parameter name cannot start with "." (use "..." for catch-all)', start, length);
      }
      if (optional && !catchAll) {
        routeError(
          `Optional parameters can only be catch-all (change to "[[...${name}]]" or remove extra brackets)`,
          start,
          length,
        );
      }

      const badCharacterIndex = name.search(/[?*{}()=:#,]/);
      if (badCharacterIndex >= 0) {
        routeError(`Parameter name cannot contain "${name[badCharacterIndex]}"`, start + badCharacterIndex, 1);
      }
      if (endingDoubleBracket && !optional) routeError('Extra "]" in route parameter', end, 1);
      if (!endingDoubleBracket && optional) {
        routeError('Missing second "]" to close optional route parameter', end, 1);
      }
      if (routeSegment[start - 1] !== "/" || (end + 1 < routeSegment.length && routeSegment[end + 1] !== "/")) {
        routeError("Parameters must take up the entire file name", start, length);
      }
      if (catchAll && routeSegment.length !== end + 1) {
        routeError("Catch-all parameter must be at the end of a route", start, length);
      }

      appendTextParts(parts, routeSegment.slice(offset, start));
      parts.push({
        type: optional ? "catch_all_optional" : catchAll ? "catch_all" : "param",
        value: name,
      });
      offset = end + 1;
      continue;
    }

    if (routeSegment[start] === "(") {
      const end = routeSegment.indexOf(")", start + 1);
      if (end < 0) {
        routeError('Missing ")" to match this route group', start, rawInput.length - start);
      }
      const length = end - start + 1;
      const name = routeSegment.slice(start + 1, end);
      if (name.startsWith(".")) {
        routeError("Bun Bake currently does not support named slots and intercepted routes", start, length);
      }
      if (routeSegment[start - 1] !== "/" || (end + 1 < routeSegment.length && routeSegment[end + 1] !== "/")) {
        routeError("Route group marker must take up the entire file name", start, length);
      }
      appendTextParts(parts, routeSegment.slice(offset, start));
      parts.push({ type: "group", value: name });
      offset = end + 1;
      continue;
    }

    const closingParenthesis = routeSegment.indexOf(")", start + 1);
    const end = closingParenthesis < 0 ? routeSegment.length : closingParenthesis;
    routeError(
      "Bun Bake currently does not support named slots and intercepted routes",
      start,
      end - start + 1,
    );
  }

  appendTextParts(parts, routeSegment.slice(offset));
  return parts;
}

function parsePages(filePath, extension) {
  let route = filePath.slice(0, filePath.length - extension.length);
  let kind = "page";
  if (route.endsWith("/index")) {
    route = route.slice(0, -"/index".length);
  } else if (route.endsWith("/_layout")) {
    route = route.slice(0, -"/_layout".length);
    kind = "layout";
  }
  return {
    kind,
    parts: route.length === 0 ? [] : parseNextLikeSegment(filePath, route, "pages"),
  };
}

function parseApp(filePath, extension, style) {
  if (!javascriptExtensions.has(extension)) return null;
  const withoutExtension = filePath.slice(0, filePath.length - extension.length);
  const basename = path.posix.basename(withoutExtension);
  const kinds = style === "nextjs-app-ui"
    ? {
        page: "page",
        layout: "layout",
        default: "extra",
        template: "extra",
        error: "extra",
        loading: "extra",
        "not-found": "extra",
      }
    : { route: "page" };
  const kind = kinds[basename];
  if (kind === undefined) return null;

  const dirname = path.posix.dirname(withoutExtension);
  return {
    kind,
    parts: dirname.length <= 1 ? [] : parseNextLikeSegment(filePath, dirname, "app"),
  };
}

function parsePattern(style, filePath) {
  const extension = path.posix.extname(filePath);
  if (typeof style === "function") {
    const result = style(filePath);
    if (result == null) return null;
    if (typeof result !== "object" || !Array.isArray(result.parts) || typeof result.kind !== "string") {
      throw new TypeError("A custom route style must return { kind, parts } or null");
    }
    return result;
  }
  if (style === "nextjs-pages") return parsePages(filePath, extension);
  return parseApp(filePath, extension, style);
}

export function parseRoutePattern(style, filePath) {
  if (arguments.length < 2) throw new TypeError("parseRoutePattern takes two arguments");
  const normalizedStyle = normalizeStyle(style);
  const parsed = parsePattern(normalizedStyle, String(filePath));
  return parsed === null
    ? null
    : { kind: parsed.kind, pattern: renderPattern(parsed.parts) };
}

function routeNode(part = text(""), parent = null) {
  return {
    part,
    parent,
    page: null,
    layout: null,
    children: [],
  };
}

function partEquals(left, right) {
  return left.type === right.type && left.value === right.value;
}

function matchDynamic(parts, pathname) {
  const params = [];
  let offset = 1;
  for (const part of parts) {
    if (part.type === "text") {
      if (!pathname.startsWith(part.value, offset)) return null;
      const end = offset + part.value.length;
      if (pathname.length !== end && pathname[end] !== "/") return null;
      offset = end === pathname.length ? end : end + 1;
      continue;
    }
    if (part.type === "param") {
      const end = pathname.indexOf("/", offset);
      const segmentEnd = end < 0 ? pathname.length : end;
      params.push([part.value, pathname.slice(offset, segmentEnd)]);
      offset = segmentEnd === pathname.length ? segmentEnd : segmentEnd + 1;
      continue;
    }
    if (part.type === "catch_all" || part.type === "catch_all_optional") {
      while (offset < pathname.length) {
        const end = pathname.indexOf("/", offset);
        const segmentEnd = end < 0 ? pathname.length : end;
        if (offset < segmentEnd) params.push([part.value, pathname.slice(offset, segmentEnd)]);
        offset = segmentEnd === pathname.length ? segmentEnd : segmentEnd + 1;
      }
      return params;
    }
  }
  return offset === pathname.length ? params : null;
}

function routeToJSON(node) {
  return {
    part: renderPart(node.part),
    page: node.page,
    layout: node.layout,
    children: node.children.map(routeToJSON),
  };
}

function routeToInverseJSON(node) {
  return {
    part: renderPart(node.part),
    page: node.page,
    layout: node.layout,
    parent: node.parent === null ? null : routeToInverseJSON(node.parent),
  };
}

function trimTrailingSeparator(value) {
  const parsed = path.parse(value);
  while (value.length > parsed.root.length && /[\\/]$/.test(value)) value = value.slice(0, -1);
  return value;
}

export class FrameworkRouter {
  constructor(options) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("FrameworkRouter needs an object as it's first argument");
    }
    if (options.root === undefined) throw new TypeError("Missing options.root");

    this.root = trimTrailingSeparator(path.resolve(String(options.root)));
    this.style = normalizeStyle(options.style);
    this.tree = routeNode();
    this.staticRoutes = new Map();
    this.dynamicRoutes = [];
    const errors = [];
    this.scanDirectory(this.root, errors);
    if (errors.length > 0) throw new AggregateError(errors, "Errors scanning routes");
  }

  scanDirectory(directory, errors) {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    // Bun's resolver directory map iterates newest entries first. Reversing the
    // filesystem enumeration preserves that stable route-tree ordering.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        this.scanDirectory(path.join(directory, entry.name), errors);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.extname(entry.name);
      if (!scannedExtensions.has(extension)) continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = `/${path.relative(this.root, absolutePath).split(path.sep).join("/")}`;
      let parsed;
      try {
        parsed = parsePattern(this.style, relativePath);
      } catch (error) {
        errors.push(new Error(`Invalid route ${JSON.stringify(relativePath)}: ${error.message}`));
        continue;
      }
      if (parsed === null || parsed.kind === "extra") continue;
      if (parsed.parts.filter(part => part.type !== "text" && part.type !== "group").length > 64) {
        errors.push(new Error(`Invalid route ${JSON.stringify(relativePath)}: Pattern cannot have more than 64 param`));
        continue;
      }
      try {
        this.insert(parsed, absolutePath);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  insert(parsed, absolutePath) {
    let node = this.tree;
    for (const part of parsed.parts) {
      let child = node.children.find(candidate => partEquals(candidate.part, part));
      if (child === undefined) {
        child = routeNode(part, node);
        node.children.push(child);
      }
      node = child;
    }

    const field = parsed.kind === "layout" ? "layout" : "page";
    if (node[field] !== null && node[field] !== absolutePath) {
      throw new Error(`Route collision between ${JSON.stringify(node[field])} and ${JSON.stringify(absolutePath)}`);
    }
    node[field] = absolutePath;

    if (field !== "page") return;
    const dynamic = parsed.parts.some(part => part.type === "param" || part.type.startsWith("catch_all"));
    if (dynamic) {
      this.dynamicRoutes.push({ parts: parsed.parts, node });
    } else {
      const pathname = parsed.parts
        .filter(part => part.type === "text")
        .map(part => `/${part.value}`)
        .join("") || "/";
      this.staticRoutes.set(pathname, node);
    }
  }

  match(pathname) {
    pathname = String(pathname);
    if (!pathname.startsWith("/")) throw new TypeError("Route path must start with '/'");
    let node = this.staticRoutes.get(pathname);
    let matchedParams = [];
    if (node === undefined) {
      for (const route of this.dynamicRoutes) {
        const params = matchDynamic(route.parts, pathname);
        if (params !== null) {
          node = route.node;
          matchedParams = params;
          break;
        }
      }
    }
    if (node === undefined) return null;
    let params = null;
    if (matchedParams.length > 0) {
      params = {};
      for (const [key, value] of matchedParams) params[key] = value;
    }
    return { params, route: routeToInverseJSON(node) };
  }

  toJSON() {
    return routeToJSON(this.tree);
  }
}

export const frameworkRouterInternals = {
  parseRoutePattern,
  FrameworkRouter,
};

export default frameworkRouterInternals;
