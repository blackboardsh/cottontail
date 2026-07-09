import {
  F_OK,
  Stats,
  access,
  accessSync,
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  createWriteStream,
  exists,
  fchmodSync,
  fdatasyncSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  futimesSync,
  globSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  openAsBlob,
  openSync,
  opendirSync,
  promises as fsObjectPromises,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  readvSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
  writeSync,
  writevSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const tmpDir = process.env.COTTONTAIL_TMP_DIR;
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");

const root = `${tmpDir}/node-fs-surface`;
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const filePath = `${root}/file.txt`;
writeFileSync(filePath, "alpha");
appendFileSync(filePath, " beta");
assert(readFileSync(filePath, "utf8") === "alpha beta", "append/readFile mismatch");

accessSync(filePath, F_OK);
await new Promise<void>((resolve, reject) => {
  access(filePath, constants.F_OK, (error) => error ? reject(error) : resolve());
});
await new Promise<void>((resolve, reject) => {
  exists(filePath, (present) => present ? resolve() : reject(new Error("exists callback mismatch")));
});

const stats = statSync(filePath);
assert(stats instanceof Stats, "statSync should return Stats");
assert(stats.isFile(), "statSync isFile mismatch");
assert(Number.isFinite(stats.ino), "statSync ino missing");
assert(statfsSync(root).bsize > 0, "statfsSync bsize missing");
const bigintStats = statSync(filePath, { bigint: true });
assert(typeof bigintStats.size === "bigint", "statSync bigint size mismatch");
assert(typeof bigintStats.mtimeNs === "bigint", "statSync bigint mtimeNs mismatch");
assert(bigintStats.isFile(), "statSync bigint isFile mismatch");
assert(statSync(`${root}/missing.txt`, { throwIfNoEntry: false }) === undefined, "statSync throwIfNoEntry mismatch");
assert(typeof statfsSync(root, { bigint: true }).bsize === "bigint", "statfsSync bigint mismatch");

chmodSync(filePath, 0o644);
const fd = openSync(filePath, "r+");
try {
  assert(fstatSync(fd).isFile(), "fstatSync isFile mismatch");
  fchmodSync(fd, 0o644);
  writeSync(fd, "HELLO", 0);
  const readBuffer = new Uint8Array(5);
  assert(readSync(fd, readBuffer, 0, 5, 0) === 5, "readSync byte count mismatch");
  assert(new TextDecoder().decode(readBuffer) === "HELLO", "readSync content mismatch");

  ftruncateSync(fd, 5);
  futimesSync(fd, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
  fdatasyncSync(fd);
  fsyncSync(fd);
} finally {
  closeSync(fd);
}
assert(readFileSync(filePath, "utf8") === "HELLO", "ftruncate/writeSync mismatch");

const fdReadFilePath = `${root}/fd-read-file.txt`;
writeFileSync(fdReadFilePath, "abcdef");
const fdReadFile = openSync(fdReadFilePath, "r");
try {
  const skipped = new Uint8Array(2);
  assert(readSync(fdReadFile, skipped, 0, 2, null) === 2, "fd readFile setup mismatch");
  assert(readFileSync(fdReadFile, "utf8") === "cdef", "readFileSync fd should read from current position");
} finally {
  closeSync(fdReadFile);
}

const fdWriteFilePath = `${root}/fd-write-file.txt`;
writeFileSync(fdWriteFilePath, "abcdef");
const fdWriteFile = openSync(fdWriteFilePath, "r+");
try {
  const skipped = new Uint8Array(2);
  assert(readSync(fdWriteFile, skipped, 0, 2, null) === 2, "fd writeFile setup mismatch");
  writeFileSync(fdWriteFile, "ZZ");
} finally {
  closeSync(fdWriteFile);
}
assert(readFileSync(fdWriteFilePath, "utf8") === "abZZef", "writeFileSync fd should write at current position");

truncateSync(filePath, 4);
assert(readFileSync(filePath, "utf8") === "HELL", "truncateSync mismatch");
utimesSync(filePath, new Date("2021-01-01T00:00:00Z"), new Date("2021-01-01T00:00:00Z"));

const vectorPath = `${root}/vector.txt`;
const vectorFd = openSync(vectorPath, "w+");
try {
  assert(writevSync(vectorFd, [new TextEncoder().encode("ab"), new TextEncoder().encode("cd")], 0) === 4, "writevSync mismatch");
  const left = new Uint8Array(2);
  const right = new Uint8Array(2);
  assert(readvSync(vectorFd, [left, right], 0) === 4, "readvSync mismatch");
  assert(new TextDecoder().decode(left) + new TextDecoder().decode(right) === "abcd", "readvSync content mismatch");
} finally {
  closeSync(vectorFd);
}

const copyPath = `${root}/copy.txt`;
copyFileSync(filePath, copyPath);
assert(readFileSync(copyPath, "utf8") === "HELL", "copyFileSync mismatch");

const renamedPath = `${root}/renamed.txt`;
renameSync(copyPath, renamedPath);
assert(realpathSync(renamedPath).endsWith("/renamed.txt"), "realpathSync mismatch");

const hardLinkPath = `${root}/hard-link.txt`;
linkSync(renamedPath, hardLinkPath);
assert(statSync(hardLinkPath).size === statSync(renamedPath).size, "linkSync mismatch");

const symlinkPath = `${root}/symbolic.txt`;
symlinkSync(renamedPath, symlinkPath);
assert(readlinkSync(symlinkPath) === renamedPath, "readlinkSync mismatch");
assert(lstatSync(symlinkPath).isSymbolicLink(), "lstatSync symbolic link mismatch");

const dir = opendirSync(root);
try {
  assert(dir.readSync()?.name, "opendirSync/readSync mismatch");
} finally {
  dir.closeSync();
}

const nested = `${root}/nested`;
mkdirSync(`${nested}/child`, { recursive: true });
writeFileSync(`${nested}/child/match.txt`, "glob");
cpSync(nested, `${root}/nested-copy`, { recursive: true });
assert(readFileSync(`${root}/nested-copy/child/match.txt`, "utf8") === "glob", "cpSync recursive mismatch");
assert(globSync("nested/**/*.txt", { cwd: root }).includes("nested/child/match.txt"), "globSync mismatch");

const disposable = mkdtempDisposableSync(`${root}/dispose-`);
assert(statSync(disposable.path).isDirectory(), "mkdtempDisposableSync path mismatch");
disposable.remove();
assert(!cottontail.existsSync(disposable.path), "mkdtempDisposableSync remove mismatch");

await new Promise<void>((resolve, reject) => {
  const streamPath = `${root}/stream.txt`;
  const stream = createWriteStream(streamPath);
  stream.on("error", reject);
  stream.on("close", () => {
    try {
      assert(readFileSync(streamPath, "utf8") === "stream-data", "createWriteStream mismatch");
      resolve();
    } catch (error) {
      reject(error);
    }
  });
  stream.end("stream-data");
});

const blob = await openAsBlob(filePath, { type: "text/plain" });
assert(blob.size === 4, "openAsBlob size mismatch");

await fsPromises.appendFile(filePath, "!");
assert(await fsPromises.readFile(filePath, "utf8") === "HELL!", "fs/promises append/read mismatch");
const handle = await fsPromises.open(`${root}/promise-handle.txt`, "w+");
try {
  assert(typeof handle.getAsyncId() === "number", "FileHandle getAsyncId mismatch");
  await handle.write("ok", 0);
  const promiseRead = new Uint8Array(2);
  const readResult = await handle.read(promiseRead, 0, 2, 0);
  assert(readResult.bytesRead === 2, "FileHandle read count mismatch");
  assert(new TextDecoder().decode(promiseRead) === "ok", "FileHandle read content mismatch");

  await handle.truncate(0);
  await handle.writeFile("abcdef");
  assert(await handle.readFile("utf8") === "", "FileHandle readFile should honor current position");
  const streamText = await new Promise<string>((resolve, reject) => {
    let text = "";
    handle.createReadStream({ start: 1, end: 3, encoding: "utf8", autoClose: false })
      .on("data", (chunk: unknown) => { text += String(chunk); })
      .on("error", reject)
      .on("end", () => resolve(text));
  });
  assert(streamText === "bcd", "FileHandle createReadStream range mismatch");
  await new Promise<void>((resolve, reject) => {
    const stream = handle.createWriteStream({ start: 3, autoClose: false });
    stream.on("error", reject);
    stream.on("close", () => resolve());
    stream.end("XYZ");
  });
  const first = new Uint8Array(3);
  const second = new Uint8Array(3);
  const vectorRead = await handle.readv([first, second], 0);
  assert(vectorRead.bytesRead === 6, "FileHandle readv count mismatch");
  assert(new TextDecoder().decode(first) + new TextDecoder().decode(second) === "abcXYZ", "FileHandle createWriteStream/readv mismatch");
  const vectorWrite = await handle.writev([new TextEncoder().encode("12"), new TextEncoder().encode("3")], 0);
  assert(vectorWrite.bytesWritten === 3, "FileHandle writev count mismatch");
  assert(readFileSync(`${root}/promise-handle.txt`, "utf8") === "123XYZ", "FileHandle writev content mismatch");
} finally {
  await handle.close();
}

const objectPromisesHandle = await fsObjectPromises.open(`${root}/object-promises-handle.txt`, "w+");
try {
  await objectPromisesHandle.writeFile("object");
  assert(typeof objectPromisesHandle.readv === "function", "fs.promises FileHandle readv missing");
} finally {
  await objectPromisesHandle.close();
}

const linePath = `${root}/lines.txt`;
writeFileSync(linePath, "one\ntwo\n");
const lineHandle = await fsPromises.open(linePath, "r");
const lines: string[] = [];
for await (const line of lineHandle.readLines()) lines.push(String(line));
assert(lines.join("|") === "one|two", "FileHandle readLines mismatch");
assert(lineHandle.fd === -1, "FileHandle readLines should auto-close by default");

const webHandle = await fsPromises.open(linePath, "r");
try {
  const reader = webHandle.readableWebStream().getReader();
  let webText = "";
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    webText += new TextDecoder().decode(item.value);
  }
  assert(webText === "one\ntwo\n", "FileHandle readableWebStream mismatch");
  assert((await webHandle.stat()).isFile(), "FileHandle readableWebStream should leave handle open");
} finally {
  await webHandle.close();
}
assert((await fsPromises.glob("nested/**/*.txt", { cwd: root })).includes("nested/child/match.txt"), "fs/promises glob mismatch");

rmSync(root, { recursive: true, force: true });
console.log("node fs surface passed");
