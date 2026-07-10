import {
  closeSync,
  existsSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  symlinkSync,
  unwatchFile,
  watch,
  watchFile,
  writeFileSync,
} from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tmpDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");

const root = `${tmpDir}/node-fs`;
const childDir = `${root}/child`;
const filePath = `${childDir}/hello.txt`;
const linkPath = `${root}/hello-link.txt`;

mkdirSync(childDir, { recursive: true });
writeFileSync(filePath, "hello fs");

assert(existsSync(filePath), "existsSync did not find file");

const names = readdirSync(root).sort();
assert(names.includes("child"), `readdirSync missing child: ${names.join(",")}`);

const entries = readdirSync(root, { withFileTypes: true });
const childEntry = entries.find((entry) => entry.name === "child");
assert(childEntry, "readdirSync(withFileTypes) missing child");
assert(childEntry.isDirectory(), "Dirent.isDirectory mismatch");
assert(!childEntry.isFile(), "Dirent.isFile mismatch for directory");

const stats = statSync(filePath);
assert(stats.isFile(), "statSync file isFile mismatch");
assert(!stats.isDirectory(), "statSync file isDirectory mismatch");
assert(stats.size === "hello fs".length, `statSync size mismatch: ${stats.size}`);
assert(stats.mtime instanceof Date, "statSync mtime should be a Date");
assert(Number.isFinite(stats.mtimeMs), "statSync mtimeMs should be finite");
assert(stats.mtime.toISOString().length > 0, "statSync mtime should format as ISO");

const streamed = await new Promise<string>((resolve, reject) => {
  let text = "";
  createReadStream(filePath, { encoding: "utf8" })
    .on("data", (chunk) => {
      text += String(chunk);
    })
    .on("error", reject)
    .on("end", () => resolve(text));
});
assert(streamed === "hello fs", `createReadStream data mismatch: ${streamed}`);

const fd = openSync(filePath, "r");
const streamedFromFd = await new Promise<string>((resolve, reject) => {
  let text = "";
  createReadStream(filePath, { fd, autoClose: false, encoding: "utf8" })
    .on("data", (chunk) => {
      text += String(chunk);
    })
    .on("error", reject)
    .on("end", () => resolve(text));
});
assert(streamedFromFd === "hello fs", `createReadStream fd data mismatch: ${streamedFromFd}`);
closeSync(fd);

let watchFileCount = 0;
await new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("watchFile timeout")), 3000);
  const listener = (current: any, previous: any) => {
    watchFileCount += 1;
    try {
      assert(previous.size === "hello fs".length, `watchFile previous size mismatch: ${previous.size}`);
      assert(current.size === "HELLO FS".length, `watchFile current size mismatch: ${current.size}`);
      assert(current.size === previous.size, "watchFile should detect same-size edits");
      clearTimeout(timeout);
      unwatchFile(filePath, listener);
      resolve();
    } catch (error) {
      clearTimeout(timeout);
      unwatchFile(filePath, listener);
      reject(error);
    }
  };
  watchFile(filePath, { interval: 50 }, listener);
  setTimeout(() => writeFileSync(filePath, "HELLO FS"), 200);
});
assert(watchFileCount === 1, `watchFile fired unexpected count: ${watchFileCount}`);

const watchEvent = await new Promise<{ eventType: string; filename: string }>((resolve, reject) => {
  const timeout = setTimeout(() => {
    watcher.close();
    reject(new Error("watch timeout"));
  }, 3000);
  const watcher = watch(childDir, { interval: 50 }, (eventType, filename) => {
    clearTimeout(timeout);
    watcher.close();
    resolve({ eventType, filename: String(filename) });
  });
  setTimeout(() => writeFileSync(filePath, "HELLO FS!"), 200);
});
assert(watchEvent.eventType === "change", `watch event type mismatch: ${watchEvent.eventType}`);
assert(watchEvent.filename === "hello.txt", `watch filename mismatch: ${watchEvent.filename}`);

if (cottontail.platform() !== "win32") {
  symlinkSync(filePath, linkPath);
  assert(statSync(linkPath).isFile(), "statSync should follow symlinks");
  assert(!statSync(linkPath).isSymbolicLink(), "statSync should not report followed symlink as link");
  assert(lstatSync(linkPath).isSymbolicLink(), "lstatSync should report symlink");
}

console.log("node fs passed");
