import { createHash } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const companions = ['cottontail-core', 'cottontail-stdlib'];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function inventory(root, executableName) {
  const files = [];
  function visit(relativePath) {
    const path = join(root, relativePath);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Runtime bundle contains a symbolic link: ${path}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relativePath}/${name}`);
    } else if (stat.isFile()) {
      files.push({ path: relativePath, mode: stat.mode & 0o777, sha256: digest(readFileSync(path)) });
    } else {
      throw new Error(`Runtime bundle contains a non-file: ${path}`);
    }
  }
  visit(executableName);
  for (const name of companions) if (existsSync(join(root, name))) visit(name);
  return files;
}

// Freeze bytecode and native capability libraries together with the executable.
// Their digest belongs in the cache identity even when the executable is unchanged.
export function pinRuntimeBundle(sourcePath, stateRoot) {
  const canonicalSource = realpathSync(sourcePath);
  const sourceRoot = dirname(canonicalSource);
  const executableName = basename(canonicalSource);
  const toolsRoot = join(stateRoot, 'tools');
  mkdirSync(toolsRoot, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    const files = inventory(sourceRoot, executableName);
    const signature = JSON.stringify(files);
    const bundleHash = digest(signature);
    const pinDir = join(toolsRoot, bundleHash);
    if (!existsSync(pinDir)) {
      const stage = mkdtempSync(join(toolsRoot, '.runtime-'));
      try {
        for (const file of files) {
          const destination = join(stage, file.path);
          mkdirSync(dirname(destination), { recursive: true });
          copyFileSync(join(sourceRoot, file.path), destination);
          chmodSync(destination, file.mode);
        }
        if (JSON.stringify(inventory(stage, executableName)) !== signature ||
            JSON.stringify(inventory(sourceRoot, executableName)) !== signature) continue;
        try { renameSync(stage, pinDir); }
        catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !existsSync(pinDir)) throw error;
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    if (JSON.stringify(inventory(pinDir, executableName)) !== signature) {
      throw new Error(`Pinned Cottontail runtime bundle hash mismatch: ${pinDir}`);
    }
    return {
      sourcePath: canonicalSource,
      sourceHash: files[0].sha256,
      bundleHash,
      pinnedPath: join(pinDir, executableName),
    };
  }
  throw new Error('Cottontail runtime changed while being pinned; rebuilds must not overlap a baseline run.');
}
