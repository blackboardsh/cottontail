#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dylibCommands = new Set([
  'LC_LOAD_DYLIB', 'LC_LOAD_WEAK_DYLIB', 'LC_REEXPORT_DYLIB',
  'LC_LOAD_UPWARD_DYLIB', 'LC_LAZY_LOAD_DYLIB',
]);
const machoMagic = new Set([
  'feedface', 'cefaedfe', 'feedfacf', 'cffaedfe',
  'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca',
]);

// LC_ID_DYLIB is a library's identity, not something that must be loaded.
// Parse each architecture separately: an otherwise healthy universal binary
// must not conceal an external dependency in its other slice.
export function parseOtoolLoadCommands(output) {
  const slices = [];
  let slice;
  let command;
  for (const line of output.split(/\r?\n/)) {
    const header = line.trim().match(/^MH_(?:MAGIC|CIGAM)(?:_64)?\s+(\S+)\s+\S+\s+\S+\s+(\S+)/);
    if (header) {
      slice = { architecture: header[1].toLowerCase(), executable: header[2] === 'EXECUTE', dependencies: [], rpaths: [] };
      slices.push(slice);
      command = undefined;
      continue;
    }
    if (!slice) continue;
    const loadCommand = line.match(/^\s*cmd (LC_\S+)\s*$/);
    if (loadCommand) {
      command = loadCommand[1];
      continue;
    }
    const value = line.match(/^\s*(name|path) (.+) \(offset \d+\)\s*$/);
    if (!value) continue;
    if (value[1] === 'name' && dylibCommands.has(command)) {
      slice.dependencies.push({ path: value[2], weak: command === 'LC_LOAD_WEAK_DYLIB' });
    } else if (value[1] === 'path' && command === 'LC_RPATH') {
      slice.rpaths.push(value[2]);
    }
  }
  if (slices.length === 0) throw new Error('otool did not report a Mach-O header');
  return slices;
}

