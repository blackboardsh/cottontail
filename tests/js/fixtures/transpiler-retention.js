const operation = process.argv.at(-1);
const source = 'import { dependency } from "./dependency.js";\n' + Array.from(
  { length: 8_000 },
  (_, index) => `export function value${index}(input: number): number { const values = [input, dependency, ${index}]; return values[0] + values[1] + values[2]; }`,
).join("\n");
const transpiler = new Bun.Transpiler({ loader: "ts" });
function run() {
  if (operation === "scan") {
    const imports = transpiler.scanImports(source);
    if (imports.length !== 1 || imports[0].path !== "./dependency.js") throw new Error("Incorrect import scan");
  } else if (operation === "transform") {
    const output = transpiler.transformSync(source);
    if (!output.includes("value7999") || output.includes("input: number")) throw new Error("Incorrect transform");
  } else throw new Error("Unknown operation");
}
run();
Bun.gc(true);
Bun.gc(true);
const before = process.memoryUsage().rss;
for (let index = 0; index < 8; index++) {
  run();
  Bun.gc(true);
  Bun.gc(true);
}
console.log(JSON.stringify({ operation, growth: process.memoryUsage().rss - before }));
