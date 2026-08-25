#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const binary = process.argv[2];
if (!binary) throw new Error("usage: profile-capability-memory.js COTTONTAIL [CAPABILITY ...]");

const defaultCapabilities = [
  "node.sea", "colors", "ffi", "sqlite", "toml", "json5", "cookies",
  "websocket", "yaml", "glob", "text", "uuid", "password", "hashing",
  "data", "markdown", "compression", "archive", "filesystemRouter",
  "htmlRewriter", "terminal", "csrf", "secrets", "sql", "redis", "s3",
  "jscTools", "test", "shell", "build", "bake", "node.inspector", "node.repl",
];
const capabilities = process.argv.slice(3).length ? process.argv.slice(3) : defaultCapabilities;
const fixtureRoot = mkdtempSync(join(tmpdir(), "cottontail-capability-memory-"));

const rssKiB = pid => {
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
};

const footprintMiB = pid => {
  if (process.platform !== "darwin") return null;
  const result = spawnSync("footprint", [String(pid)], { encoding: "utf8" });
  const match = result.stdout.match(/Footprint:\s+([0-9.]+)\s*([KMG]B)/);
  if (!match) return null;
  const scale = match[2] === "GB" ? 1024 : match[2] === "KB" ? 1 / 1024 : 1;
  return Number(match[1]) * scale;
};

