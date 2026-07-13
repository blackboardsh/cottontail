import { Bun, Archive } from "bun";
import { dlopen, FFIType } from "bun:ffi";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tmpDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");
cottontail.mkdirSync(tmpDir, true);

assert(FFIType.int === "int", "FFIType.int should match Bun's int type name");
assert(JSON.stringify(Bun.$.braces("echo {one,{two,three}}")) === JSON.stringify(["echo one", "echo two", "echo three"]), "Bun.$.braces nested expansion mismatch");
assert(JSON.stringify(Bun.$.braces("echo plain")) === JSON.stringify(["echo plain"]), "Bun.$.braces no-op mismatch");
assert(new TextDecoder().decode(await Bun.$`printf shell-bytes`.bytes()) === "shell-bytes", "Bun shell bytes mismatch");
assert(await Bun.$`cat < ${new Blob(["shell-input"])}`.text() === "shell-input", "Bun shell Blob stdin mismatch");
assert(await Bun.$`printf pipeline-input | A=1 B=2 | cat`.text() === "pipeline-input", "Bun shell assignment pipeline mismatch");
Bun.$.throws(false);
const invalidSeq = await Bun.$`seq inf`.quiet();
assert(invalidSeq.exitCode === 1 && invalidSeq.stderr.toString().includes("invalid argument"), "Bun shell non-finite seq mismatch");
Bun.$.throws(true);

if (cottontail.platform() !== "win32") {
  const libcPath = cottontail.platform() === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
  const libc = dlopen(libcPath, {
    getpid: { args: [], returns: FFIType.int },
  });
  const libcString = dlopen(libcPath, {
    getpid: { args: [], returns: "int" },
  });
  assert(libc.symbols.getpid() === cottontail.pid(), "FFIType.int return mismatch");
  assert(libcString.symbols.getpid() === cottontail.pid(), "literal int FFI return mismatch");
}

const spawnResult = Bun.spawnSync(["sh", "-c", "printf spawn-ok"]);
assert(spawnResult.success, "Bun.spawnSync success mismatch");
assert(spawnResult.exitCode === 0, "Bun.spawnSync exitCode mismatch");
assert(spawnResult.stdout.toString() === "spawn-ok", "Bun.spawnSync stdout mismatch");
const oversizedCommand = ["echo", "ignored"];
Object.defineProperty(oversizedCommand, "length", { value: 0xffffffff });
for (const spawnFunction of [Bun.spawn, Bun.spawnSync]) {
  let rejected = false;
  try { spawnFunction(oversizedCommand); } catch (error) { rejected = /cmd array is too large/.test(error.message); }
  assert(rejected, "Bun spawn oversized command guard mismatch");
}

const streamProcess = Bun.spawn(["sh", "-c", "printf response-stream-ok"], {
  stdout: "pipe",
  stderr: "pipe",
});
const streamText = await new Response(streamProcess.stdout).text();
await streamProcess.exited;
assert(streamText === "response-stream-ok", `Response subprocess stream mismatch: ${JSON.stringify(streamText)}`);

