function normalize(path) {
  const text = String(path || "");
  const absolute = text.startsWith("/");
  const parts = [];
  for (const part of text.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else {
      parts.push(part);
    }
  }
  return (absolute ? "/" : "") + parts.join("/");
}

export function join(...parts) {
  return normalize(parts.filter((part) => part !== "").join("/"));
}

export function resolve(...parts) {
  let path = "";
  for (const part of parts) {
    if (!part) continue;
    path = String(part).startsWith("/") ? String(part) : join(path || cottontail.cwd(), String(part));
  }
  return normalize(path || cottontail.cwd());
}

export function dirname(path) {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return normalized.startsWith("/") ? "/" : ".";
  return normalized.slice(0, index);
}

export function basename(path) {
  const normalized = normalize(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

export function relative(from, to) {
  const fromParts = resolve(from).split("/").filter(Boolean);
  const toParts = resolve(to).split("/").filter(Boolean);
  while (fromParts.length && toParts.length && fromParts[0] === toParts[0]) {
    fromParts.shift();
    toParts.shift();
  }
  return [...fromParts.map(() => ".."), ...toParts].join("/") || ".";
}

export default { basename, dirname, join, relative, resolve };
