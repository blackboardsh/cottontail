import "../bun/ffi.js";

function assertOk(result, action) {
  if (result.status !== 0) throw new Error(`${action}: ${result.stderr || result.stdout}`);
  return result;
}

function shellEscape(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function makeBuffer(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  bytes.toString = function toString(encoding = "utf8") {
    if (encoding === "base64" && globalThis.Buffer?.from) return globalThis.Buffer.from(this).toString("base64");
    return new TextDecoder().decode(this);
  };
  return bytes;
}

export function existsSync(path) {
  return cottontail.existsSync(String(path));
}

export function accessSync(path) {
  if (!existsSync(path)) throw new Error(`ENOENT: no such file or directory, access '${path}'`);
}

export function readFileSync(path, encoding = undefined) {
  if (encoding) return cottontail.readFile(String(path));
  return makeBuffer(cottontail.readFileBuffer(String(path)));
}

export function writeFileSync(path, data) {
  cottontail.writeFile(String(path), data);
}

export function mkdirSync(path, options = {}) {
  cottontail.mkdirSync(String(path), Boolean(options?.recursive));
}

export function rmSync(path, options = {}) {
  cottontail.rmSync(String(path), Boolean(options?.recursive), Boolean(options?.force));
}

export function rmdirSync(path) {
  rmSync(path, { recursive: false, force: false });
}

export function unlinkSync(path) {
  cottontail.unlinkSync(String(path));
}

export function renameSync(oldPath, newPath) {
  assertOk(cottontail.spawnSync("mv", [String(oldPath), String(newPath)], { stdio: "pipe" }), "renameSync");
}

export function readdirSync(path, options = undefined) {
  const result = assertOk(cottontail.spawnSync("ls", ["-A", String(path)], { stdio: "pipe" }), "readdirSync");
  const names = result.stdout.split("\n").filter(Boolean);
  if (!options?.withFileTypes) return names;
  return names.map((name) => ({
    name,
    isDirectory: () => cottontail.spawnSync("sh", ["-c", `test -d ${shellEscape(`${path}/${name}`)}`], { stdio: "pipe" }).status === 0,
    isFile: () => cottontail.spawnSync("sh", ["-c", `test -f ${shellEscape(`${path}/${name}`)}`], { stdio: "pipe" }).status === 0,
  }));
}

export function statSync(path) {
  const result = assertOk(cottontail.spawnSync("sh", ["-c", `wc -c < ${shellEscape(path)}`], { stdio: "pipe" }), "statSync");
  return { size: Number(result.stdout.trim()) || 0, isFile: () => true, isDirectory: () => false };
}

export function createReadStream(path) {
  return {
    path,
    on() { return this; },
    once() { return this; },
    pipe(destination) { return destination; },
    destroy() {},
  };
}

export default {
  accessSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
};
