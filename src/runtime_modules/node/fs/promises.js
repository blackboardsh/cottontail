import {
  accessSync,
  mkdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "../fs.js";

export async function readFile(path, encoding = undefined) {
  return readFileSync(path, encoding);
}

export async function writeFile(path, data) {
  writeFileSync(path, data);
}

export async function access(path) {
  accessSync(path);
}

export async function mkdir(path, options = {}) {
  mkdirSync(path, options);
}

export async function rmdir(path) {
  rmdirSync(path);
}

export async function unlink(path) {
  unlinkSync(path);
}

export async function mkdtemp(prefix) {
  const path = `${prefix}${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
  mkdirSync(path, { recursive: true });
  return path;
}

export async function rm(path, options = {}) {
  rmSync(path, options);
}

export default { access, mkdir, mkdtemp, readFile, rm, rmdir, unlink, writeFile };
