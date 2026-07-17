import fs, {
  ReadStream,
  WriteStream,
  closeSync,
  createReadStream,
  createWriteStream,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import { getEventListeners } from "node:events";
import { promisify } from "node:util";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
  } catch (error: any) {
    assert(error?.code === code, `expected ${code}, received ${error?.code}: ${error?.message}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

const temp = process.env.COTTONTAIL_TMP_DIR;
assert(temp, "COTTONTAIL_TMP_DIR missing");
const root = `${temp}/node-fs-source-conformance`;
rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const file = `${root}/file.txt`;
writeFileSync(file, "abcdef");

expectCode(() => readFileSync(file, "not-an-encoding"), "ERR_INVALID_ARG_VALUE");
expectCode(() => fs.readFile(file, "not-an-encoding", () => {}), "ERR_INVALID_ARG_VALUE");
expectCode(() => createReadStream(file, "not-an-encoding"), "ERR_INVALID_ARG_VALUE");
expectCode(() => readFileSync(`${root}/nul\0path`), "ERR_INVALID_ARG_VALUE");
assert(fs.existsSync(`${root}/nul\0path`) === false, "existsSync must suppress invalid paths");
expectCode(() => fs.mkdirSync("", { recursive: true }), "ENOENT");
expectCode(() => fs.mkdirSync(`${root}/invalid-options`, { recursive: "yes" as any }), "ERR_INVALID_ARG_TYPE");
expectCode(() => fs.mkdtempSync(`${root}/missing/child-`), "ENOENT");
expectCode(() => fs.readdirSync(file), "ENOTDIR");
expectCode(() => openSync(file, 0x100000000), "ERR_OUT_OF_RANGE");
expectCode(() => openSync(file, 0, 0x100000000), "ERR_OUT_OF_RANGE");

try {
  fs.fdatasyncSync(50000);
  throw new Error("invalid fdatasync unexpectedly succeeded");
} catch (error: any) {
  assert(error?.code === "EBADF" && error?.fd === 50000, "fdatasync descriptor metadata mismatch");
}
await fsp.fdatasync(50000).then(
  () => { throw new Error("invalid promise fdatasync unexpectedly succeeded"); },
  (error: any) => assert(error?.code === "EBADF" && error?.fd === 50000, "promise fdatasync metadata mismatch"),
);

const blankStats = new fs.Stats();
assert(blankStats.dev === undefined, "blank Stats fields must remain undefined");
blankStats.atimeMs = 123;
assert(blankStats.atime.getTime() === 123, "Stats date getter must observe the first millisecond value");
blankStats.atimeMs = 456;
assert(blankStats.atime.getTime() === 123, "Stats date getter must cache its Date");

const optionalCloseFd = openSync(file, "r");
fs.close(optionalCloseFd);
await Promise.resolve();
expectCode(() => fs.fstatSync(optionalCloseFd), "EBADF");

const fd = openSync(file, "r+");
try {
  const promiseRead = await fsp.read(fd, Buffer.alloc(2), 0, 2, 0);
  assert(promiseRead.bytesRead === 2 && promiseRead.buffer.toString() === "ab", "promise read contract mismatch");
  const promiseWrite = await fsp.write(fd, "Z", 0, "utf8");
  assert(promiseWrite.bytesWritten === 1 && promiseWrite.buffer === "Z", "promise write contract mismatch");
  await fsp.write(fd, "a", 0, "utf8");

  const defaultRead = await new Promise<Buffer>((resolve, reject) => {
    fs.read(fd, (error, bytesRead, buffer) => {
      if (error) return reject(error);
      assert(bytesRead === 6, `default read byte count: ${bytesRead}`);
      resolve(buffer);
    });
  });
  assert(defaultRead.subarray(0, 6).toString() === "abcdef", "default read buffer mismatch");

  const writeResult = await promisify(fs.write)(fd, "XY", 2);
  assert(writeResult.bytesWritten === 2 && writeResult.buffer === "XY", "promisified write contract mismatch");
  const readResult = await promisify(fs.read)(fd, Buffer.alloc(2), 0, 2, 2);
  assert(readResult.bytesRead === 2 && readResult.buffer.toString() === "XY", "promisified read contract mismatch");
  assert(readSync(0x7fffffff, Buffer.alloc(0), 0, 0, null) === 0, "zero-length read must not touch fd");
} finally {
  closeSync(fd);
}

const abortedPath = `${root}/aborted.txt`;
const alreadyAborted = AbortSignal.abort(new Error("cancelled"));
await fsp.writeFile(abortedPath, "no", { signal: alreadyAborted }).then(
  () => { throw new Error("already-aborted write resolved"); },
  error => assert(error === alreadyAborted.reason, "abort reason identity mismatch"),
);
assert(!fs.existsSync(abortedPath), "already-aborted write touched the filesystem");

const controller = new AbortController();
const pendingWrite = fsp.writeFile(abortedPath, "no", { signal: controller.signal });
assert(getEventListeners(controller.signal, "abort").length === 1, "pending write abort listener missing");
process.nextTick(() => controller.abort(new Error("late-cancel")));
await pendingWrite.then(
  () => { throw new Error("next-tick aborted write resolved"); },
  error => assert(error === controller.signal.reason, "late abort reason identity mismatch"),
);
assert(getEventListeners(controller.signal, "abort").length === 0, "settled write retained abort listener");
assert(!fs.existsSync(abortedPath), "next-tick aborted write touched the filesystem");

const large = `${root}/large.bin`;
writeFileSync(large, Buffer.alloc(256 * 1024));
const previousLimit = globalThis.__cottontailSyntheticAllocationLimit;
globalThis.__cottontailSyntheticAllocationLimit = 64 * 1024;
try {
  expectCode(() => readFileSync(large), "ENOMEM");
} finally {
  globalThis.__cottontailSyntheticAllocationLimit = previousLimit;
}

const callableRead = ReadStream(file);
assert(callableRead instanceof ReadStream, "ReadStream must be callable without new");
callableRead.destroy();
const callableWrite = WriteStream(`${root}/callable.txt`);
assert(callableWrite instanceof WriteStream, "WriteStream must be callable without new");
callableWrite.end("callable");
await new Promise<void>((resolve, reject) => {
  callableWrite.once("close", resolve);
  callableWrite.once("error", reject);
});

const order: string[] = [];
await new Promise<void>((resolve, reject) => {
  const stream = createWriteStream(`${root}/ordered.txt`);
  stream.on("open", () => order.push("open"));
  stream.on("finish", () => order.push("finish"));
  stream.on("error", reject);
  stream.close(() => {
    order.push("close");
    resolve();
  });
});
assert(order.join(",") === "open,finish,close", `write stream lifecycle order: ${order.join(",")}`);

const handle = await fsp.open(file, "r");
assert(typeof handle.getAsyncId() === "number", "FileHandle async id missing");
await handle[Symbol.asyncDispose]();
await handle.read(Buffer.alloc(1)).then(
  () => { throw new Error("closed FileHandle read resolved"); },
  error => assert(error?.code === "EBADF", `closed FileHandle code: ${error?.code}`),
);

const bigint = statSync(file, { bigint: true });
assert(typeof bigint.size === "bigint" && typeof bigint.mtimeNs === "bigint", "bigint stat contract mismatch");

console.log("node fs source conformance passed");
