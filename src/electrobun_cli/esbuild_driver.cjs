const fs = require("fs");
const path = require("path");

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    throw new Error("missing esbuild spec path");
  }

  const raw = fs.readFileSync(specPath, "utf8");
  const spec = JSON.parse(raw);
  const vendorDir = spec.vendorDir;
  if (!vendorDir) {
    throw new Error("missing vendorDir in esbuild spec");
  }

  const esbuild = require(path.join(vendorDir, "node_modules", "esbuild"));
  const op = spec.op || "build";

  if (op === "build") {
    await esbuild.build(spec.options || {});
    return;
  }

  throw new Error(`unsupported esbuild op: ${op}`);
}

main().catch((error) => {
  const message =
    error && typeof error === "object" && "stack" in error && error.stack
      ? error.stack
      : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
