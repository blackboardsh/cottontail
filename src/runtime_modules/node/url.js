import { resolve } from "./path.js";

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export function pathToFileURL(path) {
  const absolute = resolve(String(path));
  return new URL(`file://${absolute.split("/").map(encodeURIComponent).join("/")}`);
}

export function fileURLToPath(url) {
  const href = typeof url === "string" ? url : String(url?.href ?? url);
  if (!href.startsWith("file://")) return href;
  return decodeURIComponent(href.slice("file://".length).split("?")[0].split("#")[0]);
}

export default { fileURLToPath, pathToFileURL, URL, URLSearchParams };
