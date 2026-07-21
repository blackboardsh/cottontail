import { semver, write } from "bun";

for (const name of ["Response", "Request", "Headers", "fetch", "reportError"]) {
  if (typeof globalThis[name] !== "function") throw new Error(`${name} was not installed by a narrow bun import`);
}

const response = new globalThis["Response"]("web-globals-ok");
if (await response.text() !== "web-globals-ok") throw new Error("Response body behavior is unavailable");

console.log("bun narrow import globals passed");