const encodeDestination = new Uint8Array(5);
const encodeResult = new TextEncoder().encodeInto("A😋B", encodeDestination);
assert(encodeResult.read === 3 && encodeResult.written === 5, "TextEncoder.encodeInto scalar boundary mismatch");
const sinkPath = `${tmpDir}/file-sink.txt`;
const fileSink = Bun.file(sinkPath).writer();
assert(fileSink.write("one") === 3, "FileSink write byte count mismatch");
assert(fileSink.write("😋") === 4, "FileSink UTF-8 byte count mismatch");
await fileSink.flush();
assert(await fileSink.end() === 7, "FileSink end byte count mismatch");
assert(await Bun.file(sinkPath).text() === "one😋", "FileSink output mismatch");
const streamedChunks = [];
for await (const chunk of Bun.file(sinkPath).stream(3)) streamedChunks.push(chunk);
assert(new TextDecoder().decode(Buffer.concat(streamedChunks)) === "one😋", "Bun.file stream mismatch");
const multipart = new FormData();
multipart.append("message", "multipart-ok");
multipart.append("file", Bun.file(sinkPath), "file-sink.txt");
const multipartResponse = new Response(multipart);
assert(multipartResponse.headers.get("content-type").startsWith("multipart/form-data; boundary="), "FormData response content type mismatch");
const decodedMultipart = await multipartResponse.formData();
assert(decodedMultipart.get("message") === "multipart-ok", "FormData text roundtrip mismatch");
assert(await decodedMultipart.get("file").text() === "one😋", "FormData file roundtrip mismatch");
const missingUpload = fetch("http://example.com", {
  body: Bun.file(`${tmpDir}/missing-upload.txt`),
  method: "POST",
  proxy: "http://127.0.0.1:1",
});
assert(Bun.peek.status(missingUpload) === "rejected", "missing Bun.file fetch must reject immediately");
await missingUpload.catch((error) => assert(error.code === "ENOENT", "missing Bun.file fetch error code mismatch"));
const uuidv5Dns = Bun.randomUUIDv5("hello.example.com", "dns");
assert(uuidv5Dns === "fdda765f-fc57-5604-a269-52a7df8164ec", "Bun.randomUUIDv5 DNS vector mismatch");
assert(Bun.randomUUIDv5("http://example.com/hello", "url") === "3bbcee75-cecc-5b56-8031-b6641c1ed1f1", "Bun.randomUUIDv5 URL vector mismatch");
assert(Bun.randomUUIDv5(new TextEncoder().encode("hello.example.com"), "dns") === uuidv5Dns, "Bun.randomUUIDv5 BufferSource mismatch");
assert(Bun.randomUUIDv5("hello.example.com", "dns", "buffer").byteLength === 16, "Bun.randomUUIDv5 buffer encoding mismatch");
assert(typeof Bun.randomUUIDv5("hello.example.com", "dns", "base64url") === "string", "Bun.randomUUIDv5 base64url encoding mismatch");
assert(Bun.randomUUIDv5("hello.example.com", "DNS") === uuidv5Dns, "Bun.randomUUIDv5 namespace alias case mismatch");
const argonPassword = Bun.password.hashSync("cottontail", { algorithm: "argon2id", timeCost: 1, memoryCost: 8 });
assert(argonPassword.startsWith("$argon2id$"), "Bun.password argon2id format mismatch");
assert(Bun.password.verifySync("cottontail", argonPassword), "Bun.password argon2id verification mismatch");
assert(!Bun.password.verifySync("wrong", argonPassword), "Bun.password argon2id rejection mismatch");
const bcryptPassword = Bun.password.hashSync("cottontail", { algorithm: "bcrypt", cost: 4 });
assert(bcryptPassword.startsWith("$2b$04$"), "Bun.password bcrypt format mismatch");
assert(await Bun.password.verify("cottontail", bcryptPassword), "Bun.password bcrypt verification mismatch");
const zstdInput = new TextEncoder().encode("cottontail zstd ".repeat(32));
const zstdCompressed = Bun.zstdCompressSync(zstdInput, { level: 3 });
assert(new TextDecoder().decode(Bun.zstdDecompressSync(zstdCompressed)) === new TextDecoder().decode(zstdInput), "Bun zstd sync roundtrip mismatch");
assert(new TextDecoder().decode(await Bun.zstdDecompress(await Bun.zstdCompress(zstdInput, { level: 7 }))) === new TextDecoder().decode(zstdInput), "Bun zstd promise roundtrip mismatch");
assert(Bun.wrapAnsi("hello world", 5) === "hello\nworld", "Bun.wrapAnsi word wrapping mismatch");
assert(Bun.wrapAnsi("aあbい", 3, { hard: true }) === "aあ\nbい", "Bun.wrapAnsi Unicode width mismatch");
assert(Bun.wrapAnsi("\x1b[31mhello world\x1b[0m", 5).includes("\x1b[39m\n\x1b[31m"), "Bun.wrapAnsi color continuation mismatch");
assert(Bun.hash("hello world") === 0x668d5e431c3b2573n, "Bun.hash Wyhash mismatch");
assert(Bun.hash.crc32("hello world") === 0x0d4a1185, "Bun.hash CRC-32 mismatch");
assert(Bun.hash.xxHash64("", 16269921104521594740n) === 3224619365169652240n, "Bun.hash 64-bit seed mismatch");
assert(Bun.markdown.html("## Hello **World**\n", { headings: { ids: true } }) === '<h2 id="hello-world">Hello <strong>World</strong></h2>\n', "Bun.markdown.html mismatch");
assert(Bun.markdown.render("# Hello **world**\n", {
  heading: (children, { level }) => `<h${level}>${children}</h${level}>`,
  strong: (children) => `<b>${children}</b>`,
}) === "<h1>Hello <b>world</b></h1>", "Bun.markdown.render mismatch");
const markdownReact = Bun.markdown.react("[click](https://example.com)\n", undefined, { reactVersion: 18 });
assert(markdownReact.$$typeof === Symbol.for("react.element"), "Bun.markdown.react fragment symbol mismatch");
assert(markdownReact.props.children[0].props.children[0].props.href === "https://example.com", "Bun.markdown.react link props mismatch");
if (cottontail.platform() !== "win32") {
  const mmapPath = `${tmpDir}/mmap.bin`;
  cottontail.writeFile(mmapPath, "mapped");
  const sharedMapA = Bun.mmap(mmapPath);
  const sharedMapB = Bun.mmap(mmapPath);
  sharedMapA[0] = "M".charCodeAt(0);
  assert(sharedMapB[0] === "M".charCodeAt(0), "Bun.mmap shared mapping mismatch");
  const privateMap = Bun.mmap(mmapPath, { shared: false });
  privateMap[1] = "X".charCodeAt(0);
  assert(sharedMapB[1] === "a".charCodeAt(0), "Bun.mmap private mapping leaked a write");
}

