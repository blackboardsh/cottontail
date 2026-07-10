import {
  Buffer,
  INSPECT_MAX_BYTES,
  SlowBuffer,
  constants as bufferConstants,
  isAscii,
  isUtf8,
  kMaxLength,
  kStringMaxLength,
  resolveObjectURL,
  transcode,
} from "node:buffer";
import {
  availableParallelism,
  constants as osConstants,
  cpus,
  devNull,
  freemem,
  getPriority,
  loadavg,
  machine,
  networkInterfaces,
  release,
  totalmem,
  uptime,
  userInfo,
  version,
} from "node:os";
import {
  URLPattern,
  Url,
  domainToASCII,
  domainToUnicode,
  fileURLToPathBuffer,
  format,
  parse,
  resolve as resolveUrl,
  resolveObject,
  urlToHttpOptions,
} from "node:url";
import {
  clearLine,
  clearScreenDown,
  cursorTo,
  emitKeypressEvents,
  moveCursor,
} from "node:readline";
import { createInterface as createPromisesInterface } from "node:readline/promises";
import {
  ChildProcess,
  _forkChild,
  exec,
  execFile,
} from "node:child_process";
import {
  BlockList,
  Server,
  SocketAddress,
  Stream,
  _normalizeArgs,
  createServer,
  getDefaultAutoSelectFamily,
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamily,
  setDefaultAutoSelectFamilyAttemptTimeout,
} from "node:net";
import {
  Script,
  compileFunction,
  constants as vmConstants,
  createContext,
  createScript,
  isContext,
  measureMemory,
  runInContext,
  runInNewContext,
  runInThisContext,
} from "node:vm";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

assert(INSPECT_MAX_BYTES === 50, "buffer INSPECT_MAX_BYTES mismatch");
assert(bufferConstants.MAX_LENGTH === kMaxLength, "buffer constants MAX_LENGTH mismatch");
assert(bufferConstants.MAX_STRING_LENGTH === kStringMaxLength, "buffer constants MAX_STRING_LENGTH mismatch");
assert(SlowBuffer(2).length === 2, "SlowBuffer length mismatch");
assert(isAscii(Buffer.from("abc")), "isAscii true mismatch");
assert(!isAscii(new Uint8Array([0xff])), "isAscii false mismatch");
assert(isUtf8(Buffer.from("é")), "isUtf8 true mismatch");
assert(!isUtf8(new Uint8Array([0xff])), "isUtf8 false mismatch");
assert(transcode(Buffer.from("hi"), "utf8", "utf16le").length === 4, "transcode utf16 length mismatch");
assert(resolveObjectURL("blob:nothing") === undefined, "resolveObjectURL missing blob mismatch");
const objectUrlBlob = new Blob(["blob-ok"], { type: "text/plain" });
const objectUrl = URL.createObjectURL(objectUrlBlob);
assert(resolveObjectURL(objectUrl) === objectUrlBlob, "resolveObjectURL should return registered Blob");
URL.revokeObjectURL(objectUrl);
assert(resolveObjectURL(objectUrl) === undefined, "resolveObjectURL should return undefined after revoke");

assert(availableParallelism() >= 1, "availableParallelism mismatch");
const cpuList = cpus();
assert(cpuList.length >= 1, "cpus length mismatch");
assert(typeof cpuList[0].model === "string" && cpuList[0].model.length > 0, "cpus model mismatch");
assert(Number.isFinite(cpuList[0].speed), "cpus speed mismatch");
assert(Number.isFinite(cpuList[0].times.user) && Number.isFinite(cpuList[0].times.idle), "cpus times mismatch");
assert(typeof freemem() === "number", "freemem mismatch");
assert(typeof totalmem() === "number", "totalmem mismatch");
assert(loadavg().length === 3, "loadavg length mismatch");
assert(typeof machine() === "string" && machine().length > 0, "machine mismatch");
assert(typeof release() === "string", "release mismatch");
assert(typeof version() === "string", "version mismatch");
assert(typeof uptime() === "number" && uptime() >= 0, "uptime mismatch");
assert(typeof devNull === "string" && devNull.length > 0, "devNull mismatch");
assert(osConstants.signals.SIGTERM === 15, "os constants signals mismatch");
assert(typeof networkInterfaces() === "object", "networkInterfaces mismatch");
assert(typeof getPriority() === "number", "getPriority mismatch");
assert(typeof userInfo().homedir === "string", "userInfo mismatch");

