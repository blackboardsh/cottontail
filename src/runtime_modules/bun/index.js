import "./ffi.js";

function shellEscape(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:.,=+@%-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function interpolate(strings, values) {
  let out = "";
  for (let index = 0; index < strings.length; index += 1) {
    out += strings[index];
    if (index < values.length) {
      const value = values[index];
      out += Array.isArray(value) ? value.map(shellEscape).join(" ") : shellEscape(value);
    }
  }
  return out;
}

function runShell(command, capture) {
  const isWin = cottontail.platform() === "win32";
  const result = cottontail.spawnSync(isWin ? "cmd" : "sh", isWin ? ["/d", "/s", "/c", command] : ["-c", command], {
    stdio: capture ? "pipe" : "inherit",
  });
  const output = { exitCode: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  if (result.status !== 0) {
    const error = new Error(`Command failed (${result.status}): ${command}`);
    error.exitCode = result.status;
    error.stdout = output.stdout;
    error.stderr = output.stderr;
    throw error;
  }
  return output;
}

class ShellCommand {
  constructor(command) {
    this.command = command;
    this.capture = false;
    this.promise = null;
  }
  quiet() {
    this.capture = true;
    return this;
  }
  run(capture = this.capture) {
    if (!this.promise || capture !== this.capture) {
      this.promise = Promise.resolve().then(() => runShell(this.command, capture));
    }
    return this.promise;
  }
  text() {
    return this.run(true).then((result) => result.stdout);
  }
  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }
  catch(reject) {
    return this.run().catch(reject);
  }
}

export function $(strings, ...values) {
  return new ShellCommand(interpolate(strings, values));
}

function pathJoin(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

function bunBinary() {
  const exe = cottontail.platform() === "win32" ? "bun.exe" : "bun";
  const candidate = pathJoin(cottontail.cwd(), "vendors", "bun", exe);
  return cottontail.existsSync(candidate) ? candidate : exe;
}

const bunBuildDriver = `
const spec = await Bun.file(process.argv[2]).json();
const result = await Bun.build(spec);
const outputs = [];
for (const output of result.outputs || []) {
  outputs.push({ path: output.path || "", text: await output.text() });
}
console.log(JSON.stringify({ success: result.success !== false, logs: result.logs || [], outputs }));
`;

export async function build(options) {
  const tmp = pathJoin(cottontail.cwd(), ".cottontail-tmp", "bun-build");
  cottontail.mkdirSync(tmp, true);
  const id = `${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  const specPath = pathJoin(tmp, `build-${id}.json`);
  const driverPath = pathJoin(tmp, "bun-build-driver.mjs");
  cottontail.writeFile(specPath, JSON.stringify(options));
  cottontail.writeFile(driverPath, bunBuildDriver);
  const result = cottontail.spawnSync(bunBinary(), [driverPath, specPath], { stdio: "pipe" });
  if (result.status !== 0) {
    const error = new Error(result.stderr || result.stdout || "Bun.build failed");
    error.exitCode = result.status;
    throw error;
  }
  const parsed = JSON.parse(result.stdout);
  return {
    success: parsed.success,
    logs: parsed.logs,
    outputs: (parsed.outputs || []).map((output) => ({
      path: output.path,
      text: async () => output.text,
    })),
  };
}

function guessMimeType(path) {
  const lower = String(path).toLowerCase();
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

export function file(path) {
  const filePath = String(path);
  return {
    name: filePath.split("/").pop() || filePath,
    type: guessMimeType(filePath),
    get size() {
      const result = cottontail.spawnSync("sh", ["-c", `wc -c < ${shellEscape(filePath)}`], { stdio: "pipe" });
      return result.status === 0 ? Number(result.stdout.trim()) || 0 : 0;
    },
    async exists() {
      return cottontail.existsSync(filePath);
    },
    async text() {
      return cottontail.readFile(filePath);
    },
    async json() {
      return JSON.parse(cottontail.readFile(filePath));
    },
    async arrayBuffer() {
      return cottontail.readFileBuffer(filePath);
    },
    writer() {
      const chunks = [];
      return {
        write(chunk) { chunks.push(chunk); },
        end(chunk) {
          if (chunk != null) chunks.push(chunk);
          const text = chunks.map((item) => typeof item === "string" ? item : new TextDecoder().decode(item)).join("");
          cottontail.writeFile(filePath, text);
        },
      };
    },
  };
}

export async function write(path, data) {
  cottontail.writeFile(String(path), data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : String(data));
}

const BunObject = globalThis.Bun ?? {};
BunObject.argv = ["cottontail", ...(cottontail.args || [])];
BunObject.env = globalThis.process?.env ?? cottontail.env();
BunObject.build = build;
BunObject.file = file;
BunObject.write = write;
globalThis.Bun = BunObject;

export { BunObject as Bun };
export default BunObject;
