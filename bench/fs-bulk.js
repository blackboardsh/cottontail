import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const treeFiles = Number(process.env.COTTONTAIL_FS_BENCH_TREE_FILES ?? 1_500);
const largeFileBytes = Number(process.env.COTTONTAIL_FS_BENCH_LARGE_BYTES ?? 64 * 1024 * 1024);
const iterations = Number(process.env.COTTONTAIL_FS_BENCH_ITERATIONS ?? 5);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cottontail-fs-bulk-bench-"));
const sourceTree = path.join(root, "source-tree");
const largeSource = path.join(root, "large-source.bin");

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function measure(operation) {
  const started = performance.now();
  operation();
  return performance.now() - started;
}

function makeTree() {
  const payload = Buffer.alloc(1_024, 0x61);
  for (let index = 0; index < treeFiles; index += 1) {
    const directory = path.join(sourceTree, `group-${index % 50}`, `bucket-${index % 10}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `file-${index}.txt`), payload);
  }
  const linkTarget = path.join(sourceTree, "link-target.txt");
  fs.writeFileSync(linkTarget, "link target");
  if (process.platform !== "win32") {
    fs.symlinkSync("link-target.txt", path.join(sourceTree, "relative-link"));
  }
}

function makeLargeFile() {
  const descriptor = fs.openSync(largeSource, "w");
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x5a);
    for (let offset = 0; offset < largeFileBytes; offset += chunk.byteLength) {
      fs.writeSync(descriptor, chunk, 0, Math.min(chunk.byteLength, largeFileBytes - offset));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

async function main() {
  makeTree();
  makeLargeFile();

  const asyncTreeRemoveMs = [];
  const asyncTreeRemoveTimerDelayMs = [];
  const treeCopyMs = [];
  const treeRemoveMs = [];
  const largeCopyMs = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const treeCopy = path.join(root, `tree-copy-${iteration}`);
    treeCopyMs.push(measure(() => fs.cpSync(sourceTree, treeCopy, { recursive: true })));
    treeRemoveMs.push(measure(() => fs.rmSync(treeCopy, { recursive: true })));

    const largeCopy = path.join(root, `large-copy-${iteration}.bin`);
    largeCopyMs.push(measure(() => fs.copyFileSync(largeSource, largeCopy)));
    fs.rmSync(largeCopy);
  }

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const treeCopy = path.join(root, `async-tree-copy-${iteration}`);
    fs.cpSync(sourceTree, treeCopy, { recursive: true });
    const started = performance.now();
    const timer = new Promise(resolve => {
      setTimeout(() => {
        asyncTreeRemoveTimerDelayMs.push(performance.now() - started);
        resolve();
      }, 0);
    });
    await Promise.all([
      fsp.rm(treeCopy, { recursive: true }),
      timer,
    ]);
    asyncTreeRemoveMs.push(performance.now() - started);
  }

  console.log(JSON.stringify({
    iterations,
    largeFileBytes,
    medianMs: {
      asyncTreeRemove: median(asyncTreeRemoveMs),
      asyncTreeRemoveTimerDelay: median(asyncTreeRemoveTimerDelayMs),
      largeFileCopy: median(largeCopyMs),
      treeCopy: median(treeCopyMs),
      treeRemove: median(treeRemoveMs),
    },
    samplesMs: {
      asyncTreeRemove: asyncTreeRemoveMs,
      asyncTreeRemoveTimerDelay: asyncTreeRemoveTimerDelayMs,
      largeFileCopy: largeCopyMs,
      treeCopy: treeCopyMs,
      treeRemove: treeRemoveMs,
    },
    treeFiles,
  }, null, 2));
}

try {
  await main();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