const parsed = parse("http://user:pass@example.com:8080/p?q=1#h", true);
assert(parsed instanceof Url, "url parse should return Url");
assert(parsed.query.q === "1", "url parse query mismatch");
assert(format(parsed) === "http://user:pass@example.com:8080/p?q=1#h", "url format mismatch");
assert(resolveUrl("http://example.com/a/b", "../c") === "http://example.com/c", "url resolve mismatch");
assert(resolveObject("http://example.com/a/b", "../c").pathname === "/c", "url resolveObject mismatch");
assert(domainToASCII("mañana.com") === "xn--maana-pta.com", "domainToASCII mismatch");
assert(domainToUnicode("xn--maana-pta.com") === "mañana.com", "domainToUnicode mismatch");
assert(fileURLToPathBuffer("file:///tmp/cottontail").toString().endsWith("/tmp/cottontail"), "fileURLToPathBuffer mismatch");
assert(urlToHttpOptions(new URL("https://u:p@example.com/a?b=1")).auth === "u:p", "urlToHttpOptions auth mismatch");
assert(new URLPattern({ pathname: "/ok" }).test({ pathname: "/ok", baseURL: "http://example.com" }), "URLPattern test mismatch");
const routePattern = new URLPattern({ protocol: "https", hostname: "*.example.com", pathname: "/users/:id", search: "q=:query", hash: ":section" });
const routeMatch = routePattern.exec("https://api.example.com/users/42?q=search#intro");
assert(routeMatch?.hostname.groups["0"] === "api", "URLPattern hostname wildcard group mismatch");
assert(routeMatch?.pathname.groups.id === "42", "URLPattern pathname named group mismatch");
assert(routeMatch?.search.groups.query === "search", "URLPattern search named group mismatch");
assert(routeMatch?.hash.groups.section === "intro", "URLPattern hash named group mismatch");
const filePattern = new URLPattern({ pathname: "/files/*" });
assert(filePattern.exec({ pathname: "/files/a/b", baseURL: "http://example.com" })?.pathname.groups["0"] === "a/b", "URLPattern wildcard path mismatch");
assert(!new URLPattern({ pathname: "/users/:id" }).test({ pathname: "/users/a/b", baseURL: "http://example.com" }), "URLPattern segment group should not cross slashes");
const optionalPattern = new URLPattern({ protocol: "https", hostname: ":sub.example.com", pathname: "/:id(\\d+)?" });
const optionalMatch = optionalPattern.exec("https://api.example.com/123");
assert(optionalMatch?.hostname.groups.sub === "api", "URLPattern hostname named group mismatch");
assert(optionalMatch?.pathname.groups.id === "123", "URLPattern custom regex group mismatch");
assert(optionalPattern.test("https://api.example.com/"), "URLPattern optional regex group mismatch");
const repeatedPattern = new URLPattern({ pathname: "/books/:path+" });
assert(
  repeatedPattern.exec({ pathname: "/books/a/b", baseURL: "https://example.com" })?.pathname.groups.path === "a/b",
  "URLPattern plus modifier mismatch",
);

let control = "";
const controlStream = { write(text, callback) { control += text; callback?.(); } };
clearLine(controlStream as never, 0);
clearScreenDown(controlStream as never);
cursorTo(controlStream as never, 2, 3);
moveCursor(controlStream as never, -1, 1);
assert(control.includes("\x1b[2K") && control.includes("\x1b[0J"), "readline control sequence mismatch");

const keyStream = new EventEmitter();
let keyName = "";
keypressSetup:
{
  emitKeypressEvents(keyStream);
  keyStream.on("keypress", (_sequence, key) => { keyName = key.name; });
  keyStream.emit("data", "a");
  break keypressSetup;
}
assert(keyName === "a", "emitKeypressEvents mismatch");