async function measure(prefix) {
  const name = prefix.at(-1) ?? "bare";
  const fixture = join(fixtureRoot, `${prefix.length}.js`);
  const accesses = prefix.map(path => {
    if (path === "expr:cottontail") return `globalThis.__profileValue = Cottontail;`;
    if (path === "expr:global-cottontail") return `globalThis.__profileValue = globalThis.Cottontail;`;
    if (path === "expr:bun") return `globalThis.__profileValue = Bun;`;
    if (path === "expr:process") return `globalThis.__profileValue = process;`;
    if (path === "expr:console") return `globalThis.__profileValue = console;`;
    if (path.startsWith("global-bracket:")) {
      const suffix = path.slice("global-bracket:".length).split(".").map(part => `[${JSON.stringify(part)}]`).join("");
      return `globalThis.__profileValue = globalThis["Cotto" + "ntail"]${suffix};`;
    }
    if (path.startsWith("indirect-eval:")) {
      return `globalThis.__profileValue = (0, eval)(${JSON.stringify(`globalThis.Cottontail.${path.slice("indirect-eval:".length)}`)});`;
    }
    if (path.startsWith("touch:")) {
      return `globalThis.__profileValue = Cottontail.${path.slice("touch:".length)};`;
    }
    if (path.startsWith("call-getter:")) {
      const propertyPath = path.slice("call-getter:".length).split(".");
      const property = propertyPath.pop();
      const objectPath = propertyPath.length ? `Cottontail.${propertyPath.join(".")}` : "Cottontail";
      return `globalThis.__profileValue = Object.getOwnPropertyDescriptor(${objectPath}, ${JSON.stringify(property)}).get.call(${objectPath});`;
    }
    if (path.startsWith("copy-getter:")) {
      const propertyPath = path.slice("copy-getter:".length).split(".");
      const property = propertyPath.pop();
      const objectPath = propertyPath.length ? `Cottontail.${propertyPath.join(".")}` : "Cottontail";
      return `const __profileCopiedGetter = Object.getOwnPropertyDescriptor(${objectPath}, ${JSON.stringify(property)}).get; Object.defineProperty(globalThis.__profileObject ??= {}, "value", { configurable: true, get: __profileCopiedGetter }); globalThis.__profileValue = globalThis.__profileObject.value;`;
    }
    if (path.startsWith("alias:")) {
      const propertyPath = path.slice("alias:".length).split(".");
      const property = propertyPath.pop();
      const objectPath = propertyPath.length ? `Cottontail.${propertyPath.join(".")}` : "Cottontail";
      return `const __profileAlias = ${objectPath}; globalThis.__profileValue = __profileAlias[${JSON.stringify(property)}];`;
    }
    if (path.startsWith("replace-node:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `globalThis.Cottontail.node=new Proxy({},{get(){return cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)}).modules[${JSON.stringify(modulePath)}]}});void globalThis.Cottontail.node.value;`;
    }
    if (path.startsWith("replace-raw:")) {
      const name = path.slice("replace-raw:".length);
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `globalThis.Cottontail={};globalThis.__profilePack=cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)});`;
    }
    if (path.startsWith("replace-cottontail:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `globalThis.Cottontail={node:new Proxy({},{get(){return cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)}).modules[${JSON.stringify(modulePath)}]}})};void globalThis.Cottontail.node.value;`;
    }
    if (path.startsWith("js-table:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `const __profileDefinitions=Array.from({length:100},(_,i)=>["key"+i,"unused","unused"]);__profileDefinitions.push(["value",${JSON.stringify(name)},${JSON.stringify(modulePath)}]);const __profileTable=new Map(__profileDefinitions.map(d=>[d[0],d]));globalThis.__profileProxy=new Proxy({},{get(object,property){if(Object.prototype.hasOwnProperty.call(object,property))return object[property];const d=__profileTable.get(property);if(d==null)return undefined;const value=cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)}).modules[d[2]];Object.defineProperty(object,property,{value,configurable:true});return value}});void globalThis.__profileProxy.value;`;
    }
    if (path.startsWith("js-cache:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      return `const __profileCache=new Map; const __profileLoad=(name,path)=>{let pack=__profileCache.get(name);if(pack==null){const executable=String(cottontail.execPath()).split(String.fromCharCode(92)).join("/");const directory=executable.slice(0,executable.lastIndexOf("/"));pack=cottontail.loadCapabilityBytecode(directory+"/cottontail-stdlib/"+name+"/main.jsc");if(!pack||!pack.modules||typeof pack.modules!=="object")throw new Error("bad pack");__profileCache.set(name,pack)}const value=pack.modules[path];if(value==null)throw new Error("bad module");return value}; Object.defineProperty(globalThis,"__profileGetter",{configurable:true,get(){return __profileLoad(${JSON.stringify(name)},${JSON.stringify(modulePath)})}});void globalThis.__profileGetter;`;
    }
    if (path.startsWith("js-path:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      return `Object.defineProperty(globalThis, "__profileGetter", { configurable: true, get() { const executable=String(cottontail.execPath()).split(String.fromCharCode(92)).join("/"); const directory=executable.slice(0,executable.lastIndexOf("/")); return cottontail.loadCapabilityBytecode(directory+"/cottontail-stdlib/"+${JSON.stringify(name)}+"/main.jsc").modules[${JSON.stringify(modulePath)}]; } }); void globalThis.__profileGetter;`;
    }
    if (path.startsWith("js-helper:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `const __profileLoad = () => cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)}).modules[${JSON.stringify(modulePath)}]; Object.defineProperty(globalThis, "__profileGetter", { configurable: true, get() { return __profileLoad(); } }); void globalThis.__profileGetter;`;
    }
    if (path.startsWith("js-proxy:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `globalThis.__profileProxy = new Proxy({}, { get() { return cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)}).modules[${JSON.stringify(modulePath)}]; } }); void globalThis.__profileProxy.value;`;
    }
    if (path.startsWith("js-getter:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `Object.defineProperty(globalThis, "__profileGetter", { configurable: true, get() { return cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)}).modules[${JSON.stringify(modulePath)}]; } }); void globalThis.__profileGetter;`;
    }
    if (path.startsWith("raw-module:")) {
      const [, name, ...moduleParts] = path.split(":");
      const modulePath = moduleParts.join(":");
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `globalThis.__profileModule = cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)}).modules[${JSON.stringify(modulePath)}];`;
    }
    if (path.startsWith("raw:")) {
      const name = path.slice(4);
      const capabilityPath = join(dirname(resolve(binary)), "cottontail-stdlib", name, "main.jsc");
      return `globalThis.__profilePack_${name.replaceAll("-", "_")} = cottontail.loadCapabilityBytecode(${JSON.stringify(capabilityPath)});`;
    }
    return `void Cottontail.${path};`;
  }).join("\n");
  writeFileSync(fixture, `
${accesses}
setInterval(() => {}, 60000);
`);

  // Keep runtime-module/source caches isolated from previously built binaries;
  // otherwise a local A/B can accidentally execute an older core bootstrap.
  const childOptions = {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, XDG_CACHE_HOME: join(fixtureRoot, "cache") },
  };
  // Prime the generated entry/runtime bytecode before measuring the runtime
  // process. This profiler is for capability retention, not compiler memory.
  const warm = spawn(resolve(binary), [fixture], childOptions);
  await new Promise(resolveWait => setTimeout(resolveWait, 500));
  if (warm.exitCode != null) throw new Error(`${name} warmup exited with status ${warm.exitCode}`);
  warm.kill("SIGTERM");
  await new Promise(resolveExit => warm.once("exit", resolveExit));

  const child = spawn(resolve(binary), [fixture], childOptions);
  const exitStatus = new Promise(resolveStatus => child.once("exit", resolveStatus));
  const samples = [];
  const sampler = setInterval(() => {
    const rss = rssKiB(child.pid);
    if (rss != null) samples.push(rss);
  }, 20);

  await new Promise(resolveWait => setTimeout(resolveWait, 1000));
  if (child.exitCode != null) throw new Error(`${name} exited with status ${child.exitCode}`);

  const result = {
    after: name,
    capability_count: prefix.length,
    peak_rss_mib: samples.length ? Math.max(...samples) / 1024 : null,
    settled_rss_mib: (rssKiB(child.pid) ?? 0) / 1024,
    settled_footprint_mib: footprintMiB(child.pid),
  };
  clearInterval(sampler);
  child.kill("SIGTERM");
  await exitStatus;
  return result;
}

try {
  const prefix = [];
  console.log(JSON.stringify(await measure(prefix)));
  for (const capability of capabilities) {
    prefix.push(capability);
    console.log(JSON.stringify(await measure(prefix)));
  }
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