let udpResolve;
const udpReceived = new Promise((resolve) => { udpResolve = resolve; });
const udpServer = await Bun.udpSocket({
  binaryType: "uint8array",
  socket: {
    data(_socket, data) { udpResolve(new TextDecoder().decode(data)); },
  },
});
const udpClient = await Bun.udpSocket({});
assert(udpClient.sendMany(["udp-ok", udpServer.port, "127.0.0.1"]) === 1, "Bun.udpSocket sendMany mismatch");
assert(await Promise.race([udpReceived, Bun.sleep(1000).then(() => "timeout")]) === "udp-ok", "Bun.udpSocket loopback mismatch");
udpClient.close();
udpServer.close();

console.log({ cottontailConsoleObject: true, nested: { ok: true } });

const archiveSource = `${tmpDir}/archive-source`;
const archiveOut = `${tmpDir}/archive-out`;
const archivePath = `${tmpDir}/sample.tar`;
cottontail.mkdirSync(archiveSource, true);
cottontail.mkdirSync(archiveOut, true);
cottontail.writeFile(`${archiveSource}/hello.txt`, "archive hello");

let tarResult = cottontail.spawnSync("tar", ["-cf", archivePath, "-C", archiveSource, "hello.txt"], { stdio: "pipe" });
assert(tarResult.status === 0, `tar create failed: ${tarResult.stderr}`);

const archive = new Archive(cottontail.readFileBuffer(archivePath));
const files = await archive.files();
assert(files.has("hello.txt"), "Archive.files missing hello.txt");
assert(await files.get("hello.txt").text() === "archive hello", "Archive file text mismatch");
await archive.extract(archiveOut);
assert(cottontail.readFile(`${archiveOut}/hello.txt`) === "archive hello", "Archive.extract mismatch");

const canTestSecrets = cottontail.platform() === "darwin" ||
  (cottontail.platform() === "linux" && cottontail.spawnSync("sh", ["-c", "command -v secret-tool"], { stdio: "pipe" }).status === 0);
if (canTestSecrets) {
  const service = `cottontail-local-test-${Date.now()}`;
  const name = "roundtrip";
  try {
    await Bun.secrets.set({ service, name, value: "密码🔒\n\t" });
    assert(await Bun.secrets.get({ service, name }) === "密码🔒\n\t", "Bun.secrets roundtrip mismatch");
    assert(await Bun.secrets.delete({ service, name }) === true, "Bun.secrets delete mismatch");
    assert(await Bun.secrets.get({ service, name }) === null, "Bun.secrets missing credential mismatch");
  } finally {
    await Bun.secrets.delete({ service, name });
  }
}

if (cottontail.platform() !== "win32") {
  const curlCheck = cottontail.spawnSync("curl", ["--version"], { stdio: "pipe" });
  if (curlCheck.status === 0) {
    const serveOut = `${tmpDir}/serve-out.txt`;
    if (cottontail.existsSync(serveOut)) cottontail.unlinkSync(serveOut);

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = request.url.replace(/^https?:\/\/[^/]+/, "");
        return new Response(`served ${pathname}`, {
          headers: { "content-type": "text/plain" },
        });
      },
    });

    Bun.spawn(["sh", "-c", `curl -s ${server.url}/hello > ${serveOut}`], {
      detached: true,
    });

    let body = "";
    for (let i = 0; i < 2000; i += 1) {
      globalThis.__cottontailRunLoopTick();
      if (cottontail.existsSync(serveOut)) {
        body = cottontail.readFile(serveOut);
        if (body.length > 0) break;
      }
      cottontail.sleep(1);
    }

    server.stop();
    assert(body === "served /hello", `Bun.serve response mismatch: ${JSON.stringify(body)}`);
  }
}

console.log("bun apis passed");