let prompt = "";
const input = new PassThrough();
const output = new Writable({
  write(chunk, _encoding, callback) {
    prompt += String(chunk);
    callback();
  },
});
const rl = createPromisesInterface({ input, output, terminal: false });
const answer = rl.question("name?");
input.write("cottontail\n");
assert(await answer === "cottontail", "readline/promises question mismatch");
assert(prompt === "name?", "readline/promises prompt mismatch");
rl.close();

const shell = cottontail.platform() === "win32" ? "cmd" : "sh";
const shellArgs = cottontail.platform() === "win32" ? ["/d", "/s", "/c", "echo execfile-ok"] : ["-c", "printf execfile-ok"];
const execFileChild = execFile(shell, shellArgs, { encoding: "utf8" }, (error, stdout) => {
  if (error) throw error;
  assert(String(stdout).includes("execfile-ok"), "execFile stdout mismatch");
});
assert(execFileChild instanceof ChildProcess, "execFile ChildProcess mismatch");
await new Promise<void>((resolve) => execFileChild.on("close", () => resolve()));

const execCommand = cottontail.platform() === "win32" ? "echo exec-ok" : "printf exec-ok";
const execChild = exec(execCommand, { encoding: "utf8" }, (error, stdout) => {
  if (error) throw error;
  assert(String(stdout).includes("exec-ok"), "exec stdout mismatch");
});
assert(execChild instanceof ChildProcess, "exec ChildProcess mismatch");
await new Promise<void>((resolve) => execChild.on("close", () => resolve()));

_forkChild(0, "json");
assert(typeof process.send === "function", "_forkChild should install process.send");
process.disconnect?.();
let forkChildThrew = false;
try {
  _forkChild(0, "definitely-not-valid");
} catch {
  forkChildThrew = true;
}
assert(forkChildThrew, "_forkChild should validate serialization mode");

const context = createContext({ value: 2 });
assert(isContext(context), "vm isContext mismatch");
assert(runInContext("value += 3; value", context) === 5, "vm runInContext mismatch");
assert(runInNewContext("value + 1", { value: 4 }) === 5, "vm runInNewContext mismatch");
assert(runInThisContext("1 + 1") === 2, "vm runInThisContext mismatch");
assert(new Script("value * 2").runInContext(context) === 10, "vm Script runInContext mismatch");
assert(createScript("3 + 4").runInThisContext() === 7, "vm createScript mismatch");
assert(compileFunction("return a + b;", ["a", "b"])(2, 3) === 5, "vm compileFunction mismatch");
assert(typeof vmConstants.DONT_CONTEXTIFY === "symbol", "vm constants mismatch");
assert((await measureMemory()).total.jsMemoryEstimate >= 0, "vm measureMemory mismatch");

const blockList = new BlockList();
blockList.addAddress("10.0.0.1");
blockList.addRange("10.0.0.10", "10.0.0.20");
blockList.addSubnet("192.168.0.0", 16);
assert(blockList.check("10.0.0.1"), "BlockList address mismatch");
assert(blockList.check("10.0.0.12"), "BlockList range mismatch");
assert(blockList.check("192.168.1.5"), "BlockList subnet mismatch");
const socketAddress = new SocketAddress({ address: "127.0.0.1", port: 8080 });
assert(socketAddress.port === 8080, "SocketAddress port mismatch");
assert(SocketAddress.parse("127.0.0.1:80")?.address === "127.0.0.1", "SocketAddress parse mismatch");
assert(Stream.name === "Socket", "net Stream alias mismatch");
const server = createServer();
assert(server instanceof Server, "createServer Server mismatch");
await new Promise<void>((resolve) => {
  server.on("close", () => resolve());
  server.close();
});
const normalized = _normalizeArgs([1234, "localhost", () => {}]);
assert(normalized[0].port === 1234 && normalized[0].host === "localhost", "_normalizeArgs mismatch");
setDefaultAutoSelectFamily(true);
setDefaultAutoSelectFamilyAttemptTimeout(123);
assert(getDefaultAutoSelectFamily() === true, "autoSelectFamily mismatch");
assert(getDefaultAutoSelectFamilyAttemptTimeout() === 123, "autoSelectFamily timeout mismatch");

console.log("node small surface passed");
