// Access a non-minimal Bun API so the external harness captures full-runtime
// bootstrap cost rather than the selective startup path used by empty.js.
if (typeof Bun.SQL !== "function") {
  throw new Error("full runtime benchmark did not initialize Bun.SQL");
}