function inside(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function isAppleSystemLibrary(path) {
  if (!posix.isAbsolute(path)) return false;
  const normalized = posix.normalize(path);
  return ['/usr/lib/', '/System/Library/', '/System/iOSSupport/usr/lib/', '/System/iOSSupport/System/Library/']
    .some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
}

function isMachO(path) {
  const fd = openSync(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    return readSync(fd, magic, 0, 4, 0) === 4 && machoMagic.has(magic.toString('hex'));
  } finally {
    closeSync(fd);
  }
}

function inventory(root, inspect) {
  const visited = new Set();
  const records = [];
  function walk(path) {
    let actual;
    try {
      actual = realpathSync(path);
    } catch (error) {
      if (error.code === 'ENOENT') return; // A reference to this link will fail resolution below.
      throw error;
    }
    const status = statSync(actual);
    if (!inside(root, actual)) {
      if (status.isDirectory() || (status.isFile() && isMachO(actual))) {
        throw new Error(`Native runtime entry leaves the staged directory: ${path} -> ${actual}`);
      }
      return;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    if (status.isDirectory()) {
      for (const name of readdirSync(actual).sort()) walk(resolve(actual, name));
    } else if (status.isFile() && isMachO(actual)) {
      for (const slice of parseOtoolLoadCommands(inspect(actual))) {
        records.push({ ...slice, path: actual, key: `${actual}\0${slice.architecture}` });
      }
    }
  }
  walk(root);
  return records;
}

function expandPath(path, loader, executable, inheritedRpaths) {
  if (path === '@loader_path' || path.startsWith('@loader_path/')) {
    return [resolve(dirname(loader), `.${path.slice('@loader_path'.length)}`)];
  }
  if (path === '@executable_path' || path.startsWith('@executable_path/')) {
    return executable ? [resolve(dirname(executable), `.${path.slice('@executable_path'.length)}`)] : [];
  }
  if (path.startsWith('@rpath/')) {
    return inheritedRpaths.map((rpath) => (isAppleSystemLibrary(rpath) ? posix.resolve : resolve)(rpath, path.slice('@rpath/'.length)));
  }
  // System paths describe macOS, even when parser fixtures run on Windows.
  return isAbsolute(path) ? [isAppleSystemLibrary(path) ? posix.normalize(path) : resolve(path)] : [];
}

// The root is the complete staged runtime or application bundle. Never consult
// DYLD_LIBRARY_PATH, the current directory, or libraries installed on the host.
// The inspector is injectable so the load-command and resolution fixtures run
// on all release platforms; real artifacts are inspected with Apple's otool.
export function verifyMacosNativeDependencies(rootPath, {
  inspect = (path) => execFileSync('otool', ['-arch', 'all', '-hv', '-l', path], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }),
} = {}) {
  const root = realpathSync(rootPath);
  if (!statSync(root).isDirectory()) throw new Error(`Expected a staged runtime directory: ${root}`);
  const records = inventory(root, inspect);
  if (records.length === 0) throw new Error(`No Mach-O files found in ${root}`);
  const byKey = new Map(records.map((record) => [record.key, record]));
  const executables = records.filter((record) => record.executable);
  const verified = new Set();
  const failures = new Map();

  function bundledRecord(candidate, architecture) {
    if (!inside(root, candidate)) return undefined;
    try {
      const actual = realpathSync(candidate);
      return inside(root, actual) ? byKey.get(`${actual}\0${architecture}`) : undefined;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    }
  }

  function check(record, executable, inheritedRpaths = [], visiting = new Set()) {
    const ownRpaths = record.rpaths.flatMap((path) => expandPath(path, record.path, executable, inheritedRpaths));
    const rpaths = [...new Set([...ownRpaths, ...inheritedRpaths])];
    const context = JSON.stringify([record.key, executable, rpaths]);
    if (visiting.has(context)) return { errors: [], checked: new Set() };
    const nextVisiting = new Set([...visiting, context]);
    const errors = [];
    const checked = new Set([record.key]);
    const label = `${relative(root, record.path).split(sep).join('/')} (${record.architecture})`;
    for (const dependency of record.dependencies) {
      // Weak references are optional by definition, including Electrobun's CEF
      // import in system-webview builds that deliberately do not bundle CEF.
      if (dependency.weak || isAppleSystemLibrary(dependency.path)) continue;
      if (isAbsolute(dependency.path)) {
        errors.push(`${label}: external absolute dependency ${dependency.path}`);
        continue;
      }
      const candidates = expandPath(dependency.path, record.path, executable, rpaths);
      const target = candidates.map((path) => isAppleSystemLibrary(path)
        ? { system: true }
        : bundledRecord(path, record.architecture)).find(Boolean);
      if (!target) {
        errors.push(`${label}: unresolved bundled dependency ${dependency.path}`);
        continue;
      }
      if (target.system) continue;
      const child = check(target, executable, rpaths, nextVisiting);
      errors.push(...child.errors);
      for (const key of child.checked) checked.add(key);
    }
    return { errors, checked };
  }

  function accept(result) {
    for (const key of result.checked) verified.add(key);
  }

  const errors = [];
  for (const executable of executables) {
    const result = check(executable, executable.path);
    if (result.errors.length === 0) accept(result);
    else errors.push(...result.errors);
  }

  // Capabilities and plugins are loaded dynamically, so they may not appear in
  // an executable's load commands. Check every one using a matching bundled
  // executable's rpaths, and propagate a plugin loader's own rpaths to children.
  for (const record of records) {
    if (verified.has(record.key) || record.executable) continue;
    const hosts = executables.filter((host) => host.architecture === record.architecture);
    const contexts = hosts.length > 0 ? hosts : [undefined];
    for (const host of contexts) {
      const inheritedRpaths = host?.rpaths.flatMap((path) => expandPath(path, host.path, host.path, [])) ?? [];
      const result = check(record, host?.path, inheritedRpaths);
      if (result.errors.length === 0) {
        accept(result);
        break;
      }
      failures.set(record.key, result.errors);
    }
  }
  for (const [key, failure] of failures) {
    if (!verified.has(key)) errors.push(...failure);
  }
  const uniqueErrors = [...new Set(errors)];
  if (uniqueErrors.length > 0) {
    throw new Error(`Non-portable macOS native dependencies in ${root}:\n${uniqueErrors.map((error) => `  ${error}`).join('\n')}`);
  }
  return { root, files: new Set(records.map((record) => record.path)).size, slices: records.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3) {
    console.error('Usage: verify-macos-native-deps.js [staged runtime or application directory]');
    process.exit(2);
  }
  try {
    const root = process.argv[2] ?? fileURLToPath(new URL('../zig-out/bin', import.meta.url));
    const result = verifyMacosNativeDependencies(root);
    console.log(`OK ${result.files} Mach-O files (${result.slices} slices) have portable native dependencies in ${result.root}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
