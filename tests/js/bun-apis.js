import { Bun, Archive } from "../../src/runtime_modules/bun/index.js";
import { dlopen, FFIType } from "../../src/runtime_modules/bun/ffi.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tmpDir = cottontail.env("COTTONTAIL_TMP_DIR");
assert(tmpDir, "COTTONTAIL_TMP_DIR missing");
cottontail.mkdirSync(tmpDir, true);

assert(FFIType.int === "int", "FFIType.int should match Bun's int type name");

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

const streamProcess = Bun.spawn(["sh", "-c", "printf response-stream-ok"], {
  stdout: "pipe",
  stderr: "pipe",
});
const streamText = await new Response(streamProcess.stdout).text();
await streamProcess.exited;
assert(streamText === "response-stream-ok", `Response subprocess stream mismatch: ${JSON.stringify(streamText)}`);

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
