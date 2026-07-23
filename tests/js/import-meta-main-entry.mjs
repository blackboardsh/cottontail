if (import.meta.main !== true) {
  throw new Error("The CLI entrypoint must have import.meta.main set to true");
}

const child = await import("./fixtures/import-meta-main-child.mjs");
if (child.isMain !== false) {
  throw new Error("An imported module must have import.meta.main set to false");
}

console.log("import.meta.main entry identity passed");
