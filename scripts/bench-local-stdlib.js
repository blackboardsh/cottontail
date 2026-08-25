#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [newBinary, oldBinary, bunBinary] = process.argv.slice(2);
if (!newBinary || !oldBinary || !bunBinary) {
  throw new Error("usage: bench-local-stdlib.js NEW OLD|none BUN|none");
}

const loaders = {
  ffi: runtime => runtime === "new" ? "Cottontail.ffi" : 'require("bun:ffi")',
  sqlite: runtime => runtime === "new" ? "Cottontail.sqlite.Database"
    : '(()=>{const module=require("bun:sqlite");return module.Database??module.default??module})()',
};
const allCottontailCapabilityPaths = [
  "ffi", "sqlite", "sql", "redis", "s3", "toml", "json5", "colors",
  "cookies", "websocket", "jscTools", "yaml", "test", "shell", "build",
  "bake", "glob", "text", "uuid", "password", "hashing", "data",
  "markdown", "compression", "archive", "filesystemRouter", "htmlRewriter",
  "terminal", "csrf", "secrets",
  "node.inspector", "node.repl", "node.sea",
];
const scenarios = {
  bare: () => "void 0",
  selected_cold: runtime => {
    const ffi = loaders.ffi(runtime);
    const sqlite = loaders.sqlite(runtime);
    return `const begin=performance.now();void ${ffi}.FFIType.i32;const D=${sqlite};const d=new D(":memory:");d.query("select 1").get();d.close();console.log(JSON.stringify({prewarm_ms:performance.now()-begin,hot_ns_per_op:0}))`;
  },
  all_cold: runtime => runtime !== "new" ? null : `
    const paths=${JSON.stringify(allCottontailCapabilityPaths)}.map(path=>path.split("."));const read=keys=>keys.reduce((value,key)=>value[key],Cottontail);const begin=performance.now();
    for(const keys of paths)void read(keys);
    console.log(JSON.stringify({prewarm_ms:performance.now()-begin,hot_ns_per_op:0}));`,
  all_hot: runtime => runtime !== "new" ? null : `
    const paths=${JSON.stringify(allCottontailCapabilityPaths)}.map(path=>path.split("."));const read=keys=>keys.reduce((value,key)=>value[key],Cottontail);const begin=performance.now();
    for(const keys of paths)void read(keys);const ready=performance.now();
    let value;const count=100000;const hotBegin=performance.now();
    for(let i=0;i<count;i++)value=read(paths[i%paths.length]);
    const hotEnd=performance.now();console.log(JSON.stringify({prewarm_ms:ready-begin,hot_ns_per_op:(hotEnd-hotBegin)*1e6/count,value_type:typeof value}));`,
  ffi_cold: runtime => `const begin=performance.now();void ${loaders.ffi(runtime)}.FFIType.i32;console.log(JSON.stringify({prewarm_ms:performance.now()-begin,hot_ns_per_op:0}))`,
  sqlite_cold: runtime => `const begin=performance.now();const D=${loaders.sqlite(runtime)};const d=new D(":memory:");d.query("select 1").get();d.close();console.log(JSON.stringify({prewarm_ms:performance.now()-begin,hot_ns_per_op:0}))`,
  ffi_hot: runtime => `
    const begin=performance.now();const ffi=${loaders.ffi(runtime)};const ready=performance.now();
    let value=0;const count=1000000;const hotBegin=performance.now();
    for(let i=0;i<count;i++)value=ffi.FFIType.i32;
    const hotEnd=performance.now();console.log(JSON.stringify({prewarm_ms:ready-begin,hot_ns_per_op:(hotEnd-hotBegin)*1e6/count,value}));`,
  sqlite_hot: runtime => `
    const begin=performance.now();const D=${loaders.sqlite(runtime)};const d=new D(":memory:");
    const q=d.query("select 1 as n");q.get();const ready=performance.now();
    const count=10000;const hotBegin=performance.now();for(let i=0;i<count;i++)q.get();
    const hotEnd=performance.now();q.finalize?.();d.close();console.log(JSON.stringify({prewarm_ms:ready-begin,hot_ns_per_op:(hotEnd-hotBegin)*1e6/count}));`,
};
const scenarioFilter = new Set((process.env.COTTONTAIL_BENCH_SCENARIOS ?? "")
  .split(",").map(value => value.trim()).filter(Boolean));
const runtimes = Object.fromEntries(Object.entries({ new: newBinary, old: oldBinary, bun: bunBinary })
  .filter(([, binary]) => binary !== "none"));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fixtureRoot = mkdtempSync(join(tmpdir(), "cottontail-stdlib-bench-"));

try {
  for (const [runtime, binary] of Object.entries(runtimes)) {
    for (const [name, sourceForRuntime] of Object.entries(scenarios)) {
      if (scenarioFilter.size && !scenarioFilter.has(name)) continue;
      const source = sourceForRuntime(runtime);
      if (source == null) continue;
      const fixturePath = join(fixtureRoot, `${runtime}-${name}.js`);
      writeFileSync(fixturePath, `${source}\n`);

      // Cottontail's first file execution creates the bundled source and JSC
      // bytecode cache. Benchmark only subsequent bytecode-backed launches.
      if (runtime !== "bun") {
        const warm = spawnSync(binary, [fixturePath], { encoding: "utf8" });
        if (warm.status !== 0) throw new Error(`${runtime}/${name} warmup: ${warm.stderr || warm.stdout}`);
      }

      const times = [];
      const rss = [];
      const prewarm = [];
      const hot = [];
      for (let index = 0; index < 15; index++) {
        const start = process.hrtime.bigint();
        const result = spawnSync("/usr/bin/time", ["-l", binary, fixturePath], { encoding: "utf8" });
        const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
        if (result.status !== 0) throw new Error(`${runtime}/${name}: ${result.stderr || result.stdout}`);
        const match = result.stderr.match(/(\d+)\s+maximum resident set size/);
        if (!match) throw new Error(`${runtime}/${name}: missing RSS`);
        if (index >= 3) {
          times.push(elapsed);
          rss.push(Number(match[1]) / 1024 / 1024);
          const measurement = result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null;
          if (measurement) {
            prewarm.push(measurement.prewarm_ms);
            hot.push(measurement.hot_ns_per_op);
          }
        }
      }
      console.log(JSON.stringify({
        runtime,
        scenario: name,
        process_wall_ms_p50: median(times),
        peak_rss_mib_p50: median(rss),
        ...(prewarm.length ? { prewarm_ms_p50: median(prewarm), hot_ns_per_op_p50: median(hot) } : {}),
      }));
    }
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

function directorySize(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((sum, entry) => {
    const entryPath = join(path, entry.name);
    return sum + (entry.isDirectory() ? directorySize(entryPath) : statSync(entryPath).size);
  }, 0);
}

const newStdlib = directorySize(join(newBinary, "..", "cottontail-stdlib"));
const newSelectedStdlib = directorySize(join(newBinary, "..", "cottontail-stdlib", "ffi")) +
  directorySize(join(newBinary, "..", "cottontail-stdlib", "sqlite"));
const sizes = {
    new_executable: statSync(newBinary).size,
    new_selected_stdlib: newSelectedStdlib,
    new_selected_distribution: statSync(newBinary).size + newSelectedStdlib,
    new_all_stdlib: newStdlib,
    new_all_distribution: statSync(newBinary).size + newStdlib,
    ...(oldBinary !== "none" ? { old_executable: statSync(oldBinary).size } : {}),
    ...(bunBinary !== "none" ? { bun_executable: statSync(bunBinary).size } : {}),
};
console.log(JSON.stringify({ sizes }));
